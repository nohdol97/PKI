// Connector SDK v2 (I01 spec, ARCHITECTURE 5.5, ADR 0016). The Connector
// management module calls getChanges repeatedly and commits the cursor only after
// saving each page. Records are strict: a Connector cannot attach a data class
// (ADR 0014) nor name its own instance (I01-R5); the management module adds the
// instance it syncs, and the Broker grades from the canonical store.
import { z } from "zod";

/** The Connector specification version this build implements (I01-R1). */
export const CONNECTOR_SDK_VERSION = 2;

export const CONNECTOR_NOT_IMPLEMENTED = "미구현, 배포처 후속";

/** Raised by the public repository's placeholders for site Connectors (V01-R18). */
export class ConnectorNotImplementedError extends Error {
  constructor() {
    super(CONNECTOR_NOT_IMPLEMENTED);
    this.name = "ConnectorNotImplementedError";
  }
}

/**
 * A failed call to the origin system (I01-R4). `retryable` says whether the same
 * call may succeed later. The message may hold origin text, so the product keeps
 * only a reason code, never the message.
 */
export class ConnectorError extends Error {
  readonly retryable: boolean;
  constructor(message: string, { retryable }: { retryable: boolean }) {
    super(message);
    this.name = "ConnectorError";
    this.retryable = retryable;
  }
}

/** The origin system refused for now and said when to come back (I01-R4, R18). */
export class ConnectorRateLimitError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, { retryAfterMs }: { retryAfterMs: number }) {
    if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0) {
      throw new RangeError("retryAfterMs must be a finite number of milliseconds, 0 or more");
    }
    super(message);
    this.name = "ConnectorRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** ISO-8601 with a UTC offset (`Z` or `±hh:mm`), as the golden JSONL records carry. */
export const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const timestamp = z.string().regex(ISO_WITH_OFFSET);
/** Counted from 1 (pages, lines, records, rows); from 0 (paragraphs, tables). */
const fromOne = z.int().min(1);
const fromZero = z.int().min(0);

/**
 * Where a block sits in its original format: the I02 position table ("위치표의
 * 모양") field for field, a union told apart by `format` (I01-R7).
 */
export const NativeLocatorSchema = z.discriminatedUnion("format", [
  z.strictObject({ format: z.literal("pdf"), page: fromOne }),
  z.strictObject({
    format: z.literal("docx"),
    paragraph: fromZero,
    style: z.string().optional(),
    headingLevel: fromZero.optional(),
    table: z.strictObject({ index: fromZero, row: fromZero, cell: fromZero }).optional(),
  }),
  z.strictObject({
    format: z.literal("xlsx"),
    sheet: z.string().min(1),
    cell: z
      .string()
      .regex(/^[A-Z]{1,3}[1-9][0-9]*$/)
      .optional(),
    row: fromOne.optional(),
    column: fromOne.optional(),
  }),
  z.strictObject({ format: z.literal("csv"), record: fromOne, line: fromOne, field: fromOne }),
  z.strictObject({ format: z.literal("html"), path: z.string().min(1), line: fromOne }),
  z.strictObject({
    format: z.literal("markdown"),
    line: fromOne,
    node: z.string().min(1),
    depth: fromOne.optional(),
  }),
  z.strictObject({ format: z.enum(["txt", "json"]), line: fromOne }),
]);
export type NativeLocator = z.infer<typeof NativeLocatorSchema>;

/** Code points `[start, end)` of the record's body and where they came from. */
export const BlockSchema = z.strictObject({
  start: z.int(),
  end: z.int(),
  locator: NativeLocatorSchema,
});
export type Block = z.infer<typeof BlockSchema>;

/**
 * The range rules of I01-R7, which need the body: `0 ≤ start < end ≤` its code
 * point count, sorted by start, no overlap, gaps allowed. A record failing them
 * is refused as `invalid-blocks`, apart from schema failures.
 */
export function blocksValid(
  body: string,
  blocks: readonly Pick<Block, "start" | "end">[],
): boolean {
  const length = Array.from(body).length;
  let previousEnd = 0;
  for (const { start, end } of blocks) {
    if (start < previousEnd || start >= end || end > length) return false;
    previousEnd = end;
  }
  return true;
}

/**
 * Revision: the origin system's own number for this record, rising with every
 * change it makes (I01-R5, R9). It only orders arrivals; the product numbers its
 * versions itself.
 */
const revision = z.int().min(1);
const accessScope = z.array(z.string().min(1)).min(1);

export const SourceRecordSchema = z.strictObject({
  /** Where `externalId` is unique within the instance; "" when it has one range. */
  namespace: z.string(),
  externalId: z.string().min(1),
  revision,
  schemaVersion: z.literal(CONNECTOR_SDK_VERSION),
  title: z.string(),
  /** The normalized body; block ranges count its code points. */
  body: z.string(),
  blocks: z.array(BlockSchema).optional(),
  /** Who may see it, as the origin system names them; absent means unknown (strictest). */
  accessScope: accessScope.optional(),
  sourceType: z.string().optional(),
  sourceUrl: z.string().optional(),
  author: z.string().optional(),
  participants: z.array(z.string()).optional(),
  threadId: z.string().optional(),
  createdAt: timestamp.optional(),
  updatedAt: timestamp.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type SourceRecord = z.infer<typeof SourceRecordSchema>;

/** A source an event names, the origin's revision of the event, and when it happened. */
const ref = {
  namespace: z.string(),
  externalId: z.string().min(1),
  revision,
  at: timestamp,
};

/**
 * `delete` and `access-revoked` are the tombstone events; neither a tombstone nor
 * a scope change carries content (I01-R6).
 */
export const ChangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("upsert"), record: SourceRecordSchema }),
  z.strictObject({ kind: z.literal("scope-change"), ...ref, accessScope }),
  z.strictObject({ kind: z.enum(["delete", "access-revoked"]), ...ref }),
]);
export type Change = z.infer<typeof ChangeSchema>;

/** Why a record was refused, by whoever refused it (I01-R19's closed list). */
export const REJECT_CODES = [
  "invalid-json",
  "schema",
  "content-hash-mismatch",
  "revision-conflict",
  "invalid-blocks",
  "capability-violation",
  "scope-change-content-mismatch",
] as const;
export type RejectCode = (typeof REJECT_CODES)[number];

const REJECTED_POSITION = /^[a-z][a-z0-9-]{0,15}:[0-9]{1,9}$/;

/**
 * A rejection's `at` is a short kind and a number (`line:12`): it cannot carry
 * content. The page schema takes any string so that one bad position does not
 * fail a page; the management module replaces one failing this check with
 * `change:<n>` (I01-R6).
 */
export function rejectedPositionValid(at: string): boolean {
  return REJECTED_POSITION.test(at);
}

export const ChangeSetSchema = z.strictObject({
  changes: z.array(ChangeSchema),
  nextCursor: z.string(),
  hasMore: z.boolean(),
  /** The given cursor is no longer valid: the caller rescans from null. */
  cursorExpired: z.boolean().optional(),
  /** What the Connector filtered out itself, by position and code. */
  rejected: z.array(z.strictObject({ at: z.string(), code: z.enum(REJECT_CODES) })).default([]),
});
/** What a Connector returns: `rejected` may be left out. */
export type ChangeSet = z.input<typeof ChangeSetSchema>;

export type HealthStatus = { state: "ok" } | { state: "unavailable"; reason: string };

export interface ConnectorCapabilities {
  /** Asked again with the last cursor, it has no new change. */
  incremental: boolean;
  /** It emits `delete` and `access-revoked` events. */
  deletes: boolean;
  /** Every upsert has a non-empty `accessScope`, and it may emit `scope-change`. */
  accessScope: boolean;
  /** It can read again from a null cursor. */
  fullRescan: boolean;
  /** A rescan reports every deletion since the last cursor (needs deletes and fullRescan). */
  deletionsOnRescan: boolean;
}

export interface ConnectorManifest {
  type: string;
  /** The SDK version it implements; the management module runs only CONNECTOR_SDK_VERSION. */
  schemaVersion: number;
  capabilities: ConnectorCapabilities;
}

export interface Connector {
  readonly manifest: ConnectorManifest;
  /** Unimplemented integrations fail with ConnectorNotImplementedError. */
  initialize(config: unknown): Promise<void>;
  /** Never throws: `ok`, or `unavailable` with a reason. */
  healthCheck(): Promise<HealthStatus>;
  getChanges(
    cursor: string | null,
    opts: { limit: number; signal: AbortSignal },
  ): Promise<ChangeSet>;
  /** The latest revision of a source, or null if unknown or deleted. */
  getDocument(ref: { namespace: string; externalId: string }): Promise<SourceRecord | null>;
}

/**
 * One piece of evidence as read (I01-R29): the immutable version and code-point
 * span it points at, and, when that version has blocks, the locator of the block
 * holding the span's start. Read-only; evidence rows are stored as in V02.
 */
export const EvidenceViewSchema = z.strictObject({
  sourceVersionId: z.int().positive(),
  version: z.int().positive(),
  span: z.strictObject({ start: z.int().min(0), end: z.int().min(0) }),
  quote: z.string(),
  locator: NativeLocatorSchema.nullable(),
});
export type EvidenceView = z.infer<typeof EvidenceViewSchema>;
