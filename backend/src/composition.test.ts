// V01-R6/R7 composition: the canonical DB opens inside the per-user data
// directory, created owner-only first, at the latest schema; the site
// Connector kinds are registered and fail with the follow-up notice.
import { CONNECTOR_NOT_IMPLEMENTED } from "@pki/contracts";
import { migrations, schemaVersion } from "@pki/storage";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CANONICAL_DB_FILE, connectorKinds, openCanonicalDb } from "./composition.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pki-compose-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("openCanonicalDb", () => {
  it("creates the data directory, then the migrated canonical file inside it", () => {
    const dir = join(root, "nested", "PKI");
    const db = openCanonicalDb(dir);
    try {
      expect(existsSync(join(dir, CANONICAL_DB_FILE))).toBe(true);
      expect(schemaVersion(db)).toBe(migrations.length);
      if (process.platform !== "win32") expect(statSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      db.close();
    }
  });
});

describe("site Connector kinds", () => {
  it.each(["site-mail", "site-messenger", "site-wiki"] as const)(
    "%s is registered and fails to initialize with the notice",
    async (kind) => {
      const connector = connectorKinds[kind]();
      expect(connector.manifest.type).toBe(kind);
      await expect(connector.initialize({})).rejects.toThrow(CONNECTOR_NOT_IMPLEMENTED);
      await expect(connector.healthCheck()).resolves.toEqual({
        state: "unavailable",
        reason: CONNECTOR_NOT_IMPLEMENTED,
      });
    },
  );
});
