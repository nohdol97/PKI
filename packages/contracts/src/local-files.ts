// Shared vocabulary of the `local-files` connector (I02B-R16, R4): the closed list of skip reasons with
// their retry class, and the ports the connector reaches the outside through. The connector lives under
// `backend/src/adapters/` and may import only `@pki/contracts` and `@pki/connector-sdk`, so the shapes of
// the index and of the normalizer it is handed are written here, structurally: the canonical index
// (`@pki/storage`) and the isolated normalizer (`@pki/document-normalize`) satisfy them without either
// package knowing this file (the composition point and the tests check the assignment).
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
}

/** The part of the isolated normalizer's result the connector reads. */
export type LocalNormalizeResult =
  | {
      ok: true;
      document: {
        format: string;
        text: string;
        blocks: Block[];
        metadata: { title?: string; author?: string; created?: string };
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
}

export interface LocalPassReport {
  at: number;
  normalizerUnavailable: boolean;
  locations: LocalLocationReport[];
}
