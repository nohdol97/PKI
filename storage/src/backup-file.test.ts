// H01-C1b (R4, R5): the backup file hides the snapshot, gives it back byte for byte to the right passphrase,
// and answers a wrong passphrase, a changed byte, a cut end or a foreign format with its own code. Real files.
import { mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BackupFileError,
  DEFAULT_SCRYPT,
  decryptSnapshot,
  openBackup,
  openManifest,
  readBackupHeader,
  writeBackupFile,
  type BackupFileErrorCode,
} from "./backup-file.ts";

const PASSPHRASE = "correct horse battery staple";
const FAST = { N: 1024, r: 8, p: 1 };
const CANARY = "CANARY-본문-7f3a91";

let dir: string;
let snapshot: string;
let bytes: Buffer;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-backup-file-"));
  snapshot = join(dir, "snapshot.sqlite");
  // a header the way SQLite writes one, the canary in the body, three chunks long
  bytes = Buffer.concat([
    Buffer.from("SQLite format 3\0"),
    Buffer.from(CANARY),
    Buffer.alloc(2500, 7),
  ]);
  writeFileSync(snapshot, bytes);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (name = "b.pkibak", passphrase = PASSPHRASE) => {
  const path = join(dir, name);
  writeBackupFile(path, {
    passphrase,
    createdAt: "2026-11-23T00:00:00.000Z",
    schemaVersion: 32,
    manifest: { backupId: "id-1", note: "한글" },
    snapshotPath: snapshot,
    scrypt: FAST,
    chunkBytes: 1024,
  });
  return path;
};
const codeOf = (fn: () => unknown): BackupFileErrorCode | "no-error" => {
  try {
    fn();
  } catch (error) {
    if (error instanceof BackupFileError) return error.code;
    throw error;
  }
  return "no-error";
};
const flip = (path: string, at: number) => {
  const file = readFileSync(path);
  file[at] = (file[at] as number) ^ 0x01;
  writeFileSync(path, file);
};
const out = () => join(dir, "out.sqlite");

describe("backup file", () => {
  it("shows no SQLite header and no body text, and gives the snapshot back byte for byte", () => {
    const path = write();
    const file = readFileSync(path);
    expect(file.includes("SQLite format 3")).toBe(false);
    expect(file.includes(CANARY)).toBe(false);
    expect(readBackupHeader(path)).toMatchObject({
      format: 1,
      createdAt: "2026-11-23T00:00:00.000Z",
      schemaVersion: 32,
      scrypt: FAST,
    });
    const done = decryptSnapshot(path, PASSPHRASE, out());
    expect(readFileSync(out()).equals(bytes)).toBe(true);
    expect(done.bytes).toBe(bytes.length);
    expect(done.manifest).toEqual({ backupId: "id-1", note: "한글" });
    expect(openManifest(path, PASSPHRASE).manifest).toEqual(done.manifest);
  });

  it("uses the product's scrypt cost by default and still reads it back", () => {
    const path = join(dir, "d.pkibak");
    writeBackupFile(path, {
      passphrase: PASSPHRASE,
      createdAt: "2026-11-23T00:00:00.000Z",
      schemaVersion: 32,
      manifest: {},
      snapshotPath: snapshot,
    });
    expect(readBackupHeader(path).scrypt).toEqual(DEFAULT_SCRYPT);
    decryptSnapshot(path, PASSPHRASE, out());
    expect(readFileSync(out()).equals(bytes)).toBe(true);
  });

  it("a wrong passphrase is wrong-passphrase and leaves no plaintext", () => {
    const path = write();
    expect(codeOf(() => decryptSnapshot(path, "another passphrase!!", out()))).toBe(
      "wrong-passphrase",
    );
    expect(codeOf(() => openManifest(path, "another passphrase!!"))).toBe("wrong-passphrase");
    expect(() => statSync(out())).toThrow();
  });

  it("a changed byte in any chunk, in the header body, or a cut end is damaged, and no plaintext stays", () => {
    const size = statSync(write()).size;
    // the manifest chunk, a middle chunk, the last chunk's tag
    for (const at of [Math.floor(size * 0.12), Math.floor(size / 2), size - 3]) {
      const path = write(`flip-${at}.pkibak`);
      flip(path, at);
      expect(
        codeOf(() => decryptSnapshot(path, PASSPHRASE, out())),
        `byte ${at}`,
      ).toBe("damaged");
      expect(() => statSync(out())).toThrow();
    }
    // a cut inside a chunk, and one exactly at a chunk boundary (the last-chunk mark is then missing)
    const inside = write("cut-inside.pkibak");
    truncateSync(inside, size - 10);
    expect(codeOf(() => decryptSnapshot(inside, PASSPHRASE, out()))).toBe("damaged");
    const whole = readFileSync(write("cut-boundary.pkibak"));
    const lastChunk = 4 + 12 + 16 + (bytes.length % 1024 || 1024); // length + iv + tag + plaintext
    const boundary = join(dir, "cut-boundary2.pkibak");
    writeFileSync(boundary, whole.subarray(0, whole.length - lastChunk));
    expect(codeOf(() => decryptSnapshot(boundary, PASSPHRASE, out()))).toBe("damaged");
    expect(() => statSync(out())).toThrow();
  });

  it("a file that is no backup, or of another format version, is unsupported-format", () => {
    const text = join(dir, "text.pkibak");
    writeFileSync(text, "just some text, long enough to have a header");
    expect(codeOf(() => readBackupHeader(text))).toBe("unsupported-format");
    const path = write();
    const file = readFileSync(path);
    const header = JSON.parse(file.subarray(12, 12 + file.readUInt32BE(8)).toString("utf8"));
    const newer = Buffer.from(JSON.stringify({ ...header, format: 2 }));
    const lenField = Buffer.alloc(4);
    lenField.writeUInt32BE(newer.length);
    const rest = file.subarray(12 + file.readUInt32BE(8));
    const forged = join(dir, "forged.pkibak");
    writeFileSync(forged, Buffer.concat([file.subarray(0, 8), lenField, newer, rest]));
    expect(codeOf(() => decryptSnapshot(forged, PASSPHRASE, out()))).toBe("unsupported-format");
  });

  it("H01F-C3: a header whose scrypt cost is over the read bound, or that carries an extra key, is damaged before scrypt runs; a default-cost file reads", () => {
    const path = write();
    const file = readFileSync(path);
    const header = JSON.parse(file.subarray(12, 12 + file.readUInt32BE(8)).toString("utf8"));
    const forge = (name: string, scrypt: unknown) => {
      const bytes = Buffer.from(JSON.stringify({ ...header, scrypt }));
      const lenField = Buffer.alloc(4);
      lenField.writeUInt32BE(bytes.length);
      const forged = join(dir, name);
      writeFileSync(
        forged,
        Buffer.concat([
          file.subarray(0, 8),
          lenField,
          bytes,
          file.subarray(12 + file.readUInt32BE(8)),
        ]),
      );
      return forged;
    };
    const huge = forge("huge.pkibak", { N: 2 ** 20, r: 8, p: 1 });
    const extra = forge("extra.pkibak", { ...FAST, cost: 5 });
    for (const forged of [huge, extra]) {
      expect(codeOf(() => readBackupHeader(forged))).toBe("damaged");
      expect(codeOf(() => openBackup(forged, PASSPHRASE))).toBe("damaged");
    }
    const product = join(dir, "product.pkibak");
    writeBackupFile(product, {
      passphrase: PASSPHRASE,
      createdAt: "2026-11-23T00:00:00.000Z",
      schemaVersion: 32,
      manifest: {},
      snapshotPath: snapshot,
      scrypt: DEFAULT_SCRYPT,
    });
    expect(readBackupHeader(product).scrypt).toEqual(DEFAULT_SCRYPT);
  });

  it("refuses a short passphrase and a name that exists, and never puts the passphrase in an error", () => {
    expect(codeOf(() => write("short.pkibak", "too short"))).toBe("weak-passphrase");
    const path = write();
    const secret = "never-print-this-passphrase-value";
    let message = "";
    try {
      writeBackupFile(path, {
        passphrase: secret,
        createdAt: "2026-11-23T00:00:00.000Z",
        schemaVersion: 32,
        manifest: {},
        snapshotPath: snapshot,
        scrypt: FAST,
      });
    } catch (error) {
      message = `${(error as Error).name} ${(error as Error).message} ${(error as Error).stack}`;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(secret);
    // the file that was there is untouched (nothing overwritten)
    decryptSnapshot(path, PASSPHRASE, out());
  });
});
