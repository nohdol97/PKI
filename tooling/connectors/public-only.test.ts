// I01-C4 `connectors.public-only` ②~⑤ (I01-R28): the public repository's Connector
// paths import only what the allow-list names and touch no network global; the
// four mutations each turn the check red; site/ is checked only as a list of
// placeholder files. Every mutation is written into a copy of the inspected paths
// under the OS temp directory, never into the repository tree. The kinds check ①
// is backend/src/connectors.public-only.test.ts (I01 spec "T09가 넘기는 것").
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkPlaceholders,
  checkPublicOnly,
  EXTRA_FILES,
  inspectedFiles,
  SCAN_ROOTS,
  SITE_PLACEHOLDERS,
} from "./public-only.ts";

const REPO = resolve(import.meta.dirname, "../..");
const ADAPTERS = "backend/src/adapters";

const copies: string[] = [];
afterEach(() => {
  for (const dir of copies.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A copy of what the check reads (the roots that exist, the extra files, site/) in the OS temp directory. */
function copyOfRepo(): string {
  const copy = mkdtempSync(join(tmpdir(), "pki-public-only-"));
  copies.push(copy);
  for (const path of [...SCAN_ROOTS, ...EXTRA_FILES, "site"]) {
    if (existsSync(join(REPO, path)))
      cpSync(join(REPO, path), join(copy, path), { recursive: true });
  }
  return copy;
}

function write(copy: string, path: string, text: string): void {
  expect(copy.startsWith(tmpdir())).toBe(true);
  mkdirSync(dirname(join(copy, path)), { recursive: true });
  writeFileSync(join(copy, path), text);
}

/** The findings after adding one file to a fresh copy. */
function withFile(path: string, text: string) {
  const copy = copyOfRepo();
  write(copy, path, text);
  return checkPublicOnly(copy);
}

describe("the repository's Connector paths", () => {
  it("import only what the allow-list names and use no network global", () => {
    expect(checkPublicOnly(REPO)).toEqual([]);
  });

  it("the check is live: it read the public Connectors and the extra file", () => {
    const files = inspectedFiles(REPO);
    for (const file of [
      `${ADAPTERS}/site-connectors.ts`,
      `${ADAPTERS}/jsonl-connector.ts`,
      `${ADAPTERS}/jsonl-connector.test.ts`,
      `${ADAPTERS}/fixture-connector.ts`,
      "backend/src/jsonl-lines.ts",
    ]) {
      expect(files).toContain(file);
    }
  });

  it("the temporary copy passes as the repository does", () => {
    const copy = copyOfRepo();
    expect(inspectedFiles(copy)).toEqual(inspectedFiles(REPO));
    expect(checkPublicOnly(copy)).toEqual([]);
  });
});

describe("the four mutations (I01-C4 ③)", () => {
  const MUTANT = `${ADAPTERS}/mutant.ts`;

  it("a static import of a package outside the allow-list", () => {
    expect(
      withFile(
        MUTANT,
        `// a mail SDK\nimport { ImapFlow } from "imapflow";\nexport { ImapFlow };\n`,
      ),
    ).toEqual([{ file: MUTANT, line: 2, code: "import-not-allowed", detail: "imapflow" }]);
  });

  it("a dynamic import()", () => {
    expect(withFile(MUTANT, `export const load = () =>\n  import("@pki/contracts");\n`)).toEqual([
      { file: MUTANT, line: 2, code: "dynamic-import", detail: "import()" },
    ]);
  });

  it("require", () => {
    expect(
      withFile(`${ADAPTERS}/mutant.cjs`, `\n\nconst contracts = require("@pki/contracts");\n`),
    ).toEqual([{ file: `${ADAPTERS}/mutant.cjs`, line: 3, code: "require", detail: "require" }]);
  });

  it("the global fetch", () => {
    expect(withFile(MUTANT, `export const get = (url: string) => fetch(url);\n`)).toEqual([
      { file: MUTANT, line: 1, code: "network-global", detail: "fetch" },
    ]);
  });
});

describe("the import allow-list", () => {
  const FILE = `${ADAPTERS}/extra.ts`;
  const codes = (path: string, text: string) =>
    withFile(path, text).map((f) => `${f.code}:${f.detail}`);

  it("allows the listed packages, node modules and paths inside the same root", () => {
    expect(
      codes(
        `${ADAPTERS}/nested/extra.ts`,
        [
          `import type { Connector } from "@pki/contracts";`,
          `import { parse } from "@pki/connector-sdk";`,
          `import { z } from "zod";`,
          `import { createHash } from "node:crypto";`,
          `import { readFileSync } from "node:fs";`,
          `import { readFile } from "node:fs/promises";`,
          `import { join } from "node:path";`,
          `import { createSiteConnector } from "../site-connectors.ts";`,
          `export * from "../site-connectors.ts";`,
          `export const here = import.meta.dirname;`,
          `// fetch, require and import("x") in a comment are text`,
          `export const text = "fetch require WebSocket import('x')";`,
          `export type Used = [Connector, typeof parse, typeof z, typeof createHash, typeof readFileSync, typeof readFile, typeof join, typeof createSiteConnector];`,
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it.each([
    "node:http",
    "node:https",
    "node:net",
    "node:child_process",
    "node:module",
    "crypto",
    "fs",
    "@pki/contracts/internal",
    "@pki/storage",
    "@pki/providers",
    "undici",
    "/absolute/client.ts",
  ])("refuses %s", (specifier) => {
    expect(codes(FILE, `import * as x from "${specifier}";\nexport { x };\n`)).toEqual([
      `import-not-allowed:${specifier}`,
    ]);
  });

  it("refuses a type-only import, a re-export and an import-equals outside the list", () => {
    expect(
      codes(FILE, `import type { Client } from "imapflow";\nexport type C = Client;\n`),
    ).toEqual(["import-not-allowed:imapflow"]);
    expect(codes(FILE, `export * from "imapflow";\n`)).toEqual(["import-not-allowed:imapflow"]);
    expect(codes(FILE, `export { ImapFlow } from "imapflow";\n`)).toEqual([
      "import-not-allowed:imapflow",
    ]);
    expect(codes(FILE, `import sdk = require("imapflow");\nexport { sdk };\n`)).toEqual([
      "import-not-allowed:imapflow",
      "require:require",
    ]);
    expect(codes(FILE, `import "imapflow";\n`)).toEqual(["import-not-allowed:imapflow"]);
  });

  it("allows @pki/testkit and vitest in test files only", () => {
    const text = `import { checkConnector } from "@pki/testkit";\nimport { it } from "vitest";\nit("x", () => void checkConnector);\n`;
    expect(codes(`${ADAPTERS}/extra.test.ts`, text)).toEqual([]);
    expect(codes(`${ADAPTERS}/extra.test.tsx`, text)).toEqual([]);
    expect(codes(FILE, text)).toEqual([
      "import-not-allowed:@pki/testkit",
      "import-not-allowed:vitest",
    ]);
    // a name that only looks like a test file
    expect(codes(`${ADAPTERS}/test.ts`, text)).toHaveLength(2);
    expect(codes(`${ADAPTERS}/extra.test.js`, text)).toHaveLength(2);
  });

  it("refuses a relative path that leaves the root, the extra file aside", () => {
    expect(codes(FILE, `export * from "../server.ts";\n`)).toEqual([
      "import-not-allowed:../server.ts",
    ]);
    expect(codes(FILE, `export * from "../../../packages/testkit/src/index.ts";\n`)).toEqual([
      "import-not-allowed:../../../packages/testkit/src/index.ts",
    ]);
    expect(codes(FILE, `export * from "./nested/../../connectors.ts";\n`)).toEqual([
      "import-not-allowed:./nested/../../connectors.ts",
    ]);
    expect(codes(FILE, `export * from "../jsonl-lines.ts";\n`)).toEqual([]);
    // the extra file is not a root: it may not reach its neighbours
    expect(codes("backend/src/jsonl-lines.ts", `export * from "./server.ts";\n`)).toContain(
      "import-not-allowed:./server.ts",
    );
  });

  it("refuses a type-position import()", () => {
    expect(codes(FILE, `export type C = import("@pki/contracts").Connector;\n`)).toEqual([
      "dynamic-import:import()",
    ]);
  });

  it.each(["fetch", "XMLHttpRequest", "WebSocket"])("refuses %s wherever it is named", (name) => {
    expect(codes(FILE, `export const a = new ${name}("https://synthetic.invalid");\n`)).toEqual([
      `network-global:${name}`,
    ]);
    expect(codes(FILE, `export const a = globalThis.${name};\n`)).toEqual([
      `network-global:${name}`,
    ]);
    expect(codes(FILE, `export const a = (globalThis as any)["${name}"];\n`)).toEqual([
      `network-global:${name}`,
    ]);
    expect(codes(FILE, `export const a = (globalThis as any)[\`${name}\`];\n`)).toEqual([
      `network-global:${name}`,
    ]);
    expect(codes(FILE, `export const { ${name}: a } = globalThis as any;\n`)).toEqual([
      `network-global:${name}`,
    ]);
  });

  it("refuses require under another name or as a property", () => {
    expect(
      codes(FILE, `declare const require: (id: string) => unknown;\nexport const r = require;\n`),
    ).toEqual(["require:require", "require:require"]);
    expect(codes(FILE, `export const r = (module as any)["require"];\n`)).toEqual([
      "require:require",
    ]);
  });

  it.each([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"])(
    "reads %s files, in nested folders too",
    (extension) => {
      const path = `${ADAPTERS}/deep/er/client${extension}`;
      expect(
        withFile(path, `export const get = () => fetch("https://synthetic.invalid");\n`),
      ).toEqual([{ file: path, line: 1, code: "network-global", detail: "fetch" }]);
    },
  );

  it("does not read files that are not scripts", () => {
    expect(codes(`${ADAPTERS}/notes.md`, `fetch("x"); require("y");\n`)).toEqual([]);
    expect(codes(`${ADAPTERS}/data.json`, `{"fetch": "require"}\n`)).toEqual([]);
  });

  it("reads the extra file under the same list", () => {
    const copy = copyOfRepo();
    write(
      copy,
      "backend/src/jsonl-lines.ts",
      `export const get = () => fetch("https://synthetic.invalid");\n`,
    );
    expect(checkPublicOnly(copy)).toEqual([
      { file: "backend/src/jsonl-lines.ts", line: 1, code: "network-global", detail: "fetch" },
    ]);
  });

  it("fails once nothing inspected reads the extra file: the entry is to be removed (I01-T05)", () => {
    const copy = copyOfRepo();
    rmSync(join(copy, ADAPTERS), { recursive: true });
    write(copy, `${ADAPTERS}/only.ts`, `export const one = 1;\n`);
    expect(checkPublicOnly(copy)).toEqual([
      { file: "backend/src/jsonl-lines.ts", line: 1, code: "unused-extra-file", detail: "" },
    ]);
    rmSync(join(copy, "backend/src/jsonl-lines.ts"));
    expect(checkPublicOnly(copy)).toEqual([
      { file: "backend/src/jsonl-lines.ts", line: 1, code: "unused-extra-file", detail: "" },
    ]);
  });
});

describe("the inspected roots", () => {
  it("backend/src/adapters must exist and hold a script", () => {
    const copy = copyOfRepo();
    rmSync(join(copy, ADAPTERS), { recursive: true });
    expect(checkPublicOnly(copy).map((f) => `${f.file}:${f.code}`)).toContain(
      `${ADAPTERS}:missing-root`,
    );
    write(copy, `${ADAPTERS}/notes.md`, "no script here\n");
    expect(checkPublicOnly(copy).map((f) => `${f.file}:${f.code}`)).toContain(
      `${ADAPTERS}:missing-root`,
    );
  });

  it.each(["packages/connector-example", "packages/connector-sdk"])(
    "%s is read as soon as the package exists, and then needs its src/",
    (pkg) => {
      const copy = copyOfRepo();
      rmSync(join(copy, pkg), { recursive: true, force: true });
      expect(checkPublicOnly(copy)).toEqual([]);
      write(copy, `${pkg}/package.json`, "{}\n");
      expect(checkPublicOnly(copy)).toEqual([
        { file: `${pkg}/src`, line: 1, code: "missing-root", detail: "" },
      ]);
      write(copy, `${pkg}/src/index.ts`, `export const one = 1;\n`);
      expect(checkPublicOnly(copy)).toEqual([]);
      write(copy, `${pkg}/src/adapters/client.ts`, `import "node:https";\n`);
      expect(checkPublicOnly(copy)).toEqual([
        {
          file: `${pkg}/src/adapters/client.ts`,
          line: 1,
          code: "import-not-allowed",
          detail: "node:https",
        },
      ]);
      // outside src/ (configuration, build output) is not a Connector path
      write(copy, `${pkg}/vitest.config.ts`, `import "vitest/config";\n`);
      expect(checkPublicOnly(copy)).toHaveLength(1);
    },
  );
});

describe("site/ (I01-C4 ④, ⑤)", () => {
  it("the placeholder list is site/README.md", () => {
    expect(SITE_PLACEHOLDERS).toEqual(["site/README.md"]);
    expect(checkPlaceholders(REPO)).toEqual([]);
  });

  it("a fork's real collector under site/connectors/ is not inspected", () => {
    const copy = copyOfRepo();
    write(
      copy,
      "site/connectors/site-mail.ts",
      `import { ImapFlow } from "imapflow";\nconst https = require("node:https");\nexport const get = () => [fetch("https://synthetic.invalid"), ImapFlow, https, import("ws")];\n`,
    );
    write(copy, "site/config/connector-scopes.json", "{}\n");
    expect(checkPublicOnly(copy)).toEqual([]);
    // the same file in a public path is refused: the pass above is the path, not the content
    write(
      copy,
      `${ADAPTERS}/site-mail.ts`,
      `export const get = () => fetch("https://synthetic.invalid");\n`,
    );
    expect(checkPublicOnly(copy)).toHaveLength(1);
  });

  it("a listed placeholder must exist as a file", () => {
    const copy = copyOfRepo();
    rmSync(join(copy, "site/README.md"));
    const missing = [{ file: "site/README.md", line: 1, code: "placeholder-missing", detail: "" }];
    expect(checkPublicOnly(copy)).toEqual(missing);
    mkdirSync(join(copy, "site/README.md"));
    expect(checkPublicOnly(copy)).toEqual(missing);
    rmSync(join(copy, "site"), { recursive: true });
    expect(checkPublicOnly(copy)).toEqual(missing);
  });

  it("a listed placeholder must not be a script", () => {
    const copy = copyOfRepo();
    write(copy, "site/README.md", "#!/usr/bin/env node\nfetch('https://synthetic.invalid');\n");
    expect(checkPublicOnly(copy)).toEqual([
      { file: "site/README.md", line: 1, code: "placeholder-is-script", detail: "#!" },
    ]);
    write(copy, "site/index.mjs", "export {};\n");
    write(copy, "site/notes.txt", "synthetic\n");
    expect(checkPlaceholders(copy, ["site/index.mjs", "site/notes.txt"])).toEqual([
      { file: "site/index.mjs", line: 1, code: "placeholder-is-script", detail: ".mjs" },
    ]);
  });
});
