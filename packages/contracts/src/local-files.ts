// Shared vocabulary of the `local-files` connector (I02B-R16, R4): the closed list of skip reasons with
// their retry class, and the ports the connector reaches the outside through. The connector lives under
// `backend/src/adapters/` and may import only `@pki/contracts` and `@pki/connector-sdk`, so the shapes of
// the index and of the normalizer it is handed are written here, structurally: the canonical index
// (`@pki/storage`) and the isolated normalizer (`@pki/document-normalize`) satisfy them without either
// package knowing this file (the composition point and the tests check the assignment).
import { z } from "zod";
import type { Block } from "./connector.ts";

/** Every reason a file is kept in the index as skipped, never sent as a Connector `rejected` (I02B-R16). */
export const LOCAL_SKIP_REASON_CODES = [
  // the normalizer's own error kinds (I02A-R5)
  "unsupported-format",
  "format-mismatch",
  "outside-root",
  "not-a-file",
  "read-failed",
  "too-large",
  "zip-limit",
  "zip-path",
  "encoding-undecidable",
  "encrypted",
  "corrupt",
  // the isolated normalizer's three (I02B-R23)
  "timed-out",
  "resource-exceeded",
  "worker-failed",
  // the path boundary's (I02B-R6, R47)
  "symlink",
  "redirected",
  "not-regular-file",
  "path-too-long",
  "too-deep",
  "identity-unavailable",
  // the rest
  "locked",
  "not-readable",
  "user-deleted",
] as const;
export type LocalSkipReason = (typeof LOCAL_SKIP_REASON_CODES)[number];

/** `every-pass`: looked at again by every pass; `on-change`: only when the file, the parser or a limit changed. */
export type SkipRetry = "every-pass" | "on-change";

const EVERY_PASS: ReadonlySet<LocalSkipReason> = new Set([
  "locked",
  "not-readable",
  "worker-failed",
  "redirected",
]);

/** A code with no class does not compile: the record is total over `LocalSkipReason`. */
export const LOCAL_SKIP_REASONS: Readonly<Record<LocalSkipReason, { retry: SkipRetry }>> =
  Object.fromEntries(
    LOCAL_SKIP_REASON_CODES.map((code) => [
      code,
      { retry: EVERY_PASS.has(code) ? "every-pass" : "on-change" },
    ]),
  ) as Record<LocalSkipReason, { retry: SkipRetry }>;

// --- the ports of the `local-files` connector (I02B-R4, spec "포트와 색인의 모양") ---------------------

export type LocalEntryState = "present" | "skipped" | "deleted" | "forgotten";

/** An index entry as the connector reads it (the canonical index's `LocalFileEntry`). */
export interface LocalIndexEntry {
  externalId: string;
  locationId: string;
  relativePath: string | null;
  size: number | null;
  mtimeNs: string | null;
  contentHash: string | null;
  /** `<dev>:<ino>` of the file the walk saw. */
  fileNo: string | null;
  revision: number;
  normalizerVersion: number | null;
  seq: number;
  state: LocalEntryState;
  pendingDelete: 0 | 1 | 2;
  skipReason: string | null;
  skippedAt: string | null;
  skipLimits: string | null;
}

export interface LocalIndexFields {
  relativePath: string;
  size: number | null;
  mtimeNs: string | null;
  contentHash: string | null;
  fileNo: string | null;
  revision: number;
  normalizerVersion: number | null;
  state: "present" | "skipped" | "deleted";
  pendingDelete: 0 | 1 | 2;
  skipReason: string | null;
  skippedAt: string | null;
  skipLimits: string | null;
}

export type LocalIndexNewEntry = Omit<LocalIndexFields, "state"> & {
  externalId: string;
  locationId: string;
  state: "present" | "skipped";
};

export type LocalIndexWrite = { applied: true; seq: number } | { applied: false; reason: string };

/** What the connector uses of the canonical index. */
export interface LocalIndexPort {
  lastSeq(): number;
  entryOf(externalId: string): LocalIndexEntry | undefined;
  findByPath(locationId: string, relativePath: string): LocalIndexEntry | undefined;
  entriesOfLocation(locationId: string): LocalIndexEntry[];
  entriesAfter(seq: number, limit: number): LocalIndexEntry[];
  updateEntry(externalId: string, expectedSeq: number, next: LocalIndexFields): LocalIndexWrite;
  insertEntry(
    entry: LocalIndexNewEntry,
    seenPathsOfSameContent: readonly string[],
  ): LocalIndexWrite;
}

/** An approved location as the connector reads it (the canonical `LocalLocation`). */
export interface LocalLocationView {
  id: string;
  type: "folder" | "file" | "jsonl-file";
  /** The path the OS resolved at approval. */
  realPath: string;
  rootDev: string;
  rootIno: string;
  state: "active" | "paused" | "unavailable" | "needs-confirmation" | "revoking";
  /** Why the state is what it is (`root-missing`, `root-changed`, ...), null for none. */
  stateReason: string | null;
}

/** The part of the isolated normalizer's result the connector reads. */
export type LocalNormalizeResult =
  | {
      ok: true;
      document: {
        format: string;
        text: string;
        blocks: Block[];
        metadata: { title?: string; author?: string; created?: string; participants?: string[] };
        encoding?: { name: string; method: string };
        limitations: { code: string }[];
      };
    }
  | {
      ok: false;
      error: { code: string };
      /** `resource-exceeded` because the host vanished twice without a word (I02B-R23). */
      unexplainedDeath?: true;
      /** The host is broken: nothing more is normalized this pass (I02B-R23). */
      unavailable?: true;
    };

export interface LocalNormalizerPort {
  normalize(
    input: { bytes: Uint8Array; name: string; format?: string },
    opts: { limits?: { maxFileBytes?: number }; signal?: AbortSignal },
  ): Promise<LocalNormalizeResult>;
  /** The host is called broken. */
  unavailable(): boolean;
  /** At a pass's start: true when the normalizer is usable (a broken host gets one canary retry). */
  recheck(): Promise<boolean>;
}

/** The settings the connector reads, as numbers (I02B-R40). */
export interface LocalFilesLimits {
  maxFileBytes: number;
  settleMs: number;
  pageBudgetMs: number;
  walk: { maxFilesPerLocation: number; maxDepth: number; maxRelativePathChars: number };
  normalize: { maxHeapMb: number; maxExternalMemoryBytes: number };
  /** A walk that finds at least `minFiles` files gone, and at least `ratio` of the tracked ones, holds them (I02B-R8). */
  deletionBrake: { ratio: number; minFiles: number };
  /** A revocation deletes `maxPerTransaction` sources per transaction and waits `lockWaitMs` for a running sync (I02B-R49). */
  revoke: { maxPerTransaction: number; lockWaitMs: number };
  /** A watch signal registers a sync once it has been quiet `quietMs`, and at the latest `maxWaitMs` after the first (I02B-R20). */
  watch: { quietMs: number; maxWaitMs: number };
}

/** What one pass learned about a location, for the location list (I02B-R36, R38). */
export interface LocalLocationReport {
  locationId: string;
  walked: number;
  sourced: number;
  skipped: number;
  ignored: number;
  /** Files waiting for the settle condition (I02B-R15). */
  pending: number;
  limitExceeded: boolean;
  /** The root was missing or was not the folder approved: nothing was read or deleted (I02B-R7). */
  rootUnavailable: boolean;
  /**
   * Paths of files the user deleted from the product that are still in the location (I02B-R33). Only
   * the walk knows them (the index keeps a keyed hash), so the skipped list reads them from here.
   */
  forgottenPaths: string[];
}

export interface LocalPassReport {
  at: number;
  normalizerUnavailable: boolean;
  locations: LocalLocationReport[];
}

// --- the location API (I02B-R36, R40) -------------------------------------------------------------

/** The codes an approval is refused with (I02B-R5), as the screen's text keys them. The connector SDK's own list must equal it (a test). */
export const LOCAL_APPROVAL_REJECTION_CODES = [
  "not-absolute",
  "unsupported-path-form",
  "not-found",
  "not-readable",
  "location-unreachable",
  "wrong-type",
  "identity-unavailable",
  "filesystem-root",
  "inside-data-directory",
  "overlaps-location",
  "network-location",
  "unsupported-format",
  // not a path check: the request had no ticket from the shell's picker where one is required (I02B-R37)
  "ticket-required",
] as const;
export type LocalApprovalRejectionCode = (typeof LOCAL_APPROVAL_REJECTION_CODES)[number];

const LocationTypeSchema = z.enum(["folder", "file", "jsonl-file"]);

/**
 * An approval: the kind and either a typed path (the development and test builds) or the one-time
 * ticket the shell's picker made (I02B-R37). Both, or neither, is a bad request.
 */
export const LocalApprovalRequestSchema = z
  .strictObject({
    type: LocationTypeSchema,
    path: z.string().min(1).max(4096).optional(),
    ticket: z.string().min(16).max(256).optional(),
  })
  .refine((r) => (r.path === undefined) !== (r.ticket === undefined), {
    message: "exactly one of path and ticket",
  });
export type LocalApprovalRequest = z.infer<typeof LocalApprovalRequestSchema>;

/**
 * A relink (I02B-R9): which location, and the folder it is now, as a typed path (development, test) or
 * the one-time ticket of the shell's picker (I02B-R37, the same rule as an approval).
 */
export const LocalRelinkRequestSchema = z
  .strictObject({
    locationId: z.string().min(1).max(64),
    path: z.string().min(1).max(4096).optional(),
    ticket: z.string().min(16).max(256).optional(),
  })
  .refine((r) => (r.path === undefined) !== (r.ticket === undefined), {
    message: "exactly one of path and ticket",
  });
export type LocalRelinkRequest = z.infer<typeof LocalRelinkRequestSchema>;

/** A request about one location: pause, resume, rescan. */
export const LocalLocationIdRequestSchema = z.strictObject({
  locationId: z.string().min(1).max(64),
});
export type LocalLocationIdRequest = z.infer<typeof LocalLocationIdRequestSchema>;

/** The held deletions are confirmed by the count the user saw (I02B-R8): another count is refused. */
export const LocalConfirmDeletionsRequestSchema = z.strictObject({
  locationId: z.string().min(1).max(64),
  count: z.int().nonnegative(),
});
export type LocalConfirmDeletionsRequest = z.infer<typeof LocalConfirmDeletionsRequestSchema>;

/** A revocation (I02B-R10): the location and the number of sources the user was shown (I02B-R49); the same call with the remaining count continues one. */
export const LocalRevokeRequestSchema = z.strictObject({
  locationId: z.string().min(1).max(64),
  count: z.int().nonnegative(),
});
export type LocalRevokeRequest = z.infer<typeof LocalRevokeRequestSchema>;

/**
 * Done in one transaction (`revoked`, with how many sources went), or begun (`revoking`, with how many
 * are still to go: the location lists as `revoking`). One object, not a union: the route table's
 * response schemas convert to a JSON Schema object (a test).
 */
export const LocalRevokeResponseSchema = z.strictObject({
  state: z.enum(["revoked", "revoking"]),
  revoked: z.int().nonnegative().optional(),
  remaining: z.int().positive().optional(),
});
export type LocalRevokeResponse = z.infer<typeof LocalRevokeResponseSchema>;

/** One page of the skipped list of a location (I02B-R36). */
export const LocalSkippedRequestSchema = z.strictObject({
  locationId: z.string().min(1).max(64),
  offset: z.int().nonnegative().default(0),
  limit: z.int().min(1).max(500).default(100),
});
export type LocalSkippedRequest = z.input<typeof LocalSkippedRequestSchema>;

/** A skip reason, or `user-deleted` for a file the user removed from the product. */
export const LocalSkippedReasonSchema = z.enum([...LOCAL_SKIP_REASON_CODES, "user-deleted"]);
export const LocalSkippedResponseSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      relativePath: z.string(),
      reason: LocalSkippedReasonSchema,
      /** ISO time the file was first skipped for this reason; null for a user deletion (not stored). */
      since: z.string().nullable(),
    }),
  ),
  total: z.int().nonnegative(),
});
export type LocalSkippedResponse = z.infer<typeof LocalSkippedResponseSchema>;

/** A skipped file read again: the location and the path the list showed (I02B-R33). */
export const LocalReimportRequestSchema = z.strictObject({
  locationId: z.string().min(1).max(64),
  relativePath: z.string().min(1).max(4096),
});
export type LocalReimportRequest = z.infer<typeof LocalReimportRequestSchema>;
export const LocalReimportResponseSchema = z.strictObject({ outcome: z.literal("queued") });

/** "지금 위치" of a source version the screen holds (I02B-R39): keyed by the version id, a POST like the other routes with an input. */
export const LocalSourceInfoRequestSchema = z.strictObject({
  sourceVersionId: z.int().positive(),
});
export type LocalSourceInfoRequest = z.infer<typeof LocalSourceInfoRequestSchema>;

/**
 * Where a local source is now. The relative path only: no answer carries an absolute path (I02B-R36, R39).
 * `notFound` is derived from the index, never from the disk: the location is `unavailable`, or the file's
 * deletion is held or confirmed.
 */
export const LocalSourceInfoResponseSchema = z.strictObject({
  local: z.boolean(),
  relativePath: z.string().nullable(),
  state: z.enum(["active", "paused", "unavailable", "needs-confirmation", "revoking"]).nullable(),
  notFound: z.boolean(),
});
export type LocalSourceInfo = z.infer<typeof LocalSourceInfoResponseSchema>;

const PositiveInt = z.int().positive();
const walkShape = {
  maxFilesPerLocation: PositiveInt,
  maxDepth: PositiveInt,
  maxRelativePathChars: PositiveInt,
};
const watchShape = { quietMs: z.int().positive(), maxWaitMs: z.int().positive() };
const revokeShape = { maxPerTransaction: z.int().positive(), lockWaitMs: z.int().positive() };
const brakeShape = { ratio: z.number().positive(), minFiles: PositiveInt };
const normalizeShape = {
  timeoutMs: PositiveInt,
  maxHeapMb: PositiveInt,
  maxExternalMemoryBytes: PositiveInt,
};

/** The limits the location API reads and writes (I02B-R40): every one a positive whole number. */
export const LocalFilesSettingsSchema = z.strictObject({
  maxFileBytes: PositiveInt,
  settleMs: PositiveInt,
  pageBudgetMs: PositiveInt,
  walk: z.strictObject(walkShape),
  normalize: z.strictObject(normalizeShape),
  deletionBrake: z.strictObject(brakeShape),
  revoke: z.strictObject(revokeShape),
  watch: z.strictObject(watchShape),
});
export type LocalFilesSettings = z.infer<typeof LocalFilesSettingsSchema>;

/** A write names the limits it changes; the others stay. */
export const LocalFilesSettingsPatchSchema = z.strictObject({
  maxFileBytes: PositiveInt.optional(),
  settleMs: PositiveInt.optional(),
  pageBudgetMs: PositiveInt.optional(),
  walk: z.strictObject(walkShape).partial().optional(),
  normalize: z.strictObject(normalizeShape).partial().optional(),
  deletionBrake: z.strictObject(brakeShape).partial().optional(),
  revoke: z.strictObject(revokeShape).partial().optional(),
  watch: z.strictObject(watchShape).partial().optional(),
});
export type LocalFilesSettingsPatch = z.infer<typeof LocalFilesSettingsPatchSchema>;

/** One approved location as the list shows it. The path is the one the user chose; no file content is here. */
export const LocalLocationSchema = z.object({
  id: z.string(),
  type: LocationTypeSchema,
  displayPath: z.string(),
  state: z.enum(["active", "paused", "unavailable", "needs-confirmation", "revoking"]),
  stateReason: z.string().nullable(),
  counts: z.strictObject({
    tracked: z.int().nonnegative(),
    skipped: z.int().nonnegative(),
    ignored: z.int().nonnegative(),
    pendingDeletes: z.int().nonnegative(),
    /** Sources of the location that are still whole: what a revocation deletes, and what is left while it runs (I02B-R36). */
    sources: z.int().nonnegative(),
  }),
  limitExceeded: z.boolean(),
  /** ISO time of the last finished pass, null before the first. */
  lastPassAt: z.string().nullable(),
  /** No watcher in this release: the list says so (I02B-R38). */
  watching: z.boolean(),
});
export type LocalLocationInfo = z.infer<typeof LocalLocationSchema>;

export const LocalLocationListSchema = z.object({
  locations: z.array(LocalLocationSchema),
  /** The normalizer host is broken and normalizing stopped (I02B-R23, R36). */
  normalizerUnavailable: z.boolean(),
  limits: LocalFilesSettingsSchema,
});
export type LocalLocationList = z.infer<typeof LocalLocationListSchema>;
