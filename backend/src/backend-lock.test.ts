// LKH-C3: the backend lock is only obtained when the lock file can be written (spec 2026-11-24-LKH-lock-hardening).
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BACKEND_LOCK_FILE, takeBackendLock } from "./backend-lock.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-backend-lock-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// permission bits do not exist on Windows and root ignores them
it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "LKH-C3: a read-only backend.lock is not obtained; writable again it is",
  () => {
    const file = join(dir, BACKEND_LOCK_FILE);
    writeFileSync(file, "");
    chmodSync(file, 0o444);
    expect(takeBackendLock(dir)).toBeUndefined();
    chmodSync(file, 0o644);
    const lock = takeBackendLock(dir);
    expect(lock).toBeDefined();
    lock?.close();
  },
);
