// The schemas of the backup and restore routes (H01-R15). A refusal is a 200 answer with its own code, so
// the screen can say what is wrong in words; the passphrase appears in requests only, never in an answer.
import { z } from "zod";

export const MIN_BACKUP_PASSPHRASE_LENGTH = 12;

const CountSchema = z.int().nonnegative();
export const BackupCountsSchema = z.object({
  sources: CountSchema,
  sourceVersions: CountSchema,
  items: CountSchema,
  facts: CountSchema,
  relations: CountSchema,
  evidence: CountSchema,
  openJobs: CountSchema,
  schedules: CountSchema,
  feedback: CountSchema,
  tombstones: CountSchema,
});

const EmbeddingSpaceSchema = z.object({
  modelId: z.string(),
  revision: z.string(),
  dimension: z.int().nonnegative(),
});

/** What a backup file says about itself (the manifest, without the numbers only the restore needs). */
export const BackupSummarySchema = z.object({
  backupId: z.string().min(1),
  createdAt: z.string(),
  schemaVersion: CountSchema,
  counts: BackupCountsSchema,
  embeddingSpace: EmbeddingSpaceSchema.nullable(),
});
export type BackupSummary = z.infer<typeof BackupSummarySchema>;

export const BackupFileInfoSchema = z.object({
  fileName: z.string(),
  bytes: CountSchema,
  createdAt: z.string(),
  schemaVersion: CountSchema,
});

export const RestorePendingSchema = z.object({
  backupId: z.string(),
  backupCreatedAt: z.string(),
  stagedAt: z.string(),
  counts: BackupCountsSchema,
});

/** What the last applied restore did (settings `restore.last`). */
export const RestoreLastSchema = z.object({
  backupId: z.string(),
  stagedAt: z.string(),
  appliedAt: z.string(),
  backupCreatedAt: z.string(),
  reapplied: CountSchema,
  pausedLocations: CountSchema,
  clearedConsents: CountSchema,
  embeddingSpaceDiffers: z.boolean(),
});
export type RestoreLast = z.infer<typeof RestoreLastSchema>;

export const BackupStatusSchema = z.object({
  folder: z.string().nullable(),
  /** The folder exists and can be written; false after it was moved or removed. */
  folderUsable: z.boolean(),
  files: z.array(BackupFileInfoSchema),
  /** A restore that waits for the next start; null when none. */
  pending: RestorePendingSchema.nullable(),
  last: RestoreLastSchema.nullable(),
  /** The code of a restore that failed at start and was put back (R13); null when none. */
  failure: z.string().nullable(),
  minPassphraseLength: z.int().positive(),
});

export const BACKUP_FOLDER_REFUSALS = [
  "ticket-required",
  "not-a-folder",
  "not-writable",
  "inside-data-folder",
] as const;

/** The folder: a typed path (development and test builds) or the shell picker's one-time ticket (R7). */
export const BackupFolderRequestSchema = z
  .strictObject({
    path: z.string().min(1).max(4096).optional(),
    ticket: z.string().min(16).max(256).optional(),
  })
  .refine((r) => (r.path === undefined) !== (r.ticket === undefined), {
    message: "exactly one of path and ticket",
  });
export const BackupFolderResponseSchema = z
  .object({
    status: z.enum(["ok", "refused"]),
    folder: z.string().optional(),
    code: z.enum(BACKUP_FOLDER_REFUSALS).optional(),
  })
  .refine(
    (r) =>
      r.status === "ok"
        ? r.folder !== undefined && r.code === undefined
        : r.code !== undefined && r.folder === undefined,
    {
      message: "ok carries the folder, refused a code",
    },
  );

export const BACKUP_REFUSALS = [
  "weak-passphrase",
  "no-folder",
  "folder-unusable",
  "file-exists",
  "failed",
] as const;

export const CreateBackupRequestSchema = z.strictObject({
  passphrase: z.string().min(1).max(1024),
});
export const CreateBackupResponseSchema = z
  .object({
    status: z.enum(["created", "refused"]),
    fileName: z.string().optional(),
    summary: BackupSummarySchema.optional(),
    code: z.enum(BACKUP_REFUSALS).optional(),
  })
  .refine(
    (r) =>
      r.status === "created"
        ? r.fileName !== undefined && r.summary !== undefined && r.code === undefined
        : r.code !== undefined && r.fileName === undefined && r.summary === undefined,
    { message: "created carries the file and its summary, refused a code" },
  );

export const RESTORE_REFUSALS = [
  "wrong-passphrase",
  "damaged",
  "unsupported-format",
  "confirm-mismatch",
  "newer-schema",
  "other-installation",
  "migration-failed",
  "foreign-schema",
  "already-pending",
  "no-folder",
  "bad-file-name",
  "not-found",
] as const;
export type RestoreRefusalCode = (typeof RESTORE_REFUSALS)[number];

const FileNameSchema = z.string().min(1).max(255);

export const InspectRestoreRequestSchema = z.strictObject({
  fileName: FileNameSchema,
  passphrase: z.string().min(1).max(1024),
});
export const InspectRestoreResponseSchema = z
  .object({
    status: z.enum(["ok", "refused"]),
    summary: BackupSummarySchema.optional(),
    /** The backup's schema against this build's: a newer one is refused, an older one is lifted while staging. */
    schema: z.enum(["same", "older", "newer"]).optional(),
    /** Whether the backup is of this installation; `unknown` when its file does not say. */
    installation: z.enum(["same", "other", "unknown"]).optional(),
    embeddingSpace: z.enum(["same", "different"]).optional(),
    code: z.enum(RESTORE_REFUSALS).optional(),
  })
  .refine(
    (r) =>
      r.status === "ok"
        ? [r.summary, r.schema, r.installation, r.embeddingSpace].every((v) => v !== undefined) &&
          r.code === undefined
        : r.code !== undefined &&
          [r.summary, r.schema, r.installation, r.embeddingSpace].every((v) => v === undefined),
    { message: "ok carries the inspection, refused a code" },
  );

export const RestoreRequestSchema = z.strictObject({
  fileName: FileNameSchema,
  passphrase: z.string().min(1).max(1024),
  /** The `backupId` the inspection showed: a request for another file is refused. */
  confirmBackupId: z.string().min(1).max(200),
});
export const RestoreResponseSchema = z
  .object({
    status: z.enum(["staged", "refused"]),
    summary: BackupSummarySchema.optional(),
    code: z.enum(RESTORE_REFUSALS).optional(),
  })
  .refine(
    (r) =>
      r.status === "staged"
        ? r.summary !== undefined && r.code === undefined
        : r.code !== undefined && r.summary === undefined,
    { message: "staged carries the summary, refused a code" },
  );

export const CancelRestoreResponseSchema = z.object({ status: z.enum(["cancelled", "none"]) });
