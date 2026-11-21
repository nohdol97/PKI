// V01-C7 `module-boundary`: an upper module must not reach into another
// workspace package except through its declared public entry (T01), and must not
// reach an adapter implementation module, even inside its own package, except
// from the composition root (T07).
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

  it("fails when a public entry re-exports an adapter implementation", async () => {
    const messages = await lintWithRepoConfig(
      'export { EmptyVectorIndex } from "./adapters/empty-vector-index.ts";\n',
      "storage/src/index.ts",
    );
    expect(messages.map((m) => m.messageId)).toEqual(["adapterImport"]);
  });

  it("fails when an upper module imports an adapter implementation of its own package", async () => {
    const messages = await lintWithRepoConfig(
      'import { createFixtureConnector } from "./adapters/fixture-connector.ts";\nexport { createFixtureConnector };\n',
      "backend/src/server.ts",
    );
    expect(messages.map((m) => m.messageId)).toEqual(["adapterImport"]);
  });

  it("fails when a module other than the composition root imports an adapters entry", async () => {
    const messages = await lintWithRepoConfig(
      'import { EmptyVectorIndex } from "@pki/storage/adapters";\nexport { EmptyVectorIndex };\n',
      "backend/src/connectors.ts",
    );
    expect(messages.map((m) => m.messageId)).toEqual(["adapterEntry"]);
  });

  it("allows the composition root to pick adapter implementations", async () => {
    const messages = await lintWithRepoConfig(
      'import { EmptyVectorIndex } from "@pki/storage/adapters";\nimport { createFixtureConnector } from "./adapters/fixture-connector.ts";\nexport { EmptyVectorIndex, createFixtureConnector };\n',
      "backend/src/composition.ts",
    );
    expect(messages).toEqual([]);
  });

  it("keeps the fake Provider out of product code, the composition root included", async () => {
    for (const file of ["backend/src/composition.ts", "providers/src/broker.ts"]) {
      const messages = await lintWithRepoConfig(
        'import { FakeProvider } from "@pki/testkit";\nexport { FakeProvider };\n',
        file,
      );
      expect(
        messages.map((m) => m.messageId),
        file,
      ).toEqual([expect.stringMatching(/^(devOnlyDependency|undeclaredDependency)$/)]);
    }
  });

  it("finds no boundary violation in the repository's own code", async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const results = await eslint.lintFiles([
      "apps",
      "backend",
      "knowledge-engine",
      "packages",
      "providers",
      "storage",
    ]);
    const violations = results.flatMap((r) =>
      r.messages
        .filter((m) => m.ruleId === RULE_ID)
        .map((m) => `${r.filePath.slice(repoRoot.length + 1)}: ${m.message}`),
    );
    expect(results.length).toBeGreaterThan(20);
    expect(violations).toEqual([]);
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
pkg("storage", { name: "@pki/storage" });
pkg("packages/testkit", { name: "@pki/testkit" });
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

const backendFile = join(fixtureRoot, "backend/src/server.ts");
const backendTest = join(fixtureRoot, "backend/src/server.test.ts");
const backendE2e = join(fixtureRoot, "backend/src/screens.e2e.tsx");
const composition = join(fixtureRoot, "backend/src/composition.ts");
const storageIndex = join(fixtureRoot, "storage/src/index.ts");
const storageAdapter = join(fixtureRoot, "storage/src/adapters/driver.ts");
const storageAdapterTest = join(fixtureRoot, "storage/src/adapters/driver.test.ts");
const storageModule = join(fixtureRoot, "storage/src/sources.ts");
const testkitDouble = join(fixtureRoot, "packages/testkit/src/memory-index.ts");
RuleTester.describe = describe;
RuleTester.it = it;
const ruleTester = new RuleTester({ languageOptions: { parser: tseslint.parser } });

describe("module-boundary rule", () => {
  ruleTester.run("module-boundary", moduleBoundary, {
    valid: [
      { code: 'import { a } from "@pki/contracts";', filename: backendFile },
      // devDependencies-only workspace packages (test code) are reachable from test files only
      { code: 'import { send } from "@pki/testkit";', filename: backendTest },
      { code: 'import type { T } from "@pki/testkit";', filename: backendE2e },
      { code: 'import { b } from "../src/other.ts";', filename: backendFile },
      { code: 'import { readFile } from "node:fs/promises";', filename: backendFile },
      { code: 'import { describe } from "vitest";', filename: backendFile },
      // the composition root picks implementations, in its own package and through adapters entries
      { code: 'import { f } from "./adapters/fixture.ts";', filename: composition },
      { code: 'import { E } from "@pki/contracts/adapters";', filename: composition },
      // implementations may use each other; tests may reach the implementation they test
      { code: 'import { x } from "./other.ts";', filename: storageAdapter },
      { code: 'import { open } from "./driver.ts";', filename: storageAdapterTest },
      { code: 'import { open } from "./adapters/driver.ts";', filename: backendTest },
      { code: 'import { E } from "@pki/contracts/adapters";', filename: backendTest },
      // implementations live under src/adapters/; the port and test doubles may name the interface
      { code: "export class D implements SqlDriver {}", filename: storageAdapter },
      { code: "export class M implements VectorIndex {}", filename: testkitDouble },
      { code: "export function open(): SqlDriver { return d; }", filename: composition },
      { code: "export function sync(c: Connector): number { return 1; }", filename: storageModule },
      { code: "export type Factory = () => Connector;", filename: storageModule },
    ],
    invalid: [
      {
        code: 'import { send } from "@pki/testkit";',
        filename: backendFile,
        errors: [{ messageId: "devOnlyDependency" }],
      },
      {
        code: 'export type { T } from "@pki/testkit";',
        filename: backendFile,
        errors: [{ messageId: "devOnlyDependency" }],
      },
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
        code: "const m = await import(`../../packages/contracts/src/schema.ts`);",
        filename: backendFile,
        errors: [{ messageId: "crossPackageRelative" }],
      },
      {
        code: 'type M = typeof import("@pki/contracts/src/schema.ts");',
        filename: backendFile,
        errors: [{ messageId: "deepImport" }],
      },
      {
        code: 'export * from "@pki/storage";',
        filename: backendFile,
        errors: [{ messageId: "undeclaredDependency" }],
      },
      // implementation boundary inside a package (T07): every import form, re-exports included
      ...[
        'import { open } from "./adapters/driver.ts";',
        'import type { D } from "./adapters/driver.ts";',
        'export { open } from "./adapters/driver.ts";',
        'export * from "./adapters/index.ts";',
        'export * from "./adapters";',
        "const m = await import(`./adapters/driver.ts`);",
        'type M = typeof import("./adapters/driver.ts");',
      ].map((code) => ({ code, filename: storageIndex, errors: [{ messageId: "adapterImport" }] })),
      {
        code: 'import { open } from "../adapters/driver.ts";',
        filename: join(fixtureRoot, "storage/src/sub/reader.ts"),
        errors: [{ messageId: "adapterImport" }],
      },
      {
        code: 'import { f } from "./adapters/fixture.ts";',
        filename: backendFile,
        errors: [{ messageId: "adapterImport" }],
      },
      {
        code: 'import { E } from "@pki/contracts/adapters";',
        filename: backendFile,
        errors: [{ messageId: "adapterEntry" }],
      },
      {
        code: 'export { E } from "@pki/contracts/adapters";',
        filename: join(fixtureRoot, "backend/src/index.ts"),
        errors: [{ messageId: "adapterEntry" }],
      },
      // the composition root still needs the package as a declared dependency
      {
        code: 'import { open } from "@pki/storage/adapters";',
        filename: composition,
        errors: [{ messageId: "undeclaredDependency" }],
      },
      // a composition.ts in any other package is not the composition root
      {
        code: 'import { open } from "./adapters/driver.ts";',
        filename: join(fixtureRoot, "storage/src/composition.ts"),
        errors: [{ messageId: "adapterImport" }],
      },
      // an implementation outside src/adapters/ would escape the boundary
      ...[
        "export class D implements SqlDriver {}",
        "export const C = class implements Connector {};",
        "export function open(): SqlDriver { return d; }",
        "export const open = (): VectorIndex => v;",
        "export const open: OpenSqlDriver = (p) => d(p);",
        "export const c = { manifest } satisfies Connector;",
        "export const p: LLMProvider = make();",
      ].map((code) => ({
        code,
        filename: storageModule,
        errors: [{ messageId: "adapterOutsideAdapters" }],
      })),
    ],
  });
});
