// V01-C4 `artifact.contents` (V01-R20, V01-T15): the production build's app folder
// holds no test double, no development exception and no test build's pick. Two
// independent readings: the bundler's own list of the modules each bundle kept
// (build-report.json), and the text of every file the build wrote. The
// `build-artifact` setup builds the folder first.
import { expect, test } from "@playwright/test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DEVELOPMENT_EXCEPTION_MARKERS, TEST_PICK_MARKERS } from "../build/bundle.ts";
import { APP_DIR, readBuildReport, type BuildReport } from "../build/paths.ts";

// spelled in pieces: only build-kind.ts and bundler configs may name the build value
const BUILD_VALUE = ["PKI", "BUILD", "KIND"].join("_");

/** Every file the build wrote, the runtime packages aside (listed in the report). */
function ownFiles(dir = APP_DIR): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (path === join(APP_DIR, "node_modules")) return [];
    return statSync(path).isDirectory() ? ownFiles(path) : [path];
  });
}

// read when the tests run, after the build-artifact setup: Playwright loads this file first
let report: BuildReport;
test.beforeAll(() => {
  report = readBuildReport();
});

test("the app folder is laid out for Electron", () => {
  const manifest = JSON.parse(readFileSync(join(APP_DIR, "package.json"), "utf8"));
  expect(manifest).toMatchObject({ main: "main.js", type: "module" });
  for (const file of ["main.js", "preload.cjs", "backend/shell.js", "web/index.html"]) {
    expect(existsSync(join(APP_DIR, file)), file).toBe(true);
  }
  expect(Object.keys(report.bundles).sort()).toEqual(["backend/shell.js", "main.js"]);
});

test("no bundle kept a test-only, development-only or source-run module", () => {
  // the report is live: the modules that must be there are
  for (const module of [
    "providers/src/execution-gate.ts",
    "backend/src/shell-options.production.ts",
  ]) {
    expect(report.bundles["backend/shell.js"]).toContain(module);
  }
  expect(report.bundles["main.js"]).toContain("apps/desktop/src/layout.production.ts");
  const refused = Object.values(report.bundles)
    .flat()
    .filter(
      (m) =>
        m.startsWith("packages/testkit/") ||
        m.startsWith("apps/desktop/e2e/") ||
        /\.(test|e2e|setup)\.[cm]?[jt]sx?$/.test(m) ||
        /(^|\/)e2e\//.test(m) ||
        [
          "backend/src/v02-seed.e2e.ts",
          "backend/src/dev.ts",
          "backend/src/adapters/fixture-connector.ts",
          "backend/src/shell-options.ts",
          "apps/desktop/src/layout.ts",
        ].includes(m),
    );
  expect(refused).toEqual([]);
});

test("neither bundle carries the development exception or the test build's pick", () => {
  // T09 1: the decision code lives in the backend; the shell is checked too. The
  // screens only show the reason the backend sent (T15 3), so they are not.
  // live: the production decision is in the backend bundle
  expect(readFileSync(join(APP_DIR, "backend/shell.js"), "utf8")).toContain("cli-not-verified");
  for (const bundle of Object.keys(report.bundles)) {
    const text = readFileSync(join(APP_DIR, bundle), "utf8");
    // and the development secret source of dev.ts ("T11이 넘기는 것" 7: envSecrets);
    // the screens name its variables in the browser-development guidance only
    for (const marker of [
      ...DEVELOPMENT_EXCEPTION_MARKERS,
      ...TEST_PICK_MARKERS,
      "PKI_DEV_OPENAI_API_KEY",
    ]) {
      expect(text.includes(marker), `${bundle}: ${marker}`).toBe(false);
    }
  }
});

test("no file the build wrote carries a double, a test switch or the build value", () => {
  const markers = [
    BUILD_VALUE,
    // the shell's switches of source runs (T06 7)
    "pki-user-data",
    "pki-data-dir",
    "pki-fixtures",
    // the test Connector and the test-build-only seed (T04 ③, V02 T10 5)
    "createFixtureConnector",
    "v02-seed",
    // the test-build-only job kind (I03-R24)
    "createTestEffectHandler",
    "test_effects",
    // doubles of @pki/testkit (T07, T10, T13)
    "installFakeCli",
    "FakeProvider",
    "FakeEmbedder",
    "fixtureExtraction",
    "MemoryKnowledgeEngine",
    "ProposingKnowledgeEngine",
  ];
  const files = ownFiles();
  expect(files.length).toBeGreaterThan(4);
  const found = files.flatMap((file) => {
    const text = readFileSync(file, "latin1");
    return markers.filter((m) => text.includes(m)).map((m) => `${relative(APP_DIR, file)}: ${m}`);
  });
  expect(found).toEqual([]);
});

test("the runtime packages are the bundles' externals only, each with its license", () => {
  const names = report.packages.map((p) => p.name);
  expect(names).toEqual(expect.arrayContaining(["better-sqlite3", "@huggingface/transformers"]));
  expect(
    names.filter((n) => n.startsWith("@pki/") || /^(vitest|@playwright|electron)$/.test(n)),
  ).toEqual([]);
  for (const p of report.packages) {
    expect(p.license, p.name).toMatch(/\S/);
    expect(existsSync(join(APP_DIR, p.path, "package.json")), p.path).toBe(true);
  }
  // nothing in node_modules that the report does not list
  const top = readdirSync(join(APP_DIR, "node_modules")).flatMap((n) =>
    n.startsWith("@") ? readdirSync(join(APP_DIR, "node_modules", n)).map((s) => `${n}/${s}`) : [n],
  );
  for (const name of top) expect(names, name).toContain(name);
});
