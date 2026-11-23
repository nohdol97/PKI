// R04L-C1, C2: the data-folder lock (spec 2026-11-23-R04-data-dir-lock). Real temp folders.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_LOCK_FILE, lockDataDirectory } from "./data-lock.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pki-data-lock-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("lockDataDirectory", () => {
  it("R04L-C1: creates a missing folder, and a held lock makes the next attempt return undefined", () => {
    const dir = join(root, "d");
    const held = lockDataDirectory(dir);
    expect(held).toBeDefined();
    expect(existsSync(dir)).toBe(true);
    expect(lockDataDirectory(dir)).toBeUndefined();
    held?.close();
  });

  it("R04L-C2: a holder killed with SIGKILL leaves the file but not the lock", async () => {
    const dir = join(root, "d");
    const module = pathToFileURL(join(import.meta.dirname, "data-lock.ts")).href;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import(${JSON.stringify(module)}).then((m) => { m.lockDataDirectory(${JSON.stringify(dir)}); console.log("locked"); setInterval(() => {}, 1e6); });`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
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
});
