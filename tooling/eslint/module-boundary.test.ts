// V01-C7 `module-boundary`: an upper module must not reach into another
// workspace package except through its declared public entry (T01), and must not
// reach an adapter implementation module, even inside its own package, except
// from the composition root (T07).
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
      'const m = await import("@pki/knowledge-engine");\nexport { m };\n',
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

  it("lists @pki/testkit as a runtime dependency of no package", () => {
    const manifests = ["apps", "packages"]
      .flatMap((group) => readdirSync(join(repoRoot, group)).map((d) => join(group, d)))
      .concat(["backend", "knowledge-engine", "providers", "storage"])
      .map((dir) => join(repoRoot, dir, "package.json"))
      .filter((file) => existsSync(file))
      .map((file) => JSON.parse(readFileSync(file, "utf8")));
    expect(manifests.map((m) => m.name)).toEqual(
      expect.arrayContaining(["@pki/backend", "@pki/storage", "@pki/web", "@pki/testkit"]),
    );
    const runtime = manifests
      .filter((m) => m.name !== "@pki/testkit")
      .filter((m) => "@pki/testkit" in { ...m.dependencies, ...m.peerDependencies })
      .map((m) => m.name);
    expect(runtime).toEqual([]);
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
      // upper code may hold and return an implementation it was given (V01-T07 B4)
      { code: "export const i: VectorIndex = o.i;", filename: storageModule },
      { code: "export function f(): VectorIndex { return deps.index; }", filename: storageModule },
      { code: "export const g = async (): Promise<Connector> => load();", filename: storageModule },
      { code: "export const p: LLMProvider = make();", filename: storageModule },
      { code: "export const c = connector as Connector;", filename: storageModule },
      // a factory typed by alias that returns an existing value, like a function does (R2-5)
      { code: "export const f: ConnectorFactory = () => existing;", filename: storageModule },
      { code: "export const f: OpenSqlDriver = (p) => open(p);", filename: storageModule },
      // only the function's own returns count, not a nested function's (R2-3)
      {
        code: "export function f(): Connector { const g = () => ({ a: 1 }); function h() { return { b: 1 }; } return deps.c; }",
        filename: storageModule,
      },
      // a local that is not what is returned, or is reassigned, is not followed
      {
        code: "export function f(): Connector { const c = { a: 1 }; return deps.c ?? load(c); }",
        filename: storageModule,
      },
      // a block-scoped const of the same name does not stand for the returned parameter (R3-3)
      {
        code: "export function f(c: Connector): Connector { { const c = { a: 1 }; } return c; }",
        filename: storageModule,
      },
      // tests may share test helpers
      { code: 'import { h } from "./helper.test.ts";', filename: backendTest },
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
      // import aliases and qualified names (B1), in a package that declares @pki/contracts
      ...[
        'import type { Connector as C } from "@pki/contracts";\nexport class X implements C {}',
        'import type * as c from "@pki/contracts";\nexport class X implements c.Connector {}',
      ].map((code) => ({
        code,
        filename: backendFile,
        errors: [{ messageId: "adapterOutsideAdapters" }],
      })),
      // the contracts package defines adapters; it holds no implementation either (B2)
      {
        code: "export class X implements Connector {}",
        filename: join(fixtureRoot, "packages/contracts/src/x.ts"),
        errors: [{ messageId: "adapterOutsideAdapters" }],
      },
      // product code cannot reach a test module, which may reach adapters (B3)
      ...[
        'import { f } from "./sneaky.test.ts";',
        'export { f } from "./sneaky.e2e.ts";',
        'import { f } from "./screens.e2e.tsx";',
        'const m = await import("../src/sneaky.test");',
        // bundler resolution maps a JS specifier to the TS file (R2-1), one case per extension
        'import { f } from "./sneaky.e2e.js";',
        'import { f } from "./sneaky.test.mjs";',
        'import { f } from "./sneaky.test.cjs";',
        'import { f } from "./sneaky.e2e.jsx";',
        'import { f } from "./sneaky.test.mts";',
        'import { f } from "./sneaky.test.cts";',
      ].map((code) => ({
        code,
        filename: backendFile,
        errors: [{ messageId: "testModuleImport" }],
      })),
      // an implementation outside src/adapters/ would escape the boundary
      ...[
        "export class D implements SqlDriver {}",
        "export const C = class implements Connector {};",
        "export function open(): SqlDriver { return { exec }; }",
        "export const open = (): VectorIndex => ({ status });",
        "export const open: OpenSqlDriver = (p) => ({ exec: p });",
        "export const c = { manifest } satisfies Connector;",
        "export const p: LLMProvider = new Fake();",
        // every form reviewer B probed (V01-T07 B1), one case each
        "export class X implements Partial<Connector> {}",
        "export const open = (): VectorIndex | undefined => ({ status });",
        "export async function open(): Promise<Connector> { return { manifest }; }",
        "export const x = {} as Connector;",
        "type F = () => Connector;\nexport const f: F = () => ({ manifest });",
        "export const f: Make = () => ({ manifest });\ntype Make = () => Connector;",
        'import type { ConnectorFactory } from "./connectors.ts";\nexport const f: ConnectorFactory = () => ({ manifest });',
        "export const s: SqlDriver & { extra: 1 } = { exec, extra: 1 };",
        // round 2 (R2-2): a built value returned through a local, conditionals, same-file
        // interfaces, generic constraints and constructor types
        "export function f(): Connector { const c = { manifest }; return c; }",
        "export function f(): Connector { const c = new Impl(); return c; }",
        // round 3 (R3-1): a returned local behind a cast or `!`
        "export function f(): Connector { const c = { manifest }; return c as Connector; }",
        "export function f(): Connector { const c = { manifest }; return c!; }",
        "export const f = (): Connector => (flag ? { manifest } : fallback);",
        "export const c: Connector = existing ?? { manifest };",
        "interface MyConn extends Connector { extra: 1 }\nexport class X implements MyConn {}",
        "export interface MyConn extends Partial<Connector> {}\nexport const c: MyConn = { manifest };",
        "export function f<T extends Connector>(): T { return { manifest } as T; }",
        "export function f(): new () => Connector { return class {}; }",
        // R2-3: the alias fixed point, the non-null unwrap
        "type B = A;\ntype A = Connector;\nexport class X implements B {}",
        "export const c: Connector = { manifest }!;",
      ].map((code) => ({
        code,
        filename: storageModule,
        errors: [{ messageId: "adapterOutsideAdapters" }],
      })),
    ],
  });
});
