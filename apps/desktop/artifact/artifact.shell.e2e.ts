// The production build's whole app (V01-T15): Electron started on the app folder
// as an installed app starts, not through Playwright, which needs the debugging
// switches this shell refuses (review A-F1). With Chromium's remote debugging or
// Node's inspector asked for, it exits before the window and the backend exist.
// Without them, in a development-looking environment and with the source runs'
// switches, it starts its backend from backend/shell.js on the per-user data
// directory of the (temporary) HOME, loads the screens from web/ (the shell's
// "screens loaded" line: a missing or failing page fails the start instead), and
// writes nothing where the switches point.
// Chromium's own --user-data-dir keeps its profile out of the real one (T15 6).
import { expect, test } from "@playwright/test";
import { resolveDataDirectory } from "@pki/storage";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { APP_DIR } from "../build/paths.ts";
import { ELECTRON } from "../e2e/launch.ts";
import { SCREENS_LOADED } from "../src/window.ts";

const FIXTURES = resolve(import.meta.dirname, "../../../fixtures");

let dir: string;
test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-artifact-shell-"));
});
test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

function launch(args: string[]) {
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  // what a desktop session gives an app, plus development-looking variables; not this
  // test runner's environment
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    TMPDIR: tmpdir(),
    HOME: home,
    XDG_DATA_HOME: join(dir, "xdg"),
    NODE_ENV: "development",
    [["PKI", "BUILD", "KIND"].join("_")]: "development",
    ELECTRON_IS_DEV: "1",
  };
  const dataDir = resolveDataDirectory({ platform: process.platform, home, env });
  const child = spawn(ELECTRON, [APP_DIR, `--user-data-dir=${join(dir, "chromium")}`, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
  child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  return { child, exited, dataDir, stderr: () => stderr, stdout: () => stdout };
}

for (const args of [["--remote-debugging-port=0"], ["--remote-debugging-pipe"], ["--inspect=0"]]) {
  test(`exits at once with ${args.join(" ")}: no window, no backend`, async () => {
    test.setTimeout(60_000);
    const app = launch(args);
    // an app that keeps running instead is killed, never left behind
    const code = await Promise.race([
      app.exited,
      new Promise<"running">((r) => setTimeout(() => r("running"), 20_000)),
    ]);
    if (code === "running") {
      app.child.kill("SIGKILL");
      await app.exited;
    }
    expect(code).toBe(1);
    expect(app.stderr()).toContain("refusing to start with a debugging switch");
    expect(existsSync(join(app.dataDir, "pki.sqlite"))).toBe(false);
  });
}

test("starts its backend on the user's data directory and ignores the switches", async () => {
  test.setTimeout(60_000);
  const switched = join(dir, "switch-data");
  const app = launch([
    `--pki-user-data=${join(dir, "switch-user")}`,
    `--pki-data-dir=${switched}`,
    `--pki-fixtures=${join(FIXTURES, "test-connector.jsonl")}`,
  ]);
  try {
    // the screens from web/ answered and loaded (review D1: a blank window is a failure),
    // after the backend from backend/shell.js opened and migrated the canonical DB
    await expect
      .poll(() => app.stdout().includes(SCREENS_LOADED), { timeout: 30_000, message: app.stderr() })
      .toBe(true);
    expect(existsSync(join(app.dataDir, "pki.sqlite"))).toBe(true);
    expect(app.child.exitCode).toBeNull();
  } finally {
    app.child.kill("SIGTERM");
    const ended = await Promise.race([
      app.exited.then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), 15_000)),
    ]);
    if (!ended) app.child.kill("SIGKILL");
    await app.exited;
  }
  expect(app.stderr()).not.toContain("failed to start");
  expect(existsSync(switched)).toBe(false);
  expect(existsSync(join(dir, "switch-user"))).toBe(false);
});

/** Resolves as soon as `path` exists: a quit then lands while the window still loads. */
function appears(path: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolveFound) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (existsSync(path) || Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolveFound(existsSync(path));
      }
    }, 5);
  });
}

test("quitting while it starts ends the app, with no error box holding it", async () => {
  test.setTimeout(120_000);
  // a few starts: the quit must land before the window has loaded at least once
  for (let attempt = 0; attempt < 3; attempt++) {
    rmSync(join(dir, "home"), { recursive: true, force: true });
    rmSync(join(dir, "chromium"), { recursive: true, force: true });
    const app = launch([]);
    expect(await appears(join(app.dataDir, "pki.sqlite"), 30_000)).toBe(true);
    app.child.kill("SIGTERM");
    const ended = await Promise.race([
      app.exited.then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), 10_000)),
    ]);
    if (!ended) app.child.kill("SIGKILL");
    await app.exited;
    expect(ended, app.stderr()).toBe(true);
    expect(app.stderr()).not.toContain("failed to start");
  }
});
