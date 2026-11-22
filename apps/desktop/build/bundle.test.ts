// V01-R20, R10 (V01-T15): the production build's bundler settings. The build kind
// the bundle carries (a missing or unknown value is production, the define leaves
// no trace of the name), the development exception and the test build's pick
// folded away from a production bundle, the build check that fails on test-only
// modules, and how runtime packages are laid out for the app folder.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  bundle,
  DEVELOPMENT_EXCEPTION_MARKERS,
  forbiddenReason,
  REPLACEMENTS,
  REPO_ROOT,
  TEST_PICK_MARKERS,
} from "./bundle.ts";
import { pnpmCommand } from "./pnpm.ts";
import { planRuntimePackages } from "./runtime-packages.ts";

const out = mkdtempSync(join(tmpdir(), "pki-bundle-test-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

/** Loads a bundle in a plain Node process: the test runner's own define must not reach it. */
function loadBuildKind(file: string): string {
  const script = `const m = await import(${JSON.stringify(pathToFileURL(file).href)}); console.log(m.BUILD_KIND);`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
  });
  expect(run.stderr).toBe("");
  return run.stdout.trim();
}

/** An entry that uses the gate as the product does: through createExecutionGate only. */
function gateEntry(): string {
  const entry = join(out, `gate-entry-${++seq}.ts`);
  const gate = join(REPO_ROOT, "providers/src/execution-gate.ts");
  writeFileSync(entry, `export { createExecutionGate } from ${JSON.stringify(gate)};\n`);
  return entry;
}

let seq = 0;
async function bundled(input: string, kind: string | undefined) {
  const file = join(out, `b${++seq}.mjs`);
  const { modules } = await bundle({ input, outFile: file, buildKind: kind });
  return { file, code: readFileSync(file, "utf8"), modules };
}

// spelled in pieces: only build-kind.ts and bundler configs may name the build value
const NAME = ["PKI", "BUILD", "KIND"].join("_");

describe("build kind in a bundle", () => {
  it.each([
    ["production", "production"],
    ["development", "development"],
    ["test", "test"],
    [undefined, "production"],
    ["", "production"],
    ["dev", "production"],
    ["Development", "production"],
    [" test", "production"],
  ] as const)("a bundle built with %j is a %s build", async (raw, kind) => {
    const { file, code } = await bundled("providers/src/build-kind.ts", raw);
    expect(loadBuildKind(file)).toBe(kind);
    // the define was applied: the name is gone from the output
    if (raw !== undefined) expect(code).not.toContain(NAME);
  });
});

describe("folding a production bundle", () => {
  it("leaves out the development exception and the test build's pick", async () => {
    const { code } = await bundled(gateEntry(), "production");
    for (const marker of [...DEVELOPMENT_EXCEPTION_MARKERS, ...TEST_PICK_MARKERS, NAME]) {
      expect(code, marker).not.toContain(marker);
    }
    expect(code).toContain("cli-not-verified");
  });

  it("keeps the exception in a development bundle and the pick in a test bundle only", async () => {
    const dev = await bundled(gateEntry(), "development");
    for (const marker of DEVELOPMENT_EXCEPTION_MARKERS) expect(dev.code).toContain(marker);
    // R10: the test build's pick is in a test bundle only, not a development one (A-F2)
    for (const marker of TEST_PICK_MARKERS) expect(dev.code, marker).not.toContain(marker);
    const test = await bundled(gateEntry(), "test");
    for (const marker of TEST_PICK_MARKERS) expect(test.code).toContain(marker);
  });
});

describe("folding a production bundle: the job runner's test options (I03-R24)", () => {
  /** The backend as the shell entry starts it: bootBackend, the runner inside. */
  function bootEntry(): string {
    const entry = join(out, `boot-entry-${++seq}.ts`);
    const boot = join(REPO_ROOT, "backend/src/boot.ts");
    writeFileSync(entry, `export { bootBackend } from ${JSON.stringify(boot)};\n`);
    return entry;
  }
  const TEST_JOB_MARKERS = ["testRunnerSettings", "createTestEffectHandler", "test_effects"];

  it("leaves out the test lease and test kinds in a production bundle, keeping the runner", async () => {
    const { code } = await bundled(bootEntry(), "production");
    for (const marker of [...TEST_PICK_MARKERS, ...TEST_JOB_MARKERS]) {
      expect(code, marker).not.toContain(marker);
    }
    // live: the runner and its reclaim are there
    expect(code).toContain("lease-expired");
  });

  it("keeps the runner's test options in a test bundle", async () => {
    const { code } = await bundled(bootEntry(), "test");
    expect(code).toContain("testRunnerSettings");
  });
});

describe("build check", () => {
  // named by path, not left to the file-name rule (V02 spec "T10이 넘기는 것" 5, T11 7)
  it.each([
    "packages/testkit/src/fake-cli.ts",
    "backend/src/v02-seed.e2e.ts",
    "backend/src/v02-double.e2e.ts",
    "backend/src/v02-double.hook.e2e.ts",
    "backend/src/v02-shell.e2e.ts",
    "apps/desktop/e2e/double-main.ts",
    "backend/src/dev.ts",
    "apps/desktop/e2e/launch.ts",
    "backend/src/test-effect.ts",
    "backend/src/job-kill.child.ts",
  ])("refuses %s by its path", (path) => {
    expect(forbiddenReason(join(REPO_ROOT, path))).toBe(`${path} is a test-only module`);
  });

  it.each([
    "packages/testkit/src/index.ts",
    "packages/testkit/src/fake-cli-main.ts",
    "backend/src/v02-seed.e2e.ts",
    "backend/src/dev.ts",
    "apps/desktop/e2e/launch.ts",
    "backend/src/boot.test.ts",
    "apps/web/e2e/screens.e2e.ts",
    "apps/web/src/evidence-view.test.tsx",
    // by the patterns alone, whatever later tasks add without naming it here
    "backend/src/v99-later.e2e.ts",
    "apps/desktop/e2e/later-helper.ts",
    "apps/web/e2e/helpers/anything.ts",
    ...Object.keys(REPLACEMENTS),
  ])("refuses %s", (path) => {
    expect(forbiddenReason(join(REPO_ROOT, path))).toBeTypeOf("string");
  });

  it.each([
    "backend/src/shell.ts",
    "backend/src/composition.ts",
    "providers/src/execution-gate.ts",
    "apps/desktop/src/main.ts",
    ...Object.values(REPLACEMENTS),
  ])("accepts %s", (path) => {
    expect(forbiddenReason(join(REPO_ROOT, path))).toBeUndefined();
  });

  it("fails a bundle that reaches a test-only module, by path rather than by name", async () => {
    const dir = join(REPO_ROOT, "apps/desktop/build/.bundle-test-input");
    mkdirSync(dir, { recursive: true });
    try {
      const entry = join(dir, "entry.ts");
      writeFileSync(
        entry,
        'import { installFakeCli } from "@pki/testkit";\nconsole.log(installFakeCli);\n',
      );
      await expect(
        bundle({ input: entry, outFile: join(out, "refused.mjs"), buildKind: "production" }),
      ).rejects.toThrow(/test-only module/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("puts the production pair in place of a source-run module", async () => {
    const { modules } = await bundled("backend/src/shell-options.ts", "production");
    expect(modules).toEqual(["backend/src/shell-options.production.ts"]);
  });
});

describe("runtime packages", () => {
  /** A pnpm-like store: each package's dependencies are its siblings. */
  function store() {
    const root = mkdtempSync(join(out, "store-"));
    const pkg = (at: string, name: string, version: string, deps: Record<string, string> = {}) => {
      const dir = join(root, at, "node_modules", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name, version, license: "MIT", dependencies: deps }),
      );
      return dir;
    };
    pkg("a", "a", "1.0.0", { c: "1", "@types/x": "1" });
    pkg("a", "c", "1.0.0");
    pkg("a", "@types/x", "1.0.0");
    pkg("b", "b", "1.0.0", { c: "2" });
    pkg("b", "c", "2.0.0");
    // the importer: both roots are its dependencies
    mkdirSync(join(root, "app", "node_modules"), { recursive: true });
    return root;
  }

  it("places one copy per version, nesting a second version under its user", () => {
    const root = store();
    const plan = planRuntimePackages(
      [
        { name: "a", from: join(root, "a") },
        { name: "b", from: join(root, "b") },
      ],
      "/app/node_modules",
    );
    expect(plan.map((p) => [p.name, p.version, p.dest])).toEqual([
      ["a", "1.0.0", "/app/node_modules/a"],
      ["c", "1.0.0", "/app/node_modules/c"],
      ["b", "1.0.0", "/app/node_modules/b"],
      ["c", "2.0.0", "/app/node_modules/b/node_modules/c"],
    ]);
    expect(plan.every((p) => p.license === "MIT")).toBe(true);
  });

  it("fails on a dependency it cannot find", () => {
    const root = store();
    rmSync(join(root, "b", "node_modules", "c"), { recursive: true });
    expect(() => planRuntimePackages([{ name: "b", from: join(root, "b") }], "/x")).toThrow(
      /c .*not found/,
    );
  });
});

describe("pnpm command (no shell)", () => {
  it("runs pnpm's JavaScript entry on this Node", () => {
    expect(pnpmCommand({ npm_execpath: "/x/pnpm.cjs" }, "win32")).toEqual({
      file: process.execPath,
      args: ["/x/pnpm.cjs"],
    });
  });

  it("runs an executable entry as it is", () => {
    expect(pnpmCommand({ npm_execpath: "C:\\pnpm\\pnpm.exe" }, "win32")).toEqual({
      file: "C:\\pnpm\\pnpm.exe",
      args: [],
    });
  });

  it("looks pnpm up on PATH elsewhere, and refuses on Windows without an entry", () => {
    expect(pnpmCommand({}, "darwin")).toEqual({ file: "pnpm", args: [] });
    expect(() => pnpmCommand({}, "win32")).toThrow(/through pnpm/);
  });
});
