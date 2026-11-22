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
import { pathToFileURL } from "node:url";
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
      "storage/src/index.ts",
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
    // only the rule under test runs: the other rules' messages are filtered out below anyway
    const eslint = new ESLint({ cwd: repoRoot, ruleFilter: ({ ruleId }) => ruleId === RULE_ID });
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
  }, 90_000);
  // ^ lints the whole repository. Measured, 5 runs each: 3.3-3.5 s alone (4.3-4.5 s before only this rule
  // ran), 16.9-19.6 s with the machine 3x oversubscribed (24 busy loops on 8 cores). 90 s is 4.5x that.

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
const backendE2eHelper = join(fixtureRoot, "backend/e2e/helper.ts");
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
      // a package's top-level e2e/ folder is test code whatever the file name (V02-T11 A-F2)
      { code: 'import { send } from "@pki/testkit";', filename: backendE2eHelper },
      { code: 'import { open } from "./launch.ts";', filename: backendE2eHelper },
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
      // and the `*.test-support.ts` helpers (I01-T02)
      { code: 'import { h } from "./purge.test-support.ts";', filename: backendTest },
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
        // a test-support helper is test code: no product file imports it (I01-T02)
        'import { f } from "./purge.test-support.ts";',
        'export { f } from "./purge.test-support.js";',
        'const m = await import("./purge.test-support");',
        // an E2E helper under the package's e2e/ folder, by file or by folder (V02-T11 A-F2)
        'import { openEvidence } from "../e2e/screens.ts";',
        'export * from "../e2e";',
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

// I05-C4 (I05-R4, R20): the fork's packages (`@pki-site/…`, under site/) and the public example package
// (`@pki/site-example`) on a throwaway workspace. Seven cases and the review's D1: a fork-shaped package
// reaches no part of the backend by path or by subpath, in a test file as in any other.
describe("module-boundary: fork packages (I05-C4)", () => {
  const forkRoot = mkdtempSync(join(tmpdir(), "pki-boundary-fork-"));
  const forkPkg = (dir: string, manifest: object) => {
    mkdirSync(join(forkRoot, dir, "src"), { recursive: true });
    writeFileSync(join(forkRoot, dir, "package.json"), JSON.stringify(manifest));
  };
  forkPkg(".", { name: "root" });
  forkPkg("backend", {
    name: "@pki/backend",
    dependencies: { "@pki/contracts": "workspace:*" },
  });
  forkPkg("packages/contracts", { name: "@pki/contracts" });
  forkPkg("storage", { name: "@pki/storage" });
  forkPkg("packages/connector-example", { name: "@pki/connector-example" });
  forkPkg("packages/site-example", {
    name: "@pki/site-example",
    dependencies: { "@pki/backend": "workspace:*", "@pki/connector-example": "workspace:*" },
  });
  forkPkg("site/composition", {
    name: "@pki-site/composition",
    dependencies: {
      "@pki/backend": "workspace:*",
      "@pki-site/connector-x": "workspace:*",
    },
  });
  forkPkg("site/connectors/x", {
    name: "@pki-site/connector-x",
    dependencies: { "@pki/contracts": "workspace:*" },
  });
  // B-W7: a collector named like the composition package, which is not at site/composition
  forkPkg("site/connectors/y", { name: "@pki-site/composition" });
  afterAll(() => rmSync(forkRoot, { recursive: true, force: true }));
  const at = (rel: string) => join(forkRoot, rel);

  const registration = at("site/composition/src/registration.ts");
  const compositionShell = at("site/composition/src/shell.ts");
  const compositionTest = at("site/composition/src/registration.test.ts");
  const exampleRegistration = at("packages/site-example/src/registration.ts");
  const exampleShell = at("packages/site-example/src/shell.ts");
  const collectorModule = at("site/connectors/x/src/impl.ts");
  const collectorAdapter = at("site/connectors/x/src/adapters/impl.ts");
  const publicBackend = at("backend/src/server.ts");

  ruleTester.run("module-boundary (fork packages)", moduleBoundary, {
    valid: [
      // ① the composition package's registration takes a collector's adapters entry
      { code: 'import { c } from "@pki-site/connector-x/adapters";', filename: registration },
      // ⑥ and so does the example's registration, for the example collector
      {
        code: 'import { c } from "@pki/connector-example/adapters";',
        filename: exampleRegistration,
      },
      // a fork package imports a public package it declares, by name
      { code: 'import { runShell } from "@pki/backend";', filename: compositionShell },
      { code: 'import { runShell } from "@pki/backend";', filename: exampleShell },
      { code: 'import { r } from "./registration.ts";', filename: compositionShell },
      // a collector's implementation lives under its src/adapters/
      { code: "export class C implements Connector {}", filename: collectorAdapter },
      // a test file may take an adapters entry
      { code: 'import { c } from "@pki-site/connector-x/adapters";', filename: compositionTest },
    ],
    invalid: [
      // ② any other file of the composition package, or of the example, is refused the entry
      {
        code: 'import { c } from "@pki-site/connector-x/adapters";',
        filename: compositionShell,
        errors: [{ messageId: "adapterEntry" }],
      },
      {
        code: 'import { c } from "@pki/connector-example/adapters";',
        filename: exampleShell,
        errors: [{ messageId: "adapterEntry" }],
      },
      // ... and a registration file of one package does not take the other's right
      {
        code: 'import { c } from "@pki-site/connector-x/adapters";',
        filename: at("site/connectors/x/src/registration.ts"),
        errors: [{ messageId: "adapterEntry" }],
      },
      // B-W7: the composition-point name belongs to the package at site/composition only
      {
        code: 'import { c } from "@pki-site/connector-x/adapters";',
        filename: at("site/connectors/y/src/registration.ts"),
        errors: [{ messageId: "adapterEntry" }],
      },
      // ③ a collector implements Connector outside its src/adapters/
      {
        code: "export class C implements Connector {}",
        filename: collectorModule,
        errors: [{ messageId: "adapterOutsideAdapters" }],
      },
      // ④ a public package, the example included, imports a fork package
      {
        code: 'import { r } from "@pki-site/composition";',
        filename: publicBackend,
        errors: [{ messageId: "forkImport" }],
      },
      {
        code: 'import { c } from "@pki-site/connector-x";',
        filename: exampleRegistration,
        errors: [{ messageId: "forkImport" }],
      },
      {
        code: 'export * from "@pki-site/connector-x/adapters";',
        filename: at("backend/src/server.test.ts"),
        errors: [{ messageId: "forkImport" }],
      },
      {
        code: 'const m = await import("@pki-site/composition");',
        filename: publicBackend,
        errors: [{ messageId: "forkImport" }],
      },
      // ⑤ a fork package imports a public package it did not declare
      {
        code: 'import { s } from "@pki/storage";',
        filename: registration,
        errors: [{ messageId: "undeclaredDependency" }],
      },
      {
        code: 'import { s } from "@pki/storage";',
        filename: at("site/connectors/x/src/adapters/impl.ts"),
        errors: [{ messageId: "undeclaredDependency" }],
      },
      // a fork package imports a fork package it did not declare
      {
        code: 'import { c } from "@pki-site/composition";',
        filename: at("site/connectors/x/src/index.ts"),
        errors: [{ messageId: "undeclaredDependency" }],
      },
      // D1: nothing of the backend is reached by path or by subpath from a fork-shaped package,
      // in a product file and in a test file alike (bootBackend takes unchecked connectors and policies)
      ...[
        registration,
        compositionShell,
        compositionTest,
        exampleRegistration,
        exampleShell,
      ].flatMap((filename) => [
        {
          code: 'import { bootBackend } from "../../../backend/src/boot.ts";',
          filename,
          errors: [{ messageId: "crossPackageRelative" }],
        },
        {
          code: 'import { bootBackend } from "../../../backend/src/boot";',
          filename,
          errors: [{ messageId: "crossPackageRelative" }],
        },
        {
          code: "const m = await import(`../../../backend/src/boot.ts`);",
          filename,
          errors: [{ messageId: "crossPackageRelative" }],
        },
        {
          code: 'import { bootBackend } from "@pki/backend/src/boot.ts";',
          filename,
          errors: [{ messageId: "deepImport" }],
        },
        {
          code: 'export { bootBackend } from "@pki/backend/boot";',
          filename,
          errors: [{ messageId: "deepImport" }],
        },
      ]),
    ],
  });

  // B-S1: absolute paths and file: URLs are judged like relative ones, by the package of their target
  const absoluteBoot = join(forkRoot, "backend/src/boot.ts");
  const urlBoot = pathToFileURL(absoluteBoot).href;
  ruleTester.run("module-boundary (absolute and file: specifiers)", moduleBoundary, {
    valid: [
      // a path inside the file's own package is fine, written absolute or as a URL
      {
        code: `import { r } from ${JSON.stringify(at("site/composition/src/registration.ts"))};`,
        filename: compositionShell,
      },
      {
        code: `import { r } from ${JSON.stringify(pathToFileURL(at("site/composition/src/registration.ts")).href)};`,
        filename: compositionShell,
      },
    ],
    invalid: [registration, exampleShell, compositionTest].flatMap((filename) =>
      [
        `import { bootBackend } from ${JSON.stringify(absoluteBoot)};`,
        `export { bootBackend } from ${JSON.stringify(absoluteBoot)};`,
        `const m = await import(${JSON.stringify(absoluteBoot)});`,
        `import { bootBackend } from ${JSON.stringify(urlBoot)};`,
        `export * from ${JSON.stringify(urlBoot)};`,
        `const m = await import(${JSON.stringify(urlBoot)});`,
      ].map((code) => ({ code, filename, errors: [{ messageId: "crossPackageRelative" }] })),
    ),
  });

  // B-S2: the allow-list slot for one cross-package relative target, tested with a fixture entry (the shipped
  // entry is judged by I07-C18 below)
  const slot = [
    {
      pkg: "@pki-site/composition",
      file: "src/registration.ts",
      target: "../config/connector-scopes.json",
    },
  ];
  const slotOptions = [{ allowRelative: slot }];
  ruleTester.run("module-boundary (relative allow-list slot)", moduleBoundary, {
    valid: [
      // exactly the one resolved file, from the named package
      {
        code: 'import s from "../../config/connector-scopes.json";',
        filename: registration,
        options: slotOptions,
      },
      // the same file written another way resolves to the same path
      {
        code: 'import s from "../../config/../config/connector-scopes.json";',
        filename: registration,
        options: slotOptions,
      },
    ],
    invalid: [
      // the entry names a file: another file of the same package is refused
      {
        code: 'import s from "../../config/connector-scopes.json";',
        filename: compositionShell,
        options: slotOptions,
        errors: [{ messageId: "crossPackageRelative" }],
      },
      // a sibling file next to the allowed one
      {
        code: 'import s from "../../config/other.json";',
        filename: registration,
        options: slotOptions,
        errors: [{ messageId: "crossPackageRelative" }],
      },
      // the same file name in another folder: the resolved path differs though the text ends alike
      {
        code: 'import s from "../../other/connector-scopes.json";',
        filename: registration,
        options: slotOptions,
        errors: [{ messageId: "crossPackageRelative" }],
      },
      // a traversal that reaches another file
      {
        code: 'import s from "../../config/../../backend/src/boot.ts";',
        filename: registration,
        options: slotOptions,
        errors: [{ messageId: "crossPackageRelative" }],
      },
      // the same specifier from a different package
      {
        code: 'import s from "../../config/connector-scopes.json";',
        filename: at("site/connectors/x/src/index.ts"),
        options: slotOptions,
        errors: [{ messageId: "crossPackageRelative" }],
      },
    ],
  });

  // I07-C18 `module-boundary` (I07-R16): the shipped table's one entry, judged with no option. One passing case
  // and the refusals, each breaking exactly one narrowing: the package (⑥⑦⑧ and the two that sit where the
  // target resolves the same), the file (②), the exact target (③④⑤), the form (⑨⑩⑪).
  const SCOPES = "../../config/connector-scopes.json";
  const staticImport = `import scopes from ${JSON.stringify(SCOPES)} with { type: "json" };`;
  const refused = (name: string, code: string, filename: string) => ({
    name: `refused: ${name}`,
    code,
    filename,
    // the option REPLACES the shipped table: one case gives an empty one
    ...(name.startsWith("an allowRelative option") ? { options: [{ allowRelative: [] }] } : {}),
    errors: [{ messageId: "crossPackageRelative" }],
  });
  // packages whose root is two folders under the fork root, so the entry's target resolves to the very file
  // they import: only their package (name or folder) tells them from the composition package
  forkPkg("site/collector", { name: "@pki-site/collector" });
  forkPkg("site/impostor", { name: "@pki-site/composition" });
  forkPkg("packages/other", { name: "@pki/other" });
  // the folder alone is not enough either: a package at site/composition under another name
  const renamedRoot = mkdtempSync(join(tmpdir(), "pki-boundary-renamed-"));
  mkdirSync(join(renamedRoot, "site/composition/src"), { recursive: true });
  writeFileSync(
    join(renamedRoot, "site/composition/package.json"),
    JSON.stringify({ name: "@pki-site/not-composition" }),
  );
  afterAll(() => rmSync(renamedRoot, { recursive: true, force: true }));
  ruleTester.run("module-boundary (the scopes file's one import, I07-R16)", moduleBoundary, {
    valid: [
      // ① the composition package's registration, a static import declaration, the resolved target
      {
        name: "① the composition package's registration",
        code: staticImport,
        filename: registration,
      },
      {
        name: "a type-only import of the exact file",
        code: 'import type s from "../../config/connector-scopes.json" with { type: "json" };',
        filename: registration,
      },
      {
        name: "a side-effect import of the exact file",
        code: 'import "../../config/connector-scopes.json" with { type: "json" };',
        filename: registration,
      },
      {
        name: "① the same file written another way",
        code: 'import s from "../../config/../config/connector-scopes.json";',
        filename: registration,
      },
    ],
    invalid: [
      refused("② another file of the same package", staticImport, compositionShell),
      refused(
        "③ another JSON of site/config/",
        'import s from "../../config/other.json" with { type: "json" };',
        registration,
      ),
      refused("④ a .ts of site/config/", 'import s from "../../config/index.ts";', registration),
      refused(
        "⑤ a scopes file of another package",
        'import s from "../../connectors/x/connector-scopes.json" with { type: "json" };',
        registration,
      ),
      refused(
        "⑥ a fork package that is not the composition package (site/connectors/x)",
        'import s from "../../../config/connector-scopes.json" with { type: "json" };',
        at("site/connectors/x/src/registration.ts"),
      ),
      refused(
        "⑥ a fork package whose root makes the target match (site/collector)",
        staticImport,
        at("site/collector/src/registration.ts"),
      ),
      refused(
        "⑥ the package's name alone is not enough: the folder must be site/composition",
        staticImport,
        at("site/impostor/src/registration.ts"),
      ),
      refused(
        "⑥ the folder alone is not enough: the package must be named @pki-site/composition",
        staticImport,
        join(renamedRoot, "site/composition/src/registration.ts"),
      ),
      refused(
        "⑦ the example package's registration, naming the very target",
        'import s from "../../../site/config/connector-scopes.json" with { type: "json" };',
        exampleRegistration,
      ),
      refused(
        "⑧ a public package's file (the backend)",
        'import s from "../../site/config/connector-scopes.json" with { type: "json" };',
        publicBackend,
      ),
      refused(
        "⑧ a public package whose root makes the target match",
        staticImport,
        at("packages/other/src/registration.ts"),
      ),
      refused(
        "⑨ re-exported (export { default } from)",
        `export { default } from ${JSON.stringify(SCOPES)};`,
        registration,
      ),
      refused(
        "⑨ re-exported (export * from)",
        `export * from ${JSON.stringify(SCOPES)};`,
        registration,
      ),
      refused(
        "⑩ import()",
        `const s = await import(${JSON.stringify(SCOPES)}, { with: { type: "json" } });`,
        registration,
      ),
      refused(
        "an absolute path naming the same file (the exemption is for relative specifiers)",
        `import s from ${JSON.stringify(at("site/config/connector-scopes.json"))} with { type: "json" };`,
        registration,
      ),
      refused(
        "a file: URL naming the same file",
        `import s from ${JSON.stringify(pathToFileURL(at("site/config/connector-scopes.json")).href)} with { type: "json" };`,
        registration,
      ),
      refused(
        "an allowRelative option replaces the table: an empty one leaves the shipped entry off",
        staticImport,
        registration,
      ),
      refused(
        "⑪ typeof import()",
        `type T = typeof import(${JSON.stringify(SCOPES)}, { with: { "resolution-mode": "import" } });`,
        registration,
      ),
    ],
  });

  it("⑥ the real example package passes the repository's boundary rule with no violation, its registration alone taking the collector's entry", async () => {
    const eslint = new ESLint({ cwd: repoRoot, ruleFilter: ({ ruleId }) => ruleId === RULE_ID });
    const results = await eslint.lintFiles(["packages/site-example"]);
    expect(results.length).toBeGreaterThan(3);
    expect(results.flatMap((r) => r.messages.map((m) => `${r.filePath}: ${m.message}`))).toEqual(
      [],
    );
    const entry = 'import { c } from "@pki/connector-example/adapters";\nexport { c };\n';
    const ids = async (file: string) =>
      (await lintWithRepoConfig(entry, file)).map((m) => m.messageId);
    expect(await ids("packages/site-example/src/registration.ts")).toEqual([]);
    expect(await ids("packages/site-example/src/shell.ts")).toEqual(["adapterEntry"]);
  });

  it("the example package's registration file is a composition point, its other product files are not, its tests may take the entry", async () => {
    const entry = 'import { c } from "@pki/connector-example/adapters";\nexport { c };\n';
    const hits = [] as string[];
    for (const file of [
      "packages/site-example/src/site-check.ts",
      "packages/site-example/src/registration.test.ts",
    ]) {
      hits.push(`${file}: ${(await lintWithRepoConfig(entry, file)).map((m) => m.messageId)}`);
    }
    // the test file may take it (tests reach the implementation they test); the other product file may not
    expect(hits).toEqual([
      "packages/site-example/src/site-check.ts: adapterEntry",
      "packages/site-example/src/registration.test.ts: ",
    ]);
  });
});

// I01-R24, T03: @pki/connector-sdk is a pure library outside the adapter boundary. Any
// package may import it by name (when it declares it); it imports only @pki/contracts,
// zod and the node: modules the Connector paths may use (I01-R28's allow-list).
describe("the @pki/connector-sdk allow-list", () => {
  const sdkFile = "packages/connector-sdk/src/parse.ts";
  const ids = async (code: string, file = sdkFile) =>
    (await lintWithRepoConfig(code, file)).map((m) => m.messageId);

  it("lets the package import @pki/contracts, zod, its own files and the node: modules of the list", async () => {
    for (const specifier of [
      "@pki/contracts",
      "zod",
      "node:crypto",
      "node:fs",
      "node:fs/promises",
      "node:path",
      "./sync-outcomes.ts",
    ]) {
      expect(await ids(`import * as x from "${specifier}";\nexport { x };\n`), specifier).toEqual(
        [],
      );
    }
  });

  it("refuses any other import in the package's product files: a node: module outside the list, a bare package, another workspace package", async () => {
    for (const specifier of ["node:https", "node:net", "node:child_process", "ws", "vitest"]) {
      expect(await ids(`import * as x from "${specifier}";\nexport { x };\n`), specifier).toEqual([
        "sdkImportNotAllowed",
      ]);
    }
    expect(await ids('import * as x from "@pki/storage";\nexport { x };\n')).toContain(
      "sdkImportNotAllowed",
    );
    expect(await ids('export const m = () => import("node:https");\n')).toEqual([
      "sdkImportNotAllowed",
    ]);
  });

  it("lets the package's test files also take vitest and @pki/testkit", async () => {
    expect(
      await ids(
        'import { it } from "vitest";\nexport { it };\n',
        "packages/connector-sdk/src/parse.test.ts",
      ),
    ).toEqual([]);
  });

  it("lets other packages' files take other modules: the allow-list binds the SDK only", async () => {
    expect(
      await ids('import * as x from "node:https";\nexport { x };\n', "backend/src/anything.ts"),
    ).toEqual([]);
  });

  it("depends on @pki/contracts alone, and a package that does not declare it cannot import it by name", async () => {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, "packages/connector-sdk/package.json"), "utf8"),
    );
    expect(manifest.name).toBe("@pki/connector-sdk");
    expect(Object.keys(manifest.dependencies)).toEqual(["@pki/contracts"]);
    // storage does not declare it: the existing dependency rule speaks, not a new one
    expect(
      await ids('import * as x from "@pki/connector-sdk";\nexport { x };\n', "storage/src/x.ts"),
    ).toEqual(["undeclaredDependency"]);
  });
});

// S01-T02 `lifecycle.actor-boundary` (S01-R7, R5): the user's entry to the Semantic registry
// (`userDecisions`) is imported only by the composition point and, as a type, the API layer; and
// the registry's history lines and a replaced row are written only inside the gate module.
describe("the user entry and the registry's writes (S01-T02)", () => {
  const ids = async (code: string, file: string) =>
    (await lintWithRepoConfig(code, file)).map((m) => m.messageId);
  const entry = 'import { userDecisions } from "@pki/storage";\nexport { userDecisions };\n';

  it("fails when knowledge-engine code imports the user entry, by name, under an alias, or re-exported", async () => {
    const file = "knowledge-engine/src/extraction.ts";
    expect(await ids(entry, file)).toEqual(["userEntryImport"]);
    expect(
      await ids('import { userDecisions as u } from "@pki/storage";\nexport { u };\n', file),
    ).toEqual(["userEntryImport"]);
    expect(await ids('export { userDecisions } from "@pki/storage";\n', file)).toEqual([
      "userEntryImport",
    ]);
    expect(
      await ids('import * as s from "@pki/storage";\nexport const x = s.userDecisions;\n', file),
    ).toEqual(["userEntryImport"]);
  });

  // I05-R4 and S01-R7 together: a fork's composition point may reach adapters, but it is not the
  // composition root that hands the user entry to the API layer.
  it("fails when a fork composition point imports the user entry", async () => {
    expect(await ids(entry, "packages/site-example/src/registration.ts")).toContain(
      "userEntryImport",
    );
    expect(await ids(entry, "backend/src/composition.ts")).toEqual([]);
  });

  it("fails for the job runner and any other backend module, and for its type outside the two files", async () => {
    expect(await ids(entry, "backend/src/job-runner.ts")).toEqual(["userEntryImport"]);
    expect(await ids(entry, "backend/src/connector-sync-job.ts")).toEqual(["userEntryImport"]);
    expect(
      await ids(
        'import type { UserDecisions } from "@pki/storage";\nexport type T = UserDecisions;\n',
        "backend/src/jobs-view.ts",
      ),
    ).toEqual(["userEntryImport"]);
  });

  it("lets the composition point hold the entry and the API layer name its type", async () => {
    expect(await ids(entry, "backend/src/composition.ts")).toEqual([]);
    expect(
      await ids(
        'import type { UserDecisions } from "@pki/storage";\nexport type T = UserDecisions;\n',
        "backend/src/server.ts",
      ),
    ).toEqual([]);
    // the API layer takes it from its options: the value is not its to import
    expect(await ids(entry, "backend/src/server.ts")).toEqual(["userEntryImport"]);
  });

  it("lets a test file import the entry", async () => {
    expect(await ids(entry, "knowledge-engine/src/extraction.test.ts")).toEqual([]);
    expect(await ids(entry, "backend/src/semantic-api.test.ts")).toEqual([]);
  });

  it("fails on a history line written outside the gate module, in any statement form", async () => {
    for (const sql of [
      "INSERT INTO fact_history (fact_id) VALUES (1)",
      "insert  or  ignore\n into item_history(item_id) values (1)",
      "INSERT OR REPLACE INTO relation_history (relation_id) VALUES (1)",
    ]) {
      const code = `export const q = ${JSON.stringify(sql)};\n`;
      expect(await ids(code, "backend/src/server.ts"), sql).toEqual(["registryWrite"]);
      expect(
        await ids(`export const q = \`${sql}\`;\n`, "knowledge-engine/src/extraction.ts"),
      ).toEqual(["registryWrite"]);
    }
  });

  it("fails on a REPLACE of an item, fact or relation row outside the gate module", async () => {
    for (const sql of [
      "REPLACE INTO facts (item_id, kind, value) VALUES (1, 'k', 'v')",
      "INSERT OR REPLACE INTO items (type, name) VALUES ('p', 'n')",
      "INSERT  OR  REPLACE  INTO relations (subject_id) VALUES (1)",
    ]) {
      expect(
        await ids(`export const q = ${JSON.stringify(sql)};\n`, "storage/src/knowledge.ts"),
        sql,
      ).toEqual(["registryWrite"]);
    }
  });

  it("fails on a bare REPLACE into a history table and on quoted or schema-qualified table names", async () => {
    for (const sql of [
      "REPLACE INTO fact_history (fact_id) VALUES (1)",
      "replace into item_history (item_id) values (1)",
      'INSERT INTO main."fact_history" (fact_id) VALUES (1)',
      'INSERT INTO "main"."relation_history" (relation_id) VALUES (1)',
      'REPLACE INTO main."facts" (item_id) VALUES (1)',
      'INSERT OR REPLACE INTO "main"."items" (type) VALUES (1)',
      "REPLACE INTO [relations] (subject_id) VALUES (1)",
    ]) {
      expect(
        await ids(`export const q = ${JSON.stringify(sql)};\n`, "storage/src/knowledge.ts"),
        sql,
      ).toEqual(["registryWrite"]);
    }
  });

  it("fails on destructuring the user entry out of a namespace import of @pki/storage", async () => {
    const code =
      'import * as s from "@pki/storage";\nconst { userDecisions } = s;\nexport { userDecisions };\n';
    expect(await ids(code, "knowledge-engine/src/extraction.ts")).toEqual(["userEntryImport"]);
    expect(await ids(code, "backend/src/server.ts")).toEqual(["userEntryImport"]);
    expect(await ids(code, "backend/src/composition.ts")).toEqual([]);
    expect(
      await ids(
        'import * as s from "@pki/storage";\nconst { insertItem } = s;\nexport { insertItem };\n',
        "knowledge-engine/src/extraction.ts",
      ),
    ).toEqual([]);
  });

  it("lets the gate module, a test file and the test seed write them, and other tables' inserts and replaces pass", async () => {
    const history = 'export const q = "INSERT INTO fact_history (fact_id) VALUES (1)";\n';
    expect(await ids(history, "storage/src/semantic-lifecycle.ts")).toEqual([]);
    expect(await ids(history, "storage/src/semantic-user.test.ts")).toEqual([]);
    expect(await ids(history, "packages/testkit/src/knowledge-status-seed.ts")).toEqual([]);
    for (const sql of [
      "INSERT INTO facts (item_id) VALUES (1)",
      "INSERT INTO items_new SELECT * FROM items",
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('a', 'b')",
      "SELECT * FROM fact_history",
      "DELETE FROM fact_history WHERE fact_id = 1",
    ]) {
      expect(
        await ids(`export const q = ${JSON.stringify(sql)};\n`, "storage/src/knowledge.ts"),
        sql,
      ).toEqual([]);
    }
  });
});
