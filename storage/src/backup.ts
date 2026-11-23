// Backup and restore preparation (H01-R1..R3, R7, R9, R10): a point-in-time copy of the canonical database made
// by `VACUUM INTO` through the driver, its manifest read from the copy, the encrypted file written beside a
// `.partial` name, and the staging of a file for the next start (checks first, nothing live touched).
// The swap itself is the backend's (restore-boot.ts), before the database is opened.
import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { EmbeddingSpace } from "@pki/contracts";
import {
  BACKUP_EXTENSION,
  BACKUP_FORMAT,
  BackupFileError,
  MIN_PASSPHRASE_LENGTH,
  openBackup,
  type OpenedBackup,
  readBackupHeader,
  writeBackupFile,
  type ScryptCost,
} from "./backup-file.ts";
import { readLedgerSeq } from "./canonical-transaction.ts";
import { readKey } from "./identity.ts";
import { migrate, migrations, schemaVersion } from "./migrations.ts";
import { readChangeSeq } from "./revisions.ts";
import type { OpenSqlDriver, SqlDriver } from "./sql-driver.ts";

/** The folder the user chose for backup files (H01-R7). */
export const BACKUP_FOLDER_SETTING = "backup.folder";
/** The result of the last applied restore (H01-R12). */
export const RESTORE_LAST_SETTING = "restore.last";
/** Plain snapshots live here for the time of one backup; a start removes what a crash left. */
export const BACKUP_TMP_DIR = "backup-tmp";
export const RESTORE_DIR = "restore";
export const STAGED_FILE = "staged.sqlite";
export const PENDING_FILE = "pending.json";
export const BEFORE_RESTORE_FILE = "pki.sqlite.before-restore";

export interface BackupCounts {
  sources: number;
  sourceVersions: number;
  items: number;
  facts: number;
  relations: number;
  evidence: number;
  openJobs: number;
  schedules: number;
  feedback: number;
  tombstones: number;
}

export interface SnapshotFacts {
  schemaVersion: number;
  changeSeq: number;
  ledgerSeq: number;
  counts: BackupCounts;
}

export interface BackupManifest extends SnapshotFacts {
  backupId: string;
  createdAt: string;
  formatVersion: number;
  snapshotBytes: number;
  snapshotSha256: string;
  embeddingSpace: EmbeddingSpace | null;
  vectorIndexSeq: number | null;
  /** Names the installation the snapshot came from without carrying its identity key (R8); null for a keyless schema. */
  installation: string | null;
}

export class BackupExistsError extends Error {
  constructor() {
    super("backup-exists");
    this.name = "BackupExistsError";
  }
}

const COUNTED: Record<keyof BackupCounts, string> = {
  sources: "SELECT count(*) AS n FROM sources",
  sourceVersions: "SELECT count(*) AS n FROM source_versions",
  items: "SELECT count(*) AS n FROM items",
  facts: "SELECT count(*) AS n FROM facts",
  relations: "SELECT count(*) AS n FROM relations",
  evidence: "SELECT count(*) AS n FROM evidence",
  openJobs: "SELECT count(*) AS n FROM jobs WHERE status IN ('queued', 'running', 'retry', 'held')",
  schedules: "SELECT count(*) AS n FROM schedules",
  feedback: "SELECT count(*) AS n FROM feedback",
  tombstones: "SELECT count(*) AS n FROM tombstones",
};

const hasTable = (db: SqlDriver, name: string): boolean =>
  db.all("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?", [name]).length >
  0;

/** What a database file holds, read from the file itself: a table an older schema lacks counts as none. */
export function readSnapshotFacts(db: SqlDriver): SnapshotFacts {
  const counts = {} as BackupCounts;
  for (const [name, sql] of Object.entries(COUNTED)) {
    const table = /\bFROM (\w+)/.exec(sql)?.[1] as string;
    counts[name as keyof BackupCounts] = hasTable(db, table) ? Number(db.all(sql)[0]?.n ?? 0) : 0;
  }
  return {
    schemaVersion: schemaVersion(db),
    changeSeq: hasTable(db, "revisions") ? readChangeSeq(db) : 0,
    ledgerSeq: hasTable(db, "settings") ? readLedgerSeq(db) : 0,
    counts,
  };
}

/** A keyed digest of a fixed label: equal for one installation, no way back to the key. */
const keyOf = (db: SqlDriver) => (hasTable(db, "identity_key") ? readKey(db) : undefined);

export function installationFingerprint(db: SqlDriver): string | null {
  const key = keyOf(db);
  return key ? createHmac("sha256", key).update("pki-backup-installation-v1").digest("hex") : null;
}

const quote = (path: string) => `'${path.replaceAll("'", "''")}'`;

/** H01-R1: one point-in-time copy of the live database, outside a transaction. The caller removes it. */
export function createSnapshot(db: SqlDriver, dataDir: string): string {
  const dir = join(dataDir, BACKUP_TMP_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${randomUUID()}.sqlite`);
  db.exec(`VACUUM INTO ${quote(path)}`);
  return path;
}

const stamp = (now: Date) =>
  now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");

export function syncPath(path: string): void {
  try {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // a platform that cannot fsync a directory (Windows): a file's own sync is separate
  }
}

export interface CreateBackupInput {
  db: SqlDriver;
  open: OpenSqlDriver;
  dataDir: string;
  folder: string;
  passphrase: string;
  now: Date;
  /** The vector index's answers, which the storage layer does not hold (null while none is bound). */
  embeddingSpace: EmbeddingSpace | null;
  vectorIndexSeq: number | null;
  scrypt?: ScryptCost;
  chunkBytes?: number;
}

/**
 * H01-R1, R3, R4, R7: snapshot, manifest from the snapshot, encrypt to `<name>.partial`, fsync, rename. The
 * plaintext snapshot is removed whether it worked or not; a name that exists is not overwritten.
 */
export function createBackup(input: CreateBackupInput): {
  fileName: string;
  manifest: BackupManifest;
} {
  if (input.passphrase.length < MIN_PASSPHRASE_LENGTH) throw new BackupFileError("weak-passphrase");
  const snapshot = createSnapshot(input.db, input.dataDir);
  try {
    const copy = input.open(snapshot);
    let facts: SnapshotFacts;
    let installation: string | null;
    try {
      facts = readSnapshotFacts(copy);
      installation = installationFingerprint(copy);
    } finally {
      copy.close();
    }
    const bytes = readFileSync(snapshot);
    const manifest: BackupManifest = {
      backupId: randomUUID(),
      createdAt: input.now.toISOString(),
      formatVersion: BACKUP_FORMAT,
      ...facts,
      snapshotBytes: bytes.length,
      snapshotSha256: createHash("sha256").update(bytes).digest("hex"),
      embeddingSpace: input.embeddingSpace,
      vectorIndexSeq: input.vectorIndexSeq,
      installation,
    };
    const fileName = `pki-backup-${stamp(input.now)}${BACKUP_EXTENSION}`;
    const target = join(input.folder, fileName);
    if (existsSync(target)) throw new BackupExistsError();
    const partial = `${target}.partial`;
    rmSync(partial, { force: true });
    try {
      writeBackupFile(partial, {
        passphrase: input.passphrase,
        createdAt: manifest.createdAt,
        schemaVersion: manifest.schemaVersion,
        manifest,
        snapshotPath: snapshot,
        ...(input.scrypt && { scrypt: input.scrypt }),
        ...(input.chunkBytes && { chunkBytes: input.chunkBytes }),
      });
      renameSync(partial, target);
    } catch (error) {
      rmSync(partial, { force: true });
      throw error;
    }
    syncPath(input.folder);
    return { fileName, manifest };
  } finally {
    rmSync(snapshot, { force: true });
  }
}

export interface BackupListing {
  fileName: string;
  bytes: number;
  createdAt: string;
  schemaVersion: number;
}

/** The backup files of a folder by their plain headers; a file that is none is left out (H01-D12). */
export function listBackups(folder: string): BackupListing[] {
  const found: BackupListing[] = [];
  for (const fileName of readdirSync(folder)) {
    if (!fileName.endsWith(BACKUP_EXTENSION)) continue;
    try {
      const path = join(folder, fileName);
      const header = readBackupHeader(path);
      found.push({
        fileName,
        bytes: statSync(path).size,
        createdAt: header.createdAt,
        schemaVersion: header.schemaVersion,
      });
    } catch {
      // not a backup of this format: not listed
    }
  }
  return found.sort((a, b) => b.fileName.localeCompare(a.fileName));
}

// --- the marker (H01-R9, R11, R13) --------------------------------------------------------------------

export interface RestoreSummary {
  backupId: string;
  backupCreatedAt: string;
  stagedAt: string;
  backupSchemaVersion: number;
  counts: BackupCounts;
  embeddingSpace: EmbeddingSpace | null;
}

/**
 * `rolling-back` is the step between a swap that has to be undone and the `failed` mark: a start that is cut
 * off while undoing it finds the mark and finishes the undoing (H01-R13).
 */
export type RestoreMarker =
  | ({ state: "staged" } & RestoreSummary)
  | ({ state: "swapped" } & RestoreSummary)
  | { state: "failed"; code: string }
  | { state: "rolling-back"; code: string };

export function readPending(dataDir: string): RestoreMarker | undefined {
  try {
    const marker = JSON.parse(
      readFileSync(join(dataDir, RESTORE_DIR, PENDING_FILE), "utf8"),
    ) as RestoreMarker;
    return ["staged", "swapped", "failed", "rolling-back"].includes(marker?.state)
      ? marker
      : undefined;
  } catch {
    return undefined;
  }
}

/** Written to a temporary name, synced, then renamed: a reader sees the old marker or the new one whole. */
export function writePending(dataDir: string, marker: RestoreMarker): void {
  const dir = join(dataDir, RESTORE_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = join(dir, `${PENDING_FILE}.tmp`);
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(marker));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, join(dir, PENDING_FILE));
  syncPath(dir);
}

/** H01-R10: the staged file and the marker go (also what a failed staging and the start's clean-up do). */
export function removeRestoreArtifacts(dataDir: string): void {
  rmSync(join(dataDir, RESTORE_DIR), { recursive: true, force: true });
}

export function removeBackupTmp(dataDir: string): void {
  rmSync(join(dataDir, BACKUP_TMP_DIR), { recursive: true, force: true });
}

// --- staging (H01-R9) ----------------------------------------------------------------------------------

export type RestoreRefusal =
  | "wrong-passphrase"
  | "damaged"
  | "unsupported-format"
  | "confirm-mismatch"
  | "newer-schema"
  | "other-installation"
  | "migration-failed"
  | "foreign-schema"
  | "already-pending";

export type StageResult =
  { status: "staged"; summary: RestoreSummary } | { status: "refused"; code: RestoreRefusal };

export interface StageInput {
  /** The live database: read for the installation check, never written. */
  db: SqlDriver;
  open: OpenSqlDriver;
  dataDir: string;
  file: string;
  passphrase: string;
  /** The `backupId` the user saw when looking at the file (H01-R9). */
  confirmBackupId: string;
  now: Date;
}

function asManifest(value: unknown): BackupManifest {
  const m = value as Partial<BackupManifest> | null;
  const ok =
    typeof m === "object" &&
    m !== null &&
    typeof m.backupId === "string" &&
    typeof m.createdAt === "string" &&
    Number.isInteger(m.schemaVersion) &&
    Number.isInteger(m.snapshotBytes) &&
    typeof m.snapshotSha256 === "string" &&
    typeof m.counts === "object" &&
    m.counts !== null &&
    (m.embeddingSpace === null || typeof m.embeddingSpace === "object");
  if (!ok) throw new BackupFileError("damaged");
  return m as BackupManifest;
}

/** The manifest chunk of a file, checked for its shape; the codes of an unreadable file as `BackupFileError`. */
export function readBackupManifest(file: string, passphrase: string): BackupManifest {
  return asManifest(openBackup(file, passphrase).manifest);
}

type SchemaRow = string;

/** The schema objects of a database as comparable lines: type, name, table and the exact SQL text. */
function schemaLines(db: SqlDriver): SchemaRow[] {
  return db
    .all(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
    )
    .map((r) => JSON.stringify([r.type, r.name, r.tbl_name, r.sql]))
    .sort();
}

let referenceSchema: SchemaRow[] | undefined;

/**
 * What the migrations of this build make, from a fresh in-memory database. A genuine backup, taken at this
 * schema or taken at an older one and lifted by the same migrations, has exactly these objects with the same
 * SQL text (an older file went through the same earlier steps, so even an `ALTER TABLE` rewrites the same way).
 */
function reference(open: OpenSqlDriver): SchemaRow[] {
  if (referenceSchema) return referenceSchema;
  const db = open(":memory:");
  try {
    migrate(db);
    referenceSchema = schemaLines(db);
  } finally {
    db.close();
  }
  return referenceSchema;
}

const refused = (code: RestoreRefusal): StageResult => ({ status: "refused", code });

/**
 * Unpacks and checks the file into `restore/staged.sqlite`, then writes the marker. Any refusal removes
 * `restore/` and answers its code; the live database is only read.
 */
export function stageRestore(input: StageInput): StageResult {
  const { dataDir } = input;
  const existing = readPending(dataDir);
  if (existing && existing.state !== "failed") return refused("already-pending");
  let manifest: BackupManifest;
  let opened: OpenedBackup;
  try {
    opened = openBackup(input.file, input.passphrase);
    manifest = asManifest(opened.manifest);
  } catch (error) {
    if (error instanceof BackupFileError && error.code !== "weak-passphrase") {
      return refused(error.code);
    }
    throw error;
  }
  if (manifest.backupId !== input.confirmBackupId) return refused("confirm-mismatch");

  removeRestoreArtifacts(dataDir);
  const dir = join(dataDir, RESTORE_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stagedPath = join(dir, STAGED_FILE);
  try {
    const verdict = checkAndLift(input, opened, manifest, stagedPath);
    if (verdict) {
      removeRestoreArtifacts(dataDir);
      return refused(verdict);
    }
    syncPath(stagedPath);
    const summary: RestoreSummary = {
      backupId: manifest.backupId,
      backupCreatedAt: manifest.createdAt,
      stagedAt: input.now.toISOString(),
      backupSchemaVersion: manifest.schemaVersion,
      counts: manifest.counts,
      embeddingSpace: manifest.embeddingSpace ?? null,
    };
    writePending(dataDir, { state: "staged", ...summary });
    return { status: "staged", summary };
  } catch (error) {
    removeRestoreArtifacts(dataDir);
    if (error instanceof BackupFileError && error.code !== "weak-passphrase") {
      return refused(error.code);
    }
    throw error;
  }
}

/** The checks of R9 in order on the unpacked file; the code of the first that fails, or undefined. */
function checkAndLift(
  input: StageInput,
  opened: OpenedBackup,
  manifest: BackupManifest,
  stagedPath: string,
): RestoreRefusal | undefined {
  // ① every chunk's authentication, the byte count and the SHA-256
  const done = opened.extract(stagedPath);
  if (done.bytes !== manifest.snapshotBytes || done.sha256 !== manifest.snapshotSha256) {
    return "damaged";
  }
  let staged: SqlDriver;
  try {
    staged = input.open(stagedPath);
  } catch {
    return "damaged";
  }
  try {
    // ② the file is a database that holds together
    const integrity = staged.all("PRAGMA integrity_check");
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") return "damaged";
    if (staged.all("PRAGMA foreign_key_check").length > 0) return "damaged";
    // ③ a schema this build does not know
    if (schemaVersion(staged) > migrations.length) return "newer-schema";
    // ④ another installation's data over one that holds sources or deletions (H01-D8)
    const theirs = keyOf(staged);
    const mine = keyOf(input.db);
    const differs =
      theirs !== undefined && (mine === undefined || Buffer.compare(theirs, mine) !== 0);
    if (differs) {
      const held = readSnapshotFacts(input.db).counts;
      if (held.sources > 0 || held.tombstones > 0) return "other-installation";
    }
    // ⑤ an older schema is lifted here, on the staged copy
    if (schemaVersion(staged) < migrations.length) {
      try {
        migrate(staged);
      } catch {
        return "migration-failed";
      }
    }
    // ⑥ the staged file holds the schema this build makes and nothing else: a trigger, view or changed table
    // a snapshot carries would run in the live database (it could undo the finish's clearing, or swallow deletes)
    const expected = reference(input.open);
    const found = schemaLines(staged);
    if (found.length !== expected.length || found.some((line, i) => line !== expected[i])) {
      return "foreign-schema";
    }
    return undefined;
  } finally {
    staged.close();
  }
}
