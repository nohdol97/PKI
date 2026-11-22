// V01-C4 `artifact.contents` (V01-R20, V01-T15): the production build's app folder
// holds no test double, no development exception and no test build's pick. Two
// independent readings: the bundler's own list of the modules each bundle kept
// (build-report.json), and the text of every file the build wrote. The
// `build-artifact` setup builds the folder first.
import { expect, test } from "@playwright/test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { backendEntry } from "../src/backend-entry.ts";
import { DEVELOPMENT_EXCEPTION_MARKERS, REPO_ROOT, TEST_PICK_MARKERS } from "../build/bundle.ts";
import { APP_DIR, readBuildReport, type BuildReport } from "../build/paths.ts";
import { judgeConnectorScopes } from "../build/scopes-check.ts";

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

/** Every file under `dir` with this exact name, nothing read. */
function filesNamed(dir: string, name: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesNamed(path, name);
    return entry.name === name ? [path] : [];
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
  for (const file of [
    "main.js",
    "preload.cjs",
    "backend/shell.js",
    "backend/host.js",
    "backend/isolated-worker.js",
    "web/index.html",
  ]) {
    expect(existsSync(join(APP_DIR, file)), file).toBe(true);
  }
  expect(Object.keys(report.bundles).sort()).toEqual([
    "backend/host.js",
    "backend/isolated-worker.js",
    "backend/shell.js",
    "main.js",
  ]);
});

test("the normalizer host and its worker are the product's, not the tests' (I02B-R22, R25)", () => {
  // the host program and the I02-A normalizer are live in their bundles
  expect(report.bundles["backend/host.js"]).toContain(
    "packages/document-normalize/src/host-core.ts",
  );
  expect(report.bundles["backend/isolated-worker.js"]).toContain(
    "packages/document-normalize/src/normalize.ts",
  );
  // no test worker, time-bomb input or net watch is in the folder
  const testing = Object.values(report.bundles)
    .flat()
    .filter((m) => m.startsWith("packages/document-normalize/src/testing/"));
  expect(testing).toEqual([]);
  expect(ownFiles().some((f) => /bomb|hung-host|net-watch/.test(f))).toBe(false);
  // the bundled host starts no worker but the one next to it
  const host = readFileSync(join(APP_DIR, "backend/host.js"), "utf8");
  expect(host).toContain("isolated-worker");
  expect(host).not.toContain("bomb");
  // and takes no argument naming another worker file: that seam is the test host's alone
  expect(host).not.toContain("--worker");
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
        // the public example of a fork's composition package is never part of the product (I05-R16, R20)
        m.startsWith("packages/site-example/") ||
        /\.(test|e2e|setup|test-support)\.[cm]?[jt]sx?$/.test(m) ||
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

test("no bundle carries the lookup of a composition package (I05-R2, C2)", () => {
  // the entry is chosen at build time (backend-entry.ts); the production layout knows the bundled
  // ./backend/shell.js alone. True in the public tree and in a fork-shaped one (I05-R25): a fork's
  // backend bundle names its own modules in region comments (`// site/composition/src/...`), so the
  // folder name alone is looked for in the shell bundle (main.js) only, and in every bundle only
  // the lookup's own literals. They are read from backend-entry.ts, so the probe follows them.
  const lookup = readFileSync(resolve(import.meta.dirname, "../src/backend-entry.ts"), "utf8");
  const probes = [
    /"(site\/composition\/package\.json)"/.exec(lookup)?.[1],
    /(has a package\.json but no backend entry)/.exec(lookup)?.[1],
  ].filter((probe) => probe !== undefined);
  // live: a probe that stopped matching would pass every bundle for nothing
  expect(probes, "lookup literals in backend-entry.ts").toHaveLength(2);
  for (const bundle of Object.keys(report.bundles)) {
    const text = readFileSync(join(APP_DIR, bundle), "utf8");
    for (const probe of probes) expect(text.includes(probe), `${bundle}: ${probe}`).toBe(false);
  }
  expect(
    readFileSync(join(APP_DIR, "main.js"), "utf8").includes("site/composition"),
    "main.js",
  ).toBe(false);
  // a public-shaped tree has no `site/composition` to name: no bundle carries the folder name either
  const publicShaped = backendEntry(REPO_ROOT) === join(REPO_ROOT, "backend/src/shell.ts");
  // the shape is read a second way, so a wrong `backendEntry` cannot switch the strict reading off unseen
  expect(publicShaped, "shape").toBe(!existsSync(join(REPO_ROOT, "site/composition/package.json")));
  if (publicShaped) {
    for (const bundle of Object.keys(report.bundles)) {
      const text = readFileSync(join(APP_DIR, bundle), "utf8");
      expect(text.includes("site/composition"), bundle).toBe(false);
    }
  }
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

// I07-C9: the report's scopes state and counts are what the judgment says for this repository's root
// (a state and two counts; no value and no instance id), and the build's last line names the state
test("the report carries the scopes file's judgment for the real root and no value or id (I07-C9)", () => {
  const verdict = judgeConnectorScopes(
    REPO_ROOT,
    backendEntry(REPO_ROOT),
    report.bundles["backend/shell.js"] ?? [],
  );
  expect(verdict.ok).toBe(true);
  expect(report.connectorScopes).toEqual(
    verdict.ok
      ? { state: verdict.state, entries: verdict.entries, configured: verdict.configured }
      : undefined,
  );
  expect(Object.keys(report.connectorScopes).sort()).toEqual(["configured", "entries", "state"]);
  const file = join(REPO_ROOT, "site/config/connector-scopes.json");
  if (existsSync(file)) {
    const text = readFileSync(join(APP_DIR, "../build-report.json"), "utf8");
    // nothing of the file's keys or values leaks into the report
    for (const [id, held] of Object.entries(JSON.parse(readFileSync(file, "utf8")) as object)) {
      expect(text.includes(JSON.stringify(id)), "an instance id").toBe(false);
      for (const scope of Array.isArray(held) ? held : []) {
        expect(text.includes(JSON.stringify(scope)), "a scope value").toBe(false);
      }
    }
  }
});

// I07-C12: no file named connector-scopes.json is in the app folder (the runtime packages aside, which are
// listed), the backend's module list holds the one allowed place exactly when the real root has the file,
// and the shell's list and the screens carry none. True of the public tree and of a fork-shaped one alike.
test("no scopes file lies in the app folder; the bundle's list and the root's file agree (I07-C12)", () => {
  expect(ownFiles().filter((f) => f.endsWith("connector-scopes.json"))).toEqual([]);
  // the runtime packages' folder too (ownFiles leaves it out): names only
  expect(filesNamed(join(APP_DIR, "node_modules"), "connector-scopes.json")).toEqual([]);
  const place = "site/config/connector-scopes.json";
  const modules = (report.bundles["backend/shell.js"] ?? []).filter((m) =>
    m.endsWith("connector-scopes.json"),
  );
  expect(modules).toEqual(existsSync(join(REPO_ROOT, place)) ? [place] : []);
  expect(
    (report.bundles["main.js"] ?? []).filter((m) => m.endsWith("connector-scopes.json")),
  ).toEqual([]);
  for (const file of ownFiles().filter((f) => relative(APP_DIR, f).startsWith("web"))) {
    expect(readFileSync(file, "latin1").includes("connector-scopes.json"), file).toBe(false);
  }
});
