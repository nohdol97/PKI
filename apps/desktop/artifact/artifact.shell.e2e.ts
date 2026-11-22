// The production build's whole app (V01-T15): Electron started on the app folder
// as an installed app starts, not through Playwright, which needs the debugging
// switches this shell refuses (review A-F1). With Chromium's remote debugging or
// Node's inspector asked for, it exits before the window and the backend exist.
// Without them, in a development-looking environment and with the source runs'
// switches, it starts its backend from backend/shell.js on the per-user data
// directory of the (temporary) HOME and writes nothing where the switches point.
// Chromium's own --user-data-dir keeps its profile out of the real one (T15 6).
import { expect, test } from "@playwright/test";
import { resolveDataDirectory } from "@pki/storage";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { APP_DIR } from "../build/paths.ts";
import { ELECTRON } from "../e2e/launch.ts";

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
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  return { child, exited, dataDir, stderr: () => stderr };
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
    // the backend from backend/shell.js opened and migrated the canonical DB
    await expect
      .poll(() => existsSync(join(app.dataDir, "pki.sqlite")), { timeout: 30_000 })
      .toBe(true);
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
