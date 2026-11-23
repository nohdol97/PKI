// The handlers of the six backup and restore routes (H01-R15). A passphrase lives in the call that carries it:
// it is handed to the storage functions and never to a log line, a setting, a job row or an answer; a failure is
// logged by its class only. The folder is chosen like a location (a picker's one-time ticket; a typed path
// only where the build has an input field for it, I02B-R37) and kept in the setting `backup.folder`.
import type { RouteRequest, RouteResponse, VectorIndex } from "@pki/contracts";
import { errorClass, log, type BuildKind } from "@pki/providers";
import {
  BACKUP_EXTENSION,
  BACKUP_FOLDER_SETTING,
  BackupExistsError,
  BackupFileError,
  MIN_PASSPHRASE_LENGTH,
  createBackup,
  installationFingerprint,
  listBackups,
  readBackupManifest,
  readPending,
  RestoreMarkerError,
  readSetting,
  removeRestoreArtifacts,
  schemaVersion,
  stageRestore,
  writeSetting,
  type BackupManifest,
  type OpenSqlDriver,
  type RestoreSummary,
  type ScryptCost,
  type SqlDriver,
} from "@pki/storage";
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import type { ApprovalTickets } from "./local-locations.ts";
import { readIndexFacts, readRestoreLast } from "./restore-boot.ts";

export interface BackupApiOptions {
  db: SqlDriver;
  dataDir: string;
  /** Opens a SQLite file (the composition point's driver): the snapshot's facts and the staged file's checks. */
  open: OpenSqlDriver;
  vectorIndex: Pick<VectorIndex, "embeddingSpace" | "appliedChangeSeq">;
  tickets: ApprovalTickets;
  /** Read from the build, never from a request. */
  buildKind: BuildKind;
  now?: () => number;
  /** A test build's lower scrypt cost for the files it makes; the product's cost otherwise (H01-D5). */
  scrypt?: ScryptCost;
}

type Answer<
  Name extends
    | "backupStatus"
    | "setBackupFolder"
    | "createBackup"
    | "inspectRestore"
    | "restoreBackup"
    | "cancelRestore",
> = RouteResponse<Name>;

export interface BackupApi {
  status(): Answer<"backupStatus">;
  setFolder(request: RouteRequest<"setBackupFolder">): Answer<"setBackupFolder">;
  create(request: RouteRequest<"createBackup">): Promise<Answer<"createBackup">>;
  inspect(request: RouteRequest<"inspectRestore">): Promise<Answer<"inspectRestore">>;
  restore(request: RouteRequest<"restoreBackup">): Promise<Answer<"restoreBackup">>;
  cancel(): Answer<"cancelRestore">;
}

const summaryOf = (m: BackupManifest) => ({
  backupId: m.backupId,
  createdAt: m.createdAt,
  schemaVersion: m.schemaVersion,
  counts: m.counts,
  embeddingSpace: m.embeddingSpace ?? null,
});

const stagedSummaryOf = (s: RestoreSummary) => ({
  backupId: s.backupId,
  createdAt: s.backupCreatedAt,
  schemaVersion: s.backupSchemaVersion,
  counts: s.counts,
  embeddingSpace: s.embeddingSpace ?? null,
});

const realOrResolved = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** The marker, or `"unreadable"` when it cannot be read: the screen says so, nothing is deleted. */
function markerOf(dataDir: string): ReturnType<typeof readPending> | "unreadable" {
  try {
    return readPending(dataDir);
  } catch (error) {
    if (error instanceof RestoreMarkerError) return "unreadable";
    throw error;
  }
}

const usable = (folder: string): boolean => {
  try {
    if (!statSync(folder).isDirectory()) return false;
    accessSync(folder, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

export function createBackupApi(options: BackupApiOptions): BackupApi {
  const { db, dataDir } = options;
  const now = options.now ?? Date.now;
  const folderOf = () => readSetting(db, BACKUP_FOLDER_SETTING);

  /** The path of a file by its bare name inside the chosen folder, or the refusal. */
  const fileIn = (
    fileName: string,
  ): { path: string } | { code: "no-folder" | "bad-file-name" | "not-found" } => {
    const folder = folderOf();
    if (folder === undefined || !usable(folder)) return { code: "no-folder" };
    if (basename(fileName) !== fileName || !fileName.endsWith(BACKUP_EXTENSION)) {
      return { code: "bad-file-name" };
    }
    const path = join(folder, fileName);
    return existsSync(path) ? { path } : { code: "not-found" };
  };

  return {
    status() {
      const folder = folderOf() ?? null;
      const folderUsable = folder !== null && usable(folder);
      const marker = markerOf(dataDir);
      return {
        folder,
        folderUsable,
        files: folderUsable ? listBackups(folder) : [],
        pending:
          typeof marker === "object" && marker.state === "staged"
            ? {
                backupId: marker.backupId,
                backupCreatedAt: marker.backupCreatedAt,
                stagedAt: marker.stagedAt,
                counts: marker.counts,
              }
            : null,
        last: readRestoreLast(db) ?? null,
        failure:
          marker === "unreadable"
            ? "restore-marker-unreadable"
            : marker?.state === "failed"
              ? marker.code
              : null,
        minPassphraseLength: MIN_PASSPHRASE_LENGTH,
      };
    },

    setFolder(request) {
      const typed = options.buildKind !== "production" ? request.path : undefined;
      const path =
        request.ticket !== undefined ? options.tickets.redeem(request.ticket, "folder") : typed;
      if (path === undefined) return { status: "refused", code: "ticket-required" };
      let real: string;
      try {
        real = realpathSync(path);
        if (!statSync(real).isDirectory()) return { status: "refused", code: "not-a-folder" };
      } catch {
        return { status: "refused", code: "not-a-folder" };
      }
      if (!usable(real)) return { status: "refused", code: "not-writable" };
      const data = realOrResolved(dataDir);
      if (real === data || real.startsWith(data + sep)) {
        return { status: "refused", code: "inside-data-folder" };
      }
      writeSetting(db, BACKUP_FOLDER_SETTING, real);
      return { status: "ok", folder: real };
    },

    async create({ passphrase }) {
      if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
        return { status: "refused", code: "weak-passphrase" };
      }
      const folder = folderOf();
      if (folder === undefined) return { status: "refused", code: "no-folder" };
      if (!usable(folder)) return { status: "refused", code: "folder-unusable" };
      const facts = await readIndexFacts(options.vectorIndex);
      try {
        const made = createBackup({
          db,
          open: options.open,
          dataDir,
          folder,
          passphrase,
          now: new Date(now()),
          ...facts,
          ...(options.scrypt ? { scrypt: options.scrypt } : {}),
        });
        return { status: "created", fileName: made.fileName, summary: summaryOf(made.manifest) };
      } catch (error) {
        if (error instanceof BackupExistsError) return { status: "refused", code: "file-exists" };
        if (error instanceof BackupFileError && error.code === "weak-passphrase") {
          return { status: "refused", code: "weak-passphrase" };
        }
        log("backup-failed", { error: errorClass(error) });
        return { status: "refused", code: "failed" };
      }
    },

    async inspect({ fileName, passphrase }) {
      const file = fileIn(fileName);
      if ("code" in file) return { status: "refused", code: file.code };
      try {
        const manifest = readBackupManifest(file.path, passphrase);
        const current = schemaVersion(db);
        const mine = installationFingerprint(db);
        const index = await readIndexFacts(options.vectorIndex);
        return {
          status: "ok",
          summary: summaryOf(manifest),
          schema:
            manifest.schemaVersion === current
              ? "same"
              : manifest.schemaVersion < current
                ? "older"
                : "newer",
          installation:
            manifest.installation == null || mine === null
              ? "unknown"
              : manifest.installation === mine
                ? "same"
                : "other",
          embeddingSpace:
            JSON.stringify(manifest.embeddingSpace ?? null) === JSON.stringify(index.embeddingSpace)
              ? "same"
              : "different",
        };
      } catch (error) {
        if (error instanceof BackupFileError && error.code !== "weak-passphrase") {
          return { status: "refused", code: error.code };
        }
        throw error;
      }
    },

    async restore({ fileName, passphrase, confirmBackupId }) {
      const file = fileIn(fileName);
      if ("code" in file) return { status: "refused", code: file.code };
      const result = stageRestore({
        db,
        open: options.open,
        dataDir,
        file: file.path,
        passphrase,
        confirmBackupId,
        now: new Date(now()),
      });
      return result.status === "staged"
        ? { status: "staged", summary: stagedSummaryOf(result.summary) }
        : { status: "refused", code: result.code };
    },

    cancel() {
      const marker = markerOf(dataDir);
      if (marker === "unreadable") return { status: "none" };
      if (marker?.state !== "staged" && marker?.state !== "failed") return { status: "none" };
      removeRestoreArtifacts(dataDir);
      return { status: "cancelled" };
    },
  };
}
