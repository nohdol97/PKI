// The backup file (H01-R4, R5): a snapshot of the canonical database and its manifest, encrypted with a key
// scrypt makes from the user's passphrase. `node:crypto` only. Layout:
//   magic (8) | header length (u32) | header (JSON, plain) | chunk*
// where a chunk is  payload length (u32) | iv (12) | AES-256-GCM ciphertext and tag.
// Chunk 0 holds the manifest, the rest the snapshot in CHUNK_BYTES pieces. Each chunk's additional
// authenticated data is the SHA-256 of the header bytes, the chunk number and a last-chunk mark, so a changed
// header, a cut end, a swapped or dropped chunk fails authentication. The passphrase and the key live in a
// call's locals only; no error carries them (the messages are the codes).
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { closeSync, fstatSync, fsyncSync, openSync, readSync, rmSync, writeSync } from "node:fs";

export const BACKUP_FORMAT = 1;
export const BACKUP_EXTENSION = ".pkibak";
export const MIN_PASSPHRASE_LENGTH = 12;
/** Plain bytes of the snapshot per chunk (H01-D5). */
export const CHUNK_BYTES = 1024 * 1024;
export const DEFAULT_SCRYPT: ScryptCost = { N: 2 ** 17, r: 8, p: 1 };

const MAGIC = Buffer.from("PKIBAK\0\u0001", "latin1");
const MAX_HEADER_BYTES = 4096;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_CHECK_LABEL = "pki-backup-key-check-v1";
/** A header's cost values are read from the file: bounded so a forged one cannot ask for gigabytes. */
const MAX_SCRYPT_MEMORY = 1024 ** 3;

export interface ScryptCost {
  N: number;
  r: number;
  p: number;
}

export type BackupFileErrorCode =
  "wrong-passphrase" | "damaged" | "unsupported-format" | "weak-passphrase";

export class BackupFileError extends Error {
  readonly code: BackupFileErrorCode;
  constructor(code: BackupFileErrorCode) {
    super(code);
    this.name = "BackupFileError";
    this.code = code;
  }
}

/** The plain part of the file: nothing of the content. */
export interface BackupHeader {
  format: number;
  createdAt: string;
  schemaVersion: number;
  scrypt: ScryptCost;
  salt: string;
  keyCheck: string;
}

export interface WriteBackupInput {
  passphrase: string;
  createdAt: string;
  schemaVersion: number;
  manifest: unknown;
  snapshotPath: string;
  /** Tests lower the cost; the product uses DEFAULT_SCRYPT. */
  scrypt?: ScryptCost;
  chunkBytes?: number;
}

const damaged = () => new BackupFileError("damaged");

function costOk(cost: ScryptCost): boolean {
  const { N, r, p } = cost;
  if (![N, r, p].every(Number.isInteger)) return false;
  if (N < 2 ** 10 || N > 2 ** 20 || (N & (N - 1)) !== 0) return false;
  if (r < 1 || r > 16 || p < 1 || p > 16) return false;
  return 128 * N * r <= MAX_SCRYPT_MEMORY;
}

function deriveKey(passphrase: string, salt: Buffer, cost: ScryptCost): Buffer {
  return scryptSync(passphrase.normalize("NFKC"), salt, 32, {
    ...cost,
    maxmem: 128 * cost.N * cost.r + 128 * cost.r * cost.p + 16 * 1024 * 1024,
  });
}

const keyCheckOf = (key: Buffer): string =>
  createHmac("sha256", key).update(KEY_CHECK_LABEL).digest("hex");

const aad = (headerHash: Buffer, index: number, last: boolean): Buffer => {
  const tail = Buffer.alloc(5);
  tail.writeUInt32BE(index, 0);
  tail.writeUInt8(last ? 1 : 0, 4);
  return Buffer.concat([headerHash, tail]);
};

function seal(key: Buffer, headerHash: Buffer, index: number, last: boolean, plain: Buffer) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(headerHash, index, last));
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(IV_BYTES + body.length);
  return Buffer.concat([length, iv, body]);
}

function open(key: Buffer, headerHash: Buffer, index: number, last: boolean, payload: Buffer) {
  if (payload.length < IV_BYTES + TAG_BYTES) throw damaged();
  const decipher = createDecipheriv("aes-256-gcm", key, payload.subarray(0, IV_BYTES));
  decipher.setAAD(aad(headerHash, index, last));
  decipher.setAuthTag(payload.subarray(payload.length - TAG_BYTES));
  try {
    return Buffer.concat([
      decipher.update(payload.subarray(IV_BYTES, payload.length - TAG_BYTES)),
      decipher.final(),
    ]);
  } catch {
    throw damaged();
  }
}

/** Reads exactly `length` bytes at `position`, or throws damaged when the file ends first. */
function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buffer, done, length - done, position + done);
    if (n === 0) throw damaged();
    done += n;
  }
  return buffer;
}

/** The header and where the chunks begin; unsupported-format for a file that is not ours or of another version. */
function readHeader(fd: number): { header: BackupHeader; hash: Buffer; chunksAt: number } {
  const size = fstatSync(fd).size;
  if (size < MAGIC.length + 4) throw new BackupFileError("unsupported-format");
  if (!readAt(fd, 0, MAGIC.length).equals(MAGIC)) throw new BackupFileError("unsupported-format");
  const length = readAt(fd, MAGIC.length, 4).readUInt32BE(0);
  if (length === 0 || length > MAX_HEADER_BYTES) throw new BackupFileError("unsupported-format");
  const bytes = readAt(fd, MAGIC.length + 4, length);
  let header: BackupHeader;
  try {
    header = JSON.parse(bytes.toString("utf8")) as BackupHeader;
  } catch {
    throw new BackupFileError("unsupported-format");
  }
  if (typeof header !== "object" || header === null || header.format !== BACKUP_FORMAT) {
    throw new BackupFileError("unsupported-format");
  }
  const { createdAt, schemaVersion, scrypt, salt, keyCheck } = header;
  const shaped =
    typeof createdAt === "string" &&
    Number.isInteger(schemaVersion) &&
    typeof salt === "string" &&
    typeof keyCheck === "string" &&
    typeof scrypt === "object" &&
    scrypt !== null &&
    costOk(scrypt);
  if (!shaped) throw damaged();
  return {
    header,
    hash: createHash("sha256").update(bytes).digest(),
    chunksAt: MAGIC.length + 4 + length,
  };
}

/** The key for a file's header, or wrong-passphrase when the check value does not match. */
function keyFor(header: BackupHeader, passphrase: string): Buffer {
  const key = deriveKey(passphrase, Buffer.from(header.salt, "base64"), header.scrypt);
  const given = Buffer.from(header.keyCheck, "hex");
  const expected = Buffer.from(keyCheckOf(key), "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new BackupFileError("wrong-passphrase");
  }
  return key;
}

/** The header of a backup file, readable without the passphrase (the list of a folder shows it). */
export function readBackupHeader(path: string): BackupHeader {
  const fd = openSync(path, "r");
  try {
    return readHeader(fd).header;
  } finally {
    closeSync(fd);
  }
}

/**
 * Writes the file at `path` (a name that exists is not overwritten) from the manifest and the snapshot,
 * then fsyncs it. A failure removes what it wrote.
 */
export function writeBackupFile(path: string, input: WriteBackupInput): void {
  if (input.passphrase.length < MIN_PASSPHRASE_LENGTH) throw new BackupFileError("weak-passphrase");
  const cost = input.scrypt ?? DEFAULT_SCRYPT;
  const chunkBytes = input.chunkBytes ?? CHUNK_BYTES;
  const salt = randomBytes(16);
  const key = deriveKey(input.passphrase, salt, cost);
  const header: BackupHeader = {
    format: BACKUP_FORMAT,
    createdAt: input.createdAt,
    schemaVersion: input.schemaVersion,
    scrypt: cost,
    salt: salt.toString("base64"),
    keyCheck: keyCheckOf(key),
  };
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const hash = createHash("sha256").update(headerBytes).digest();
  const source = openSync(input.snapshotPath, "r");
  let target: number | undefined;
  try {
    const total = fstatSync(source).size;
    if (total === 0) throw damaged();
    target = openSync(path, "wx", 0o600);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(headerBytes.length);
    writeSync(target, Buffer.concat([MAGIC, length, headerBytes]));
    writeSync(target, seal(key, hash, 0, false, Buffer.from(JSON.stringify(input.manifest))));
    const chunks = Math.ceil(total / chunkBytes);
    for (let i = 0; i < chunks; i++) {
      const plain = readAt(source, i * chunkBytes, Math.min(chunkBytes, total - i * chunkBytes));
      writeSync(target, seal(key, hash, i + 1, i === chunks - 1, plain));
    }
    fsyncSync(target);
  } catch (error) {
    if (target !== undefined) {
      closeSync(target);
      target = undefined;
      rmSync(path, { force: true });
    }
    throw error;
  } finally {
    if (target !== undefined) closeSync(target);
    closeSync(source);
  }
}

/** Reads the next chunk record at `at`; the payload and where the next record begins. */
function nextRecord(fd: number, at: number): { payload: Buffer; end: number } {
  const length = readAt(fd, at, 4).readUInt32BE(0);
  if (length < IV_BYTES + TAG_BYTES || length > CHUNK_BYTES * 16 + IV_BYTES + TAG_BYTES) {
    throw damaged();
  }
  return { payload: readAt(fd, at + 4, length), end: at + 4 + length };
}

/** Only the manifest chunk, for a look at a file (R8). */
export function openManifest(
  path: string,
  passphrase: string,
): { header: BackupHeader; manifest: unknown } {
  const fd = openSync(path, "r");
  try {
    const { header, hash, chunksAt } = readHeader(fd);
    const key = keyFor(header, passphrase);
    const plain = open(key, hash, 0, false, nextRecord(fd, chunksAt).payload);
    return { header, manifest: parseJson(plain) };
  } finally {
    closeSync(fd);
  }
}

function parseJson(plain: Buffer): unknown {
  try {
    return JSON.parse(plain.toString("utf8"));
  } catch {
    throw damaged();
  }
}

/**
 * Decrypts the whole snapshot to `outPath` (a new file, mode 0600), checking every chunk, the last-chunk mark
 * and the end of the file. Returns the manifest, the bytes written and their SHA-256. On any failure the
 * partial output is removed.
 */
export function decryptSnapshot(
  path: string,
  passphrase: string,
  outPath: string,
): { header: BackupHeader; manifest: unknown; bytes: number; sha256: string } {
  const fd = openSync(path, "r");
  let out: number | undefined;
  try {
    const { header, hash, chunksAt } = readHeader(fd);
    const key = keyFor(header, passphrase);
    const size = fstatSync(fd).size;
    const first = nextRecord(fd, chunksAt);
    const manifest = parseJson(open(key, hash, 0, false, first.payload));
    out = openSync(outPath, "w", 0o600);
    const digest = createHash("sha256");
    let bytes = 0;
    let at = first.end;
    for (let index = 1; ; index++) {
      if (at >= size) throw damaged(); // the last-chunk mark never came: the end was cut
      const record = nextRecord(fd, at);
      at = record.end;
      const last = at === size;
      const plain = open(key, hash, index, last, record.payload);
      writeSync(out, plain);
      digest.update(plain);
      bytes += plain.length;
      if (last) break;
    }
    fsyncSync(out);
    return { header, manifest, bytes, sha256: digest.digest("hex") };
  } catch (error) {
    if (out !== undefined) {
      closeSync(out);
      out = undefined;
      rmSync(outPath, { force: true });
    }
    throw error;
  } finally {
    if (out !== undefined) closeSync(out);
    closeSync(fd);
  }
}
