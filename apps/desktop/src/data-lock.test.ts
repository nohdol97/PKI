// R04L-C1, C2: the data-folder lock (spec 2026-11-23-R04-data-dir-lock). Real temp folders.
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_LOCK_FILE, lockDataDirectory } from "./data-lock.ts";

let root: string;
let holder: ChildProcess | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pki-data-lock-"));
});
afterEach(() => {
  holder?.kill("SIGKILL");
  holder = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe("lockDataDirectory", () => {
  it("R04L-C1: creates a missing folder, and a held lock makes the next attempt return undefined", () => {
    const dir = join(root, "d");
    const held = lockDataDirectory(dir);
    expect(held).toBeDefined();
    expect(existsSync(dir)).toBe(true);
    expect(lockDataDirectory(dir)).toBeUndefined();
    held?.close();
  });

  it("R04L-C2 and LKH-C4: a holder that keeps no reference, killed with SIGKILL leaves the file but not the lock", async () => {
    const dir = join(root, "d");
    const module = pathToFileURL(join(import.meta.dirname, "data-lock.ts")).href;
    const child = spawn(
      process.execPath,
      [
        "--expose-gc",
        "--input-type=module",
        "-e",
        // LKH-C4: the returned value is kept nowhere; gc() makes a lock that rides on the caller's reference fail deterministically.
        `import(${JSON.stringify(module)}).then((m) => { m.lockDataDirectory(${JSON.stringify(dir)}); globalThis.gc(); console.log("locked"); setInterval(() => {}, 1e6); });`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    holder = child;
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => reject(new Error("holder exited early")));
      child.stdout.on("data", (d: Buffer) => d.toString().includes("locked") && resolve());
    });
    expect(lockDataDirectory(dir)).toBeUndefined();
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
    expect(existsSync(join(dir, DATA_LOCK_FILE))).toBe(true);
    const again = lockDataDirectory(dir);
    expect(again).toBeDefined();
    again?.close();
  });

  // permission bits do not exist on Windows and root ignores them
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "LKH-C1: a read-only instance.lock throws; writable again it is taken",
    () => {
      const dir = join(root, "d");
      mkdirSync(dir);
      const file = join(dir, DATA_LOCK_FILE);
      writeFileSync(file, "");
      chmodSync(file, 0o444);
      expect(() => lockDataDirectory(dir)).toThrow();
      chmodSync(file, 0o644);
      const held = lockDataDirectory(dir);
      expect(held).toBeDefined();
      held?.close();
    },
  );
});
