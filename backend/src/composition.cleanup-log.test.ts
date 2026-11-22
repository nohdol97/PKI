// I04-R6 (I04-T07): a one-time clean-up that cannot finish does not stop the start,
// and the start logs it by event name only (no path, no identifier).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@pki/storage", async (original) => ({
  ...(await original<typeof import("@pki/storage")>()),
  prepareCanonicalDb: () => ({ legacyCleanup: "failed" }),
}));

import { openCanonicalDb } from "./composition.ts";

let root: string;
beforeEach(() => void (root = mkdtempSync(join(tmpdir(), "pki-cleanup-log-"))));
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("openCanonicalDb: legacy clean-up failure", () => {
  it("logs legacy-cleanup-failed once, with nothing about the data directory, and still returns the database", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const dir = join(root, "secret-dir-name");
    const db = openCanonicalDb(dir);
    db.close();
    expect(logged).toHaveBeenCalledTimes(1);
    const line = String(logged.mock.calls[0]?.[0]);
    expect(line).toContain("legacy-cleanup-failed");
    expect(line).not.toContain("secret-dir-name");
  });
});
