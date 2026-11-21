// V01-C7 `module-boundary`: an upper module must not reach into another
// workspace package except through its declared public entry.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ESLint, RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { afterAll, describe, expect, it } from "vitest";
import moduleBoundary from "./module-boundary.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const RULE_ID = "pki/module-boundary";

async function lintWithRepoConfig(code: string, filePath: string) {
  const eslint = new ESLint({ cwd: repoRoot });
  const [result] = await eslint.lintText(code, { filePath: join(repoRoot, filePath) });
  return (result?.messages ?? []).filter((m) => m.ruleId === RULE_ID);
}

describe("repository lint config enforces module-boundary", () => {
  it("fails on a relative import into another package", async () => {
    const messages = await lintWithRepoConfig(
      'import { x } from "../../providers/src/index.ts";\nexport { x };\n',
      "backend/src/index.ts",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.severity).toBe(2);
  });

  it("fails on a deep import past a package's public entry", async () => {
    const messages = await lintWithRepoConfig(
      'export { x } from "@pki/providers/src/index.ts";\n',
      "backend/src/index.ts",
    );
    expect(messages).toHaveLength(1);
  });

  it("fails on importing a workspace package that is not a declared dependency", async () => {
    const messages = await lintWithRepoConfig(
      'const m = await import("@pki/providers");\nexport { m };\n',
      "backend/src/index.ts",
    );
    expect(messages).toHaveLength(1);
  });

  it("allows imports inside the same package and of platform modules", async () => {
    const messages = await lintWithRepoConfig(
      'import { join } from "node:path";\nimport { y } from "./y.ts";\nexport { join, y };\n',
      "backend/src/index.ts",
    );
    expect(messages).toEqual([]);
  });
});

// Rule-level cases on a throwaway workspace so the "declared dependency"
// path can be exercised without adding speculative dependencies to the repo.
const fixtureRoot = mkdtempSync(join(tmpdir(), "pki-boundary-"));
function pkg(dir: string, manifest: object) {
  mkdirSync(join(fixtureRoot, dir, "src"), { recursive: true });
  writeFileSync(join(fixtureRoot, dir, "package.json"), JSON.stringify(manifest));
}
pkg(".", { name: "root" });
pkg("backend", {
  name: "@pki/backend",
  dependencies: { "@pki/contracts": "workspace:*" },
  devDependencies: { "@pki/testkit": "workspace:*" },
});
pkg("packages/contracts", { name: "@pki/contracts" });
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

const backendFile = join(fixtureRoot, "backend/src/server.ts");
RuleTester.describe = describe;
RuleTester.it = it;
const ruleTester = new RuleTester({ languageOptions: { parser: tseslint.parser } });

describe("module-boundary rule", () => {
  ruleTester.run("module-boundary", moduleBoundary, {
    valid: [
      { code: 'import { a } from "@pki/contracts";', filename: backendFile },
      { code: 'import type { T } from "@pki/testkit";', filename: backendFile },
      { code: 'import { b } from "../src/other.ts";', filename: backendFile },
      { code: 'import { readFile } from "node:fs/promises";', filename: backendFile },
      { code: 'import { describe } from "vitest";', filename: backendFile },
    ],
    invalid: [
      {
        code: 'import { a } from "../../packages/contracts/src/schema.ts";',
        filename: backendFile,
        errors: [{ messageId: "crossPackageRelative" }],
      },
      {
        code: 'import { a } from "@pki/contracts/src/schema.ts";',
        filename: backendFile,
        errors: [{ messageId: "deepImport" }],
      },
      {
        code: 'export * from "@pki/storage";',
        filename: backendFile,
        errors: [{ messageId: "undeclaredDependency" }],
      },
    ],
  });
});
