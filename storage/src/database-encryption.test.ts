// V01-R13 display (ADR 0010): the encryption state shown in Settings is read from
// the canonical file itself. A plain SQLite file starts with the SQLite header;
// anything else (an encrypted file, a missing one, an in-memory DB) is not claimed.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { databaseEncryption } from "./database-encryption.ts";
import { migrate } from "./migrations.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-enc-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("databaseEncryption", () => {
  it("reports a plain SQLite file as not encrypted", () => {
    const file = join(dir, "pki.sqlite");
    const db = openBetterSqlite3(file);
    migrate(db);
    db.close();
    expect(databaseEncryption(file)).toBe("not-applied");
  });

  it("does not claim anything for a file without the SQLite header, a missing file or none", () => {
    const scrambled = join(dir, "enc.sqlite");
    writeFileSync(scrambled, Buffer.alloc(4096, 0x5a));
    expect(databaseEncryption(scrambled)).toBe("unknown");
    expect(databaseEncryption(join(dir, "missing.sqlite"))).toBe("unknown");
    expect(databaseEncryption(undefined)).toBe("unknown");
  });
});
