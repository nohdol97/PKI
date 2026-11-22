// Single schema source for the local HTTP API (V01-R2). The UI and the backend
// both import these; TypeScript types come from z.infer, JSON Schema from z.toJSONSchema.
import { z } from "zod";
import type { EmbeddingEgress } from "./embedding.ts";
import { NativeLocatorSchema } from "./connector.ts";
import {
  ImportJsonlRequestSchema,
  ImportJsonlResponseSchema,
  ImportRequestSchema,
} from "./import-record.ts";
import { REJECT_CODES } from "./connector.ts";
import { DATA_CLASSES, PROVIDER_IDS } from "./provider.ts";

export * from "./adapter-errors.ts";
export type * from "./embedding.ts";
export type * from "./knowledge-engine.ts";
export type * from "./vector-index.ts";
export * from "./connector.ts";
export * from "./import-record.ts";
export * from "./provider.ts";
export * from "./secrets.ts";

// Parts that later V01 tasks build report "not-implemented" until then, never a guessed state.
// "unavailable" names why, so the UI can show what does not work (V01-R5).
export const ComponentStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ready") }),
  z.object({ state: z.literal("rebuilding") }),
  z.object({ state: z.literal("unavailable"), reason: z.string().min(1) }),
  z.object({ state: z.literal("not-implemented") }),
]);
export type ComponentStatus = z.infer<typeof ComponentStatusSchema>;

const EmbeddingEgressSchema = z.enum(["local", "external"]) satisfies z.ZodType<EmbeddingEgress>;

/**
 * The configured EmbeddingProvider's state and egress. Only the API reports
 * "not-implemented" (no embedder bound); an unavailable entry without egress is
 * one whose embedder could not be read at all.
 */
export const EmbeddingStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ready"), egress: EmbeddingEgressSchema }),
  z.object({ state: z.literal("model-missing"), egress: EmbeddingEgressSchema }),
  z.object({ state: z.literal("preparing"), egress: EmbeddingEgressSchema }),
  z.object({
    state: z.literal("unavailable"),
    reason: z.string().min(1),
    egress: EmbeddingEgressSchema.optional(),
  }),
  z.object({ state: z.literal("not-implemented") }),
]);
export type EmbeddingStatusEntry = z.infer<typeof EmbeddingStatusSchema>;

/**
 * One invalidation record (I04-R4): what a source change removed and recomputed,
 * counted per registered derivative kind. No title, body, quote or identifier;
 * `sourceId` is the internal id. For a tombstone, `changeKind` is its reason.
 */
const InvalidationSchema = z.object({
  changeSeq: z.int().nonnegative(),
  sourceId: z.int().positive(),
  changeKind: z.enum([
    "new-version",
    "old-versions-pruned",
    "scope-changed",
    "source-deleted",
    "access-revoked",
    "user-deleted",
  ]),
  removedByKind: z.record(z.string(), z.int().nonnegative()),
  recomputedByKind: z.record(z.string(), z.int().nonnegative()),
  at: z.string(),
});
export type InvalidationSummary = z.infer<typeof InvalidationSchema>;

export const ErrorResponseSchema = z.object({
  error: z.enum([
    "bad-request",
    "unauthorized",
    "forbidden-host",
    "forbidden-origin",
    "not-found",
    "method-not-allowed",
    "connector-unavailable",
    "destination-unavailable",
    "consent-stale",
    "invalid-endpoint",
    "secret-store-unavailable",
    "embedding-not-implemented",
    "embedding-busy",
    "instance-busy",
    "storage-failed",
    "ledger-unwritable",
    "payload-too-large",
    "internal-error",
  ]),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

// "not-implemented" is a site Connector placeholder (V01-R18); "unavailable" failed to
// initialize, or, with reason "unsupported-sdk-version", was never initialized because
// it implements another Connector SDK version (I01-R1).
export const ConnectorListResponseSchema = z.object({
  connectors: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      state: z.enum(["ready", "not-implemented", "unavailable"]),
      reason: z.literal("unsupported-sdk-version").optional(),
      // set (only then) after a rescan of a Connector that does not report deletions on
      // rescan: sources deleted while the cursor was expired may still be shown (I01-R17)
      deletionsMayBeMissed: z.boolean().optional(),
    }),
  ),
});
export type ConnectorSummary = z.infer<typeof ConnectorListResponseSchema>["connectors"][number];

export const SyncRequestSchema = z.strictObject({ connectorId: z.string().min(1) });

/**
 * Why a sync stopped before its last page (I01-R19's closed list). The pages stored
 * before it stay and the cursor is the last stored one. `unsupported-sdk-version` is a
 * Connector's state, not a stop (I01-R1).
 */
export const SYNC_STOP_CODES = [
  "invalid-page",
  "no-progress",
  "cursor-expired",
  "rate-limited",
  "connector-error",
  "connector-failed",
  "aborted",
  "instance-busy",
  "storage-failed",
] as const;
export type SyncStopCode = (typeof SYNC_STOP_CODES)[number];

/**
 * What one sync did (I01-R19). `received` counts changes read from the pages stored;
 * `created` the new source versions (same content makes none). The other counts say
 * what became of the rest: `unchanged`, `scopeUpdated`, `stale` (an older revision),
 * `staleTombstone` (a delete below the revision the store holds: not applied, but
 * shown), `blocked` (refused at a tombstone's door), `tombstoned` (sources deleted or
 * revoked). `rejected` lists the first records refused by place and code, never
 * content; `rejectedCount` counts them all. `stopped` is absent when the last page
 * was stored; `retryAfterMs` is the origin's last request, for `rate-limited`.
 */
export const SyncResponseSchema = z.object({
  connectorId: z.string(),
  received: z.int().nonnegative(),
  created: z.int().nonnegative(),
  unchanged: z.int().nonnegative(),
  scopeUpdated: z.int().nonnegative(),
  stale: z.int().nonnegative(),
  staleTombstone: z.int().nonnegative(),
  blocked: z.int().nonnegative(),
  tombstoned: z.int().nonnegative(),
  rejected: z.array(z.object({ at: z.string(), code: z.enum(REJECT_CODES) })),
  rejectedCount: z.int().nonnegative(),
  rescanned: z.boolean(),
  deletionsMayBeMissed: z.boolean(),
  stopped: z.enum(SYNC_STOP_CODES).optional(),
  retryAfterMs: z.number().nonnegative().optional(),
});
export type SyncResponse = z.infer<typeof SyncResponseSchema>;

// Screen reads (V01-R3). `id` is the source version shown: always the source's latest.
// A source is connector instance + namespace + external id (I01-R8).
const SourceSummarySchema = z.object({
  id: z.int(),
  connectorId: z.string(),
  namespace: z.string(),
  externalId: z.string(),
  title: z.string(),
});
export const SourceListResponseSchema = z.object({ sources: z.array(SourceSummarySchema) });
export type SourceSummary = z.infer<typeof SourceSummarySchema>;

export const SourceSearchRequestSchema = z.strictObject({ query: z.string().min(1).max(200) });

/**
 * The Sources screen's delete request (V02-R12): every version of the source is
 * purged and a tombstone (reason `user-deleted`) keeps it from coming back.
 * `already-deleted`: purged before, nothing changed.
 */
export const SourceDeleteRequestSchema = z.strictObject({
  connectorId: z.string().min(1),
  /** Required: one external id may name a source in several namespaces (I01-R8). */
  namespace: z.string(),
  externalId: z.string().min(1),
});
export const SourceDeleteResponseSchema = z.object({
  outcome: z.enum(["deleted", "already-deleted"]),
});

/**
 * The user's way back (I04-R9): the sources a tombstone blocks and the lift of one.
 * Only the user's request lifts. A purged source's identity is no longer kept in
 * the clear (I04-R7), so the list names a source by an opaque `id` (the local
 * handle the lift takes), its connector instance, the reason and when. A lift
 * deletes and restores nothing: the source can only be received again.
 * `unchanged`: already lifted, no tombstone, or no such id.
 */
const TombstonedSourceSchema = z.object({
  id: z.int().positive(),
  connectorId: z.string(),
  reason: z.enum(["user-deleted", "source-deleted", "access-revoked"]),
  coversVersion: z.int().nonnegative(),
  at: z.string(),
});
export const TombstoneListResponseSchema = z.object({
  tombstones: z.array(TombstonedSourceSchema),
});
export const TombstoneLiftRequestSchema = z.strictObject({ id: z.int().positive() });
export const TombstoneLiftResponseSchema = z.object({ outcome: z.enum(["lifted", "unchanged"]) });

/**
 * One provider call attempt (ADR 0014: no body, prompt, response or secret).
 * `destination` and `policyVersion` are null for an attempt blocked before the
 * egress decision named them; `reason` is the code of a blocked attempt.
 * `egress` is how the screen labels it: a CLI call is "external" too.
 */
const ProviderCallSchema = z.object({
  requestId: z.string(),
  attempt: z.int().positive(),
  provider: z.string(),
  egress: z.enum(["external", "local"]),
  destination: z.string().nullable(),
  taskKind: z.string(),
  classification: z.string(),
  policyVersion: z.string().nullable(),
  outcome: z.string(),
  reason: z.string().nullable(),
  durationMs: z.int().nonnegative().nullable(),
  createdAt: z.string(),
});
export const ActivityResponseSchema = z.object({ calls: z.array(ProviderCallSchema) });
export type ProviderCall = z.infer<typeof ProviderCallSchema>;

/**
 * `databaseEncryption` is what the canonical file is, read from the file itself
 * (ADR 0010): "not-applied" for a plain SQLite file, "unknown" when it cannot tell.
 */
export const SettingsResponseSchema = z.object({
  dataDirectory: z.string(),
  schemaVersion: z.int().nonnegative(),
  databaseEncryption: z.enum(["not-applied", "unknown"]),
  /**
   * The OpenAI-compatible endpoint and model (site-setup S05); null until set.
   * `keyName` is where the key for this endpoint's `host` is stored (keys are bound
   * to a host), `key` whether it is there; both null without an endpoint.
   */
  openaiCompatible: z.object({
    baseUrl: z.string().nullable(),
    model: z.string().nullable(),
    host: z.string().nullable(),
    keyName: z.string().nullable(),
    key: z.enum(["present", "missing", "unavailable"]).nullable(),
  }),
});

/**
 * Writes the OpenAI-compatible endpoint and model. The address must be `https`, or
 * `http` to loopback (which only development and test builds then use); it may not
 * carry user info, a query or a fragment ("invalid-endpoint"). Changing its host
 * makes the consent for that Provider stale.
 */
export const SettingsWriteRequestSchema = z.strictObject({
  openaiCompatible: z.strictObject({
    baseUrl: z.string().min(1).max(2048),
    model: z.string().min(1).max(200),
  }),
});

const DataClassSchema = z.enum(DATA_CLASSES);
const ProviderIdSchema = z.enum(PROVIDER_IDS);

/**
 * Consent per Provider (ADR 0014). A consent holds the destination and policy
 * version it was given for; it is "valid" only while both still match.
 */
const ConsentSchema = z.object({
  allowedClasses: z.array(DataClassSchema),
  destination: z.string(),
  policyVersion: z.string(),
  grantedAt: z.string(),
  state: z.enum(["valid", "stale-destination", "stale-policy"]),
});
export const ConsentListResponseSchema = z.object({
  /** Computed from every rule in force; it changes when any rule changes. */
  policyVersion: z.string(),
  classes: z.array(DataClassSchema),
  providers: z.array(
    z.object({
      providerId: ProviderIdSchema,
      egress: z.enum(["external", "local"]),
      /** Where this Provider's requests go now; null with the problem when unknown. */
      destination: z.string().nullable(),
      destinationProblem: z.enum(["destination-unavailable", "insecure-endpoint"]).nullable(),
      consent: ConsentSchema.nullable(),
    }),
  ),
});
export type ConsentList = z.infer<typeof ConsentListResponseSchema>;

/**
 * The user picks the classes to allow; nothing is picked by default. The grant
 * repeats the destination and policy version the screen showed, and is refused
 * ("consent-stale") when either is no longer current, so a consent never binds
 * to a destination the user did not see.
 */
export const ConsentGrantRequestSchema = z.strictObject({
  providerId: ProviderIdSchema,
  allowedClasses: z.array(DataClassSchema).min(1),
  /** Empty when the screen showed none; then the grant is refused like any mismatch. */
  destination: z.string(),
  policyVersion: z.string().min(1),
});
export const ConsentRevokeRequestSchema = z.strictObject({ providerId: ProviderIdSchema });

/**
 * The connection test (V01-R21): one structured call with the build's fixed
 * synthetic material, through the Broker like any other call. The screen sends
 * `acknowledgeUnverified` only after the user confirmed the unverified-isolation
 * warning for this one call; it is never stored.
 */
export const ConnectionTestRequestSchema = z.strictObject({ acknowledgeUnverified: z.boolean() });

/** One Provider's answer to the version and login status queries (V01-R9). */
const ProviderCheckSchema = z.object({
  providerId: ProviderIdSchema,
  installed: z.boolean(),
  version: z.string().nullable(),
  authentication: z.enum(["authenticated", "unauthenticated", "unknown"]),
  /** Found but its run folder root is refused (ProviderInfo.problem): nothing can run. */
  problem: z.enum(["cli-runs-root-refused"]).optional(),
});
export type ProviderCheck = z.infer<typeof ProviderCheckSchema>;

/**
 * Whether the user's default Provider could take a call now (V01-R5, T16): none is
 * chosen, its CLI is missing or logged out (with what the two queries found, so
 * Home can guide), or the egress rules would stop a general document going to it.
 * `reason` is a code, never Provider text. "ready" decides nothing: every call is
 * still judged by the Broker.
 */
export const ProviderStatusSchema = z.discriminatedUnion("state", [
  /** `check` only for a CLI whose login could not be confirmed: Home guides as Settings does. */
  z.object({
    state: z.literal("ready"),
    providerId: ProviderIdSchema,
    check: ProviderCheckSchema.optional(),
  }),
  z.object({
    state: z.literal("unavailable"),
    providerId: ProviderIdSchema.nullable(),
    reason: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    check: ProviderCheckSchema.optional(),
  }),
]);
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

const LedgerHistoryEntry = z.object({
  total: z.int().nonnegative(),
  last: z.string().nullable(),
});

export const StatusResponseSchema = z.object({
  backend: ComponentStatusSchema,
  provider: ProviderStatusSchema,
  embedding: EmbeddingStatusSchema,
  vectorIndex: ComponentStatusSchema,
  /**
   * I04-R4; Activity shows it (I03-T11). `recent`: the latest records, newest
   * first. `scopePolicyDrops` (I04-T09): how many items the scope policy left out
   * of an extraction and whose source has not been extracted again (the rows of
   * `scope_policy_drops`; a number, never an item).
   */
  invalidations: z.object({
    recent: z.array(InvalidationSchema),
    scopePolicyDrops: z.number().int().nonnegative(),
  }),
  /**
   * I04-R6, the screen's "데이터 보호" item. `legacyCleanup`: `pending` while the
   * one-time clean-up of earlier deletions' traces (FTS optimize + VACUUM) has not
   * finished, e.g. no room for the VACUUM copy: the item reads "이전 삭제의 흔적
   * 정리 실패" and the next start tries again.
   * `ledger` (I04-R17, I04-T10): the tombstone ledger beside the database. `state`: `ok`;
   * `missing-created` (no ledger file although the database holds data: deletions made after a
   * backup are unknown, a new ledger was started); `degraded` (a cancel line could not be written:
   * canonical writes are refused until the next start). The rest are counts of the last start:
   * lines carried over again, lines that could not be (unknown instance, no kind), lines ignored
   * as cut or unreadable, and the ledgers set aside (another installation's, or a damaged header)
   * with the deletions they hold. Integers and fixed codes only; no identifier.
   */
  dataProtection: z.object({
    legacyCleanup: z.enum(["done", "pending"]),
    ledger: z.object({
      state: z.enum(["ok", "missing-created", "degraded"]),
      reapplied: z.int().nonnegative(),
      unrecoverable: z.int().nonnegative(),
      /** Tombstones left out of a new or completed ledger because their line would not be readable. */
      unwritable: z.int().nonnegative(),
      ignoredLines: z.int().nonnegative(),
      setAsideLedgers: z.int().nonnegative(),
      setAsideDeletions: z.int().nonnegative(),
      /**
       * What the ledger had to do at any start so far, with the time of the last one: the current
       * state above may be `ok` again, this does not vanish. Clearing it is a follow-up (an
       * acknowledge action); set-aside ledgers show until the files are removed.
       */
      history: z.object({
        missingCreated: LedgerHistoryEntry,
        setAside: LedgerHistoryEntry,
        unrecoverable: LedgerHistoryEntry,
        ignoredLines: LedgerHistoryEntry,
        reapplied: LedgerHistoryEntry,
        seeded: LedgerHistoryEntry,
      }),
    }),
  }),
});
export type StatusResponse = z.infer<typeof StatusResponseSchema>;

/** A code, never Provider text: a block reason, a Broker rejection. */
const ReasonCode = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/**
 * "ok": the Provider answered in shape; `isolation` is set for a CLI call.
 * "blocked": a decision stopped it before the Provider ran (e.g. no consent, a
 * CLI combination not verified, "unverified-ack-required" when the development
 * build needs the user's confirmation first). "failed": the Provider ran but did
 * not answer in shape (`reason`: timeout, rate-limited, provider-error,
 * invalid-output). "rejected": the Broker refused the request itself.
 * `reason` is null exactly for "ok"; `isolation` is null for anything but a CLI's "ok".
 */
export const ConnectionTestResponseSchema = z.object({
  outcome: z.enum(["ok", "blocked", "failed", "rejected"]),
  reason: ReasonCode.nullable(),
  isolation: z.enum(["verified", "unverified"]).nullable(),
  /**
   * When a test that did not succeed went to a CLI that is not installed or not
   * logged in: what its two queries found, so the screen can guide (V01-R5). A
   * listed-only gate reports a missing CLI as `cli-not-verified`; this says why.
   */
  providerCheck: ProviderCheckSchema.optional(),
});
export type ConnectionTestResult = z.infer<typeof ConnectionTestResponseSchema>;

/** Runtime execution settings (site-setup.md `providers.cli.background`): default off. */
export const ExecutionSettingsSchema = z.strictObject({ cliBackground: z.boolean() });
export type ExecutionSettings = z.infer<typeof ExecutionSettingsSchema>;

/**
 * The bound Providers and the user's default (V01-R9, C4): the Broker calls the
 * default and nothing else; null until the user picks one (nothing is picked for
 * them). Reading this list runs no process.
 */
export const ProviderListResponseSchema = z.object({
  defaultProvider: ProviderIdSchema.nullable(),
  providers: z.array(
    z.object({ providerId: ProviderIdSchema, transport: z.enum(["cli", "http"]) }),
  ),
});
export type ProviderList = z.infer<typeof ProviderListResponseSchema>;

/** Picks the default; a Provider that is not bound is "not-found". */
export const DefaultProviderRequestSchema = z.strictObject({ providerId: ProviderIdSchema });

/**
 * Each bound Provider's answer to the two queries that need no decision (V01-R9):
 * the version query and the login status query, with fixed arguments and no
 * input. The screen turns them into install and login guidance (V01-R5).
 */
export const ProviderCheckResponseSchema = z.object({
  providers: z.array(ProviderCheckSchema),
});

/**
 * Starts preparing the embedding model (V01-R14, ADR 0006): from a local pack
 * folder, or by the approved download of the pinned files. Only this request
 * starts one. The revision and file hashes are build resources, not request fields.
 */
export const EmbeddingPrepareRequestSchema = z.strictObject({
  source: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("download") }),
    z.strictObject({ kind: z.literal("local-pack"), path: z.string().min(1).max(4096) }),
  ]),
});
/** Answered at once with the state the start left; a download takes minutes. */
export const EmbeddingPrepareResponseSchema = z.object({ embedding: EmbeddingStatusSchema });

/**
 * Home's Insights (V02-R14): active rows only. An Insight is a rule's inference
 * (V02-R9); "inferred" is the only epistemic type the schema lets through, so a
 * row of any other type fails the response check instead of reaching the screen.
 */
const InsightSummarySchema = z.object({
  id: z.int().positive(),
  epistemic: z.literal("inferred"),
  summary: z.string(),
  evidenceCount: z.int().nonnegative(),
});
export const InsightListResponseSchema = z.object({ insights: z.array(InsightSummarySchema) });
export type InsightSummary = z.infer<typeof InsightSummarySchema>;

export const InsightEvidenceRequestSchema = z.strictObject({ insightId: z.int().positive() });

/**
 * One evidence row of an Insight: the fact or relation it supports (with that
 * row's status, superseded included), the quote, and the source version it points
 * to, numbered per source; `current` is whether that version is the source's latest.
 */
const EvidenceSummarySchema = z.object({
  id: z.int().positive(),
  target: z.enum(["fact", "relation"]),
  status: z.enum(["candidate", "verified", "disputed", "superseded", "rejected"]),
  quote: z.string(),
  sourceTitle: z.string(),
  sourceVersionId: z.int().positive(),
  version: z.int().positive(),
  current: z.boolean(),
  /** I01-R29: the locator of the block holding the span's start, null without one. */
  locator: NativeLocatorSchema.nullable(),
});
export const InsightEvidenceResponseSchema = z.object({
  insight: InsightSummarySchema,
  evidence: z.array(EvidenceSummarySchema),
});
export type EvidenceSummary = z.infer<typeof EvidenceSummarySchema>;

export const EvidenceSourceRequestSchema = z.strictObject({ evidenceId: z.int().positive() });

/**
 * The version an evidence row points to, read by its version id (never swapped for
 * the source's latest), and the span: [start, end) in Unicode code points of
 * `body`, not UTF-16 units. The body is imported, untrusted text.
 */
export const EvidenceSourceResponseSchema = z.object({
  evidenceId: z.int().positive(),
  quote: z.string(),
  start: z.int().nonnegative(),
  end: z.int().nonnegative(),
  /** I01-R29: computed on read from the version's blocks; null without blocks or in a gap. */
  locator: NativeLocatorSchema.nullable(),
  sourceVersion: z.object({
    id: z.int().positive(),
    version: z.int().positive(),
    latestVersion: z.int().positive(),
    title: z.string(),
    body: z.string(),
  }),
});
export type EvidenceSource = z.infer<typeof EvidenceSourceResponseSchema>;

/**
 * The Activity screen's job area (I03-R23). Everything here is a code, an id or a count:
 * no source text and no Provider text reaches it (a job row holds none), so a screen can
 * word every code itself. Times are ISO strings like the call history's.
 */
const JobCode = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const JOB_STATUS_VALUES = [
  "queued",
  "running",
  "retry",
  "held",
  "succeeded",
  "superseded",
  "cancelled",
  "dead_letter",
] as const;
export const JobStatusSchema = z.enum(JOB_STATUS_VALUES);
export type JobStatusValue = z.infer<typeof JobStatusSchema>;

export const JobSummarySchema = z.object({
  id: z.int().positive(),
  kind: JobCode,
  /** A Connector instance, a projection name, or a re-extraction's target; '' when the kind has none. */
  target: z.string().max(200),
  /** The internal source id, never its title: a title is imported text. */
  sourceId: z.int().positive().nullable(),
  status: JobStatusSchema,
  /** Why the job is held, retrying or ended (a skip too), as a code. */
  reason: JobCode.nullable(),
  attempts: z.int().nonnegative(),
  maxAttempts: z.int().positive(),
  priority: z.enum(["user", "scheduled", "maintenance"]),
  /** The next run time of a queued or retrying job (a held job's has no meaning, an ended job's is past). */
  runAfter: z.string(),
  finishedAt: z.string().nullable(),
  cancelRequested: z.boolean(),
  /** What a finished run counted (a sync's received, created, ...; a cleanup's purged): whole numbers only. */
  resultCounts: z.record(z.string().max(40), z.int().nonnegative()).nullable(),
});
export type JobSummary = z.infer<typeof JobSummarySchema>;

const LocalTimeSchema = z.strictObject({
  hour: z.int().min(0).max(23),
  minute: z.int().min(0).max(59),
});
export const SchedulePeriodSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("every-10-minutes") }),
  z.strictObject({ kind: z.literal("hourly") }),
  z.strictObject({ kind: z.literal("daily"), at: LocalTimeSchema }),
  z.strictObject({
    kind: z.literal("weekly"),
    weekday: z.literal([0, 1, 2, 3, 4, 5, 6]),
    at: LocalTimeSchema,
  }),
]);
export type SchedulePeriod = z.infer<typeof SchedulePeriodSchema>;

export const ScheduleSummarySchema = z.object({
  id: z.int().positive(),
  kind: JobCode,
  target: z.string().max(200),
  period: SchedulePeriodSchema,
  zone: z.string().max(100),
  enabled: z.boolean(),
  nextDue: z.string(),
  lastRunSlot: z.string().nullable(),
  /** Slots the latest check found due but not run (a sleep or a closed app). */
  lastMissed: z.int().nonnegative(),
  counts: z.object({
    registered: z.int().nonnegative(),
    coalesced: z.int().nonnegative(),
    heldCoalesced: z.int().nonnegative(),
    skipped: z.int().nonnegative(),
    alreadyRan: z.int().nonnegative(),
  }),
  /** Why it registers nothing: its job gave up (the error code) or its job is held (the reason). */
  pause: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("failed"), code: JobCode }),
      z.object({ kind: z.literal("held"), reason: JobCode }),
    ])
    .optional(),
  /** A cleanup period cannot pause: its last failure's code stays here until a run succeeds. */
  warning: JobCode.optional(),
});
export type ScheduleSummary = z.infer<typeof ScheduleSummarySchema>;

export const ProjectionActivitySchema = z.object({
  name: z.string().max(100),
  /** Removals not finished (queued, running, retrying, held) and removals given up. */
  openRemoves: z.int().nonnegative(),
  deadRemoves: z.int().nonnegative(),
  /** `repeating`: rebuilds keep being given up and registered again (I03-R7): the projection is not usable. */
  rebuild: z.enum(["none", "pending", "repeating"]),
});
export type ProjectionActivity = z.infer<typeof ProjectionActivitySchema>;

export const JobsResponseSchema = z.object({
  /** Every status, over all rows. */
  counts: z.record(JobStatusSchema, z.int().nonnegative()),
  /** Newest first, at most `limit`; `truncated` when more rows exist. */
  jobs: z.array(JobSummarySchema),
  truncated: z.boolean(),
  schedules: z.array(ScheduleSummarySchema),
  projections: z.array(ProjectionActivitySchema),
  /** The Broker's call budget in its window; null while no Broker is bound. */
  budget: z
    .object({
      used: z.int().nonnegative(),
      maxCalls: z.int().positive(),
      windowMs: z.int().positive(),
      resetsAt: z.string().nullable(),
    })
    .nullable(),
  /** Rows (jobs, periods, projections) the answer left out because they did not fit this schema; never an error for the whole list. */
  unreadable: z.int().nonnegative(),
  /** Unfinished jobs of every kind against the cap; `warning` from 90% of it. */
  backlog: z.object({ open: z.int().nonnegative(), cap: z.int().positive(), warning: z.boolean() }),
});
export type JobsResponse = z.infer<typeof JobsResponseSchema>;

export const JobIdRequestSchema = z.strictObject({ id: z.int().positive() });
/** A user action answers 200 with what became of it; a job or schedule that is gone is `not-found`. */
export const CancelJobResponseSchema = z.object({
  outcome: z.enum([
    "cancelled",
    "requested",
    "finished",
    "not-cancellable",
    /** A projection removal: only the projection's rebuild closes its mark (I03-R7). */
    "not-allowed",
    "not-found",
    "unavailable",
  ]),
});
export const RetryJobResponseSchema = z.object({
  outcome: z.enum(["queued", "not-retryable", "duplicate-open", "not-found", "unavailable"]),
});
export const DiscardJobResponseSchema = z.object({
  outcome: z.enum(["discarded", "not-dead-letter", "not-allowed", "not-found", "unavailable"]),
});
export const ScheduleChangeRequestSchema = z.strictObject({
  id: z.int().positive(),
  period: SchedulePeriodSchema,
});
export const ScheduleActionResponseSchema = z.object({
  outcome: z.enum(["done", "not-found", "unavailable"]),
  schedule: ScheduleSummarySchema.optional(),
});
export const RunScheduleResponseSchema = z.object({
  /** `started`: a job was registered; `already-open`: one was open, and it stays the one. */
  outcome: z.enum(["started", "already-open", "not-found", "unavailable"]),
  jobId: z.int().positive().optional(),
});
export const RebuildProjectionRequestSchema = z.strictObject({
  projection: z.string().min(1).max(100),
});
export const RebuildProjectionResponseSchema = z.object({
  outcome: z.enum(["requested", "already-open", "unknown-projection", "unavailable"]),
});

/**
 * Where the screens get the backend address and token: the dev server in the browser,
 * the preload in Electron (V01-R3). An empty `baseUrl` means the page's own origin.
 */
export const SessionSchema = z.object({ baseUrl: z.string(), token: z.string().min(32) });
export type Session = z.infer<typeof SessionSchema>;

export const routes = {
  status: { method: "GET", path: "/api/status", response: StatusResponseSchema },
  connectors: { method: "GET", path: "/api/connectors", response: ConnectorListResponseSchema },
  syncConnector: {
    method: "POST",
    path: "/api/connectors/sync",
    request: SyncRequestSchema,
    response: SyncResponseSchema,
  },
  importJsonl: {
    method: "POST",
    path: "/api/import/jsonl",
    request: ImportJsonlRequestSchema,
    response: ImportJsonlResponseSchema,
  },
  // I01-R24: one JSONL text for one instance, stored by the sync's own page store; the answer
  // is a sync's result (`connectorId` is the instance), with the refused lines in `rejected`
  imports: {
    method: "POST",
    path: "/api/imports",
    request: ImportRequestSchema,
    response: SyncResponseSchema,
  },
  sources: { method: "GET", path: "/api/sources", response: SourceListResponseSchema },
  searchSources: {
    method: "POST",
    path: "/api/sources/search",
    request: SourceSearchRequestSchema,
    response: SourceListResponseSchema,
  },
  deleteSource: {
    method: "POST",
    path: "/api/sources/delete",
    request: SourceDeleteRequestSchema,
    response: SourceDeleteResponseSchema,
  },
  tombstones: { method: "GET", path: "/api/tombstones", response: TombstoneListResponseSchema },
  liftTombstone: {
    method: "POST",
    path: "/api/tombstones/lift",
    request: TombstoneLiftRequestSchema,
    response: TombstoneLiftResponseSchema,
  },
  activity: { method: "GET", path: "/api/activity", response: ActivityResponseSchema },
  jobs: { method: "GET", path: "/api/jobs", response: JobsResponseSchema },
  cancelJob: {
    method: "POST",
    path: "/api/jobs/cancel",
    request: JobIdRequestSchema,
    response: CancelJobResponseSchema,
  },
  retryJob: {
    method: "POST",
    path: "/api/jobs/retry",
    request: JobIdRequestSchema,
    response: RetryJobResponseSchema,
  },
  discardJob: {
    method: "POST",
    path: "/api/jobs/discard",
    request: JobIdRequestSchema,
    response: DiscardJobResponseSchema,
  },
  changeSchedule: {
    method: "POST",
    path: "/api/schedules/change",
    request: ScheduleChangeRequestSchema,
    response: ScheduleActionResponseSchema,
  },
  disableSchedule: {
    method: "POST",
    path: "/api/schedules/disable",
    request: JobIdRequestSchema,
    response: ScheduleActionResponseSchema,
  },
  enableSchedule: {
    method: "POST",
    path: "/api/schedules/enable",
    request: JobIdRequestSchema,
    response: ScheduleActionResponseSchema,
  },
  runSchedule: {
    method: "POST",
    path: "/api/schedules/run",
    request: JobIdRequestSchema,
    response: RunScheduleResponseSchema,
  },
  rebuildProjection: {
    method: "POST",
    path: "/api/projections/rebuild",
    request: RebuildProjectionRequestSchema,
    response: RebuildProjectionResponseSchema,
  },
  settings: { method: "GET", path: "/api/settings", response: SettingsResponseSchema },
  writeSettings: {
    method: "POST",
    path: "/api/settings",
    request: SettingsWriteRequestSchema,
    response: SettingsResponseSchema,
  },
  consents: { method: "GET", path: "/api/consents", response: ConsentListResponseSchema },
  grantConsent: {
    method: "POST",
    path: "/api/consents",
    request: ConsentGrantRequestSchema,
    response: ConsentListResponseSchema,
  },
  revokeConsent: {
    method: "POST",
    path: "/api/consents/revoke",
    request: ConsentRevokeRequestSchema,
    response: ConsentListResponseSchema,
  },
  connectionTest: {
    method: "POST",
    path: "/api/connection-test",
    request: ConnectionTestRequestSchema,
    response: ConnectionTestResponseSchema,
  },
  executionSettings: {
    method: "GET",
    path: "/api/settings/execution",
    response: ExecutionSettingsSchema,
  },
  setExecutionSettings: {
    method: "POST",
    path: "/api/settings/execution",
    request: ExecutionSettingsSchema,
    response: ExecutionSettingsSchema,
  },
  providers: { method: "GET", path: "/api/providers", response: ProviderListResponseSchema },
  setDefaultProvider: {
    method: "POST",
    path: "/api/providers/default",
    request: DefaultProviderRequestSchema,
    response: ProviderListResponseSchema,
  },
  checkProviders: {
    method: "POST",
    path: "/api/providers/check",
    response: ProviderCheckResponseSchema,
  },
  prepareEmbedding: {
    method: "POST",
    path: "/api/embedding/prepare",
    request: EmbeddingPrepareRequestSchema,
    response: EmbeddingPrepareResponseSchema,
  },
  insights: { method: "GET", path: "/api/insights", response: InsightListResponseSchema },
  insightEvidence: {
    method: "POST",
    path: "/api/insights/evidence",
    request: InsightEvidenceRequestSchema,
    response: InsightEvidenceResponseSchema,
  },
  evidenceSource: {
    method: "POST",
    path: "/api/evidence/source",
    request: EvidenceSourceRequestSchema,
    response: EvidenceSourceResponseSchema,
  },
} as const;
export type RouteName = keyof typeof routes;
export type RouteResponse<Name extends RouteName> = z.infer<(typeof routes)[Name]["response"]>;
export type RouteRequest<Name extends RouteName> = (typeof routes)[Name] extends {
  request: z.ZodType<infer Request>;
}
  ? Request
  : undefined;
