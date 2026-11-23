// Single schema source for the local HTTP API (V01-R2). The UI and the backend
// both import these; TypeScript types come from z.infer, JSON Schema from z.toJSONSchema.
import { z } from "zod";
import type { EmbeddingEgress } from "./embedding.ts";
import {
  AnalyticalCheckRequestSchema,
  AnalyticalCheckResponseSchema,
  AnalyticalListSchema,
  SemanticPiecesSchema,
} from "./analytical-types.ts";
import { AttachmentSchema, NativeLocatorSchema } from "./connector.ts";
import {
  ImportJsonlRequestSchema,
  ImportJsonlResponseSchema,
  ImportRequestSchema,
} from "./import-record.ts";
import { REJECT_CODES } from "./connector.ts";
import { DATA_CHECK_NAMES, FACT_VALUE_TYPES, KNOWLEDGE_PLACES } from "./knowledge-schema.ts";
import {
  LocalApprovalRequestSchema,
  LocalConfirmDeletionsRequestSchema,
  LocalFilesSettingsPatchSchema,
  LocalFilesSettingsSchema,
  LocalLocationIdRequestSchema,
  LocalLocationListSchema,
  LocalLocationSchema,
  LocalReimportRequestSchema,
  LocalReimportResponseSchema,
  LocalRelinkRequestSchema,
  LocalRevokeRequestSchema,
  LocalRevokeResponseSchema,
  LocalSkippedRequestSchema,
  LocalSkippedResponseSchema,
  LocalSourceInfoRequestSchema,
  LocalSourceInfoResponseSchema,
} from "./local-files.ts";
import {
  FeedbackListResponseSchema,
  FeedbackRecordRequestSchema,
  FeedbackRecordResponseSchema,
  FeedbackUndoRequestSchema,
  FeedbackUndoResponseSchema,
} from "./feedback-types.ts";
import { INSIGHT_TYPE_NAMES } from "./insight-types.ts";
import {
  ExploreItemRequestSchema,
  ExploreItemResponseSchema,
  ExploreItemsRequestSchema,
  ExploreItemsResponseSchema,
  ExploreSourceRequestSchema,
  ExploreSourceResponseSchema,
} from "./explore.ts";
import { DATA_CLASSES, PROVIDER_IDS } from "./provider.ts";
import { SourceThreadRequestSchema, SourceThreadResponseSchema } from "./thread.ts";

export * from "./adapter-errors.ts";
export * from "./analytical-types.ts";
export * from "./ask.ts";
export * from "./explore.ts";
export * from "./thread.ts";
export type * from "./embedding.ts";
export type * from "./knowledge-engine.ts";
export type * from "./vector-index.ts";
export * from "./cell-grammar.ts";
export * from "./connector.ts";
export * from "./feedback-types.ts";
export * from "./import-record.ts";
export * from "./insight-types.ts";
export * from "./knowledge-schema.ts";
export * from "./local-files.ts";
export * from "./provider.ts";
export * from "./secrets.ts";
export * from "./site-scopes.ts";

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
    "ledger-degraded",
    "count-mismatch",
    "not-lifted",
    "approval-rejected",
    "limit-would-delete",
    "payload-too-large",
    "internal-error",
  ]),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/** Why an instance whose credentials cannot be used is unavailable (I06-R9); decided from the store's answers. */
export const CREDENTIAL_REASONS = [
  "credential-store-unavailable",
  "credential-missing",
  "credential-unreadable",
  "credential-rejected",
] as const;
export type CredentialReason = (typeof CREDENTIAL_REASONS)[number];

// "not-implemented" is a site Connector placeholder (V01-R18); "unavailable" failed to
// initialize, or, with reason "unsupported-sdk-version", was never initialized because
// it implements another Connector SDK version (I01-R1). "instance-kind-mismatch": the stored data
// binds the instance id to another kind, so no object is made (I05F-R1).
export const ConnectorSummarySchema = z.object({
  id: z.string(),
  kind: z.string(),
  state: z.enum(["ready", "not-implemented", "unavailable"]),
  reason: z
    .enum(["unsupported-sdk-version", "instance-kind-mismatch", ...CREDENTIAL_REASONS])
    .optional(),
  // a Connector that declared slots (I06-R13): the stored name and the last presence check of each, never a value
  credentials: z
    .array(
      z.object({
        slot: z.string(),
        name: z.string(),
        state: z.enum(["present", "missing", "unavailable"]),
      }),
    )
    .optional(),
  // set (only then) after a rescan of a Connector that does not report deletions on
  // rescan: sources deleted while the cursor was expired may still be shown (I01-R17)
  deletionsMayBeMissed: z.boolean().optional(),
});
export const ConnectorListResponseSchema = z.object({
  connectors: z.array(ConnectorSummarySchema),
});
export type ConnectorSummary = z.infer<typeof ConnectorListResponseSchema>["connectors"][number];

export const SyncRequestSchema = z.strictObject({ connectorId: z.string().min(1) });

/**
 * The change notice of a Connector's credential (I06-R12): the instance's ID and nothing else. The value
 * goes from the screen to the shell's store and never through the API, so the schema has no field for one.
 */
export const CredentialsChangedRequestSchema = z.strictObject({ connectorId: z.string().min(1) });

/**
 * The answer to a change notice: the instance's list summary and what became of the rebuild (I06-R12).
 * "done": this request ended a rebuild; "queued": one is under way or the gap of a rejected instance holds
 * it back; "skipped": the instance gave up its rechecks or has nothing to rebuild.
 */
export const CredentialsChangedResponseSchema = z.strictObject({
  summary: ConnectorSummarySchema,
  rebuild: z.enum(["done", "queued", "skipped"]),
});

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
  "credential-unusable",
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
 * The Sources screen's prune of one source's earlier versions (I04-R10, I04-T12): every version
 * below the latest is deleted, with the evidence on it and the knowledge only that evidence
 * supported. The source stays and no tombstone is written. `unchanged`: the source has no earlier
 * version (a repeat included). An unknown or purged source is `not-found`.
 */
export const VersionsPruneRequestSchema = SourceDeleteRequestSchema;
export const VersionsPruneResponseSchema = z.object({
  outcome: z.enum(["pruned", "unchanged"]),
  prunedVersions: z.number().int().min(0),
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

/** The Semantic setting (site-setup.md `semantic.autoVerify`, S01-R9): automatic promotion, default off. */
export const SemanticSettingsSchema = z.strictObject({
  autoVerify: z.boolean(),
  /** `semantic.autoDispute` (S02-R20): the policy disputes a verified fact on a new contradiction, default off. */
  autoDispute: z.boolean(),
  /** `wiki.summary` (K01-R12, R15): the Wiki's LLM summary, default off. */
  wikiSummary: z.boolean(),
  /** `insight.interpret` (P01-R17): the LLM interpretation of active Insights, default off. */
  insightInterpret: z.boolean(),
});
export type SemanticSettings = z.infer<typeof SemanticSettingsSchema>;
/** The write: `autoDispute` left out means unchanged. */
export const SemanticSettingsRequestSchema = z.strictObject({
  autoVerify: z.boolean(),
  autoDispute: z.boolean().optional(),
  wikiSummary: z.boolean().optional(),
  insightInterpret: z.boolean().optional(),
});

/**
 * The analytical semantic's runtime settings (S03-R5, R6, site-setup.md): `profile` is the switch of the
 * Dataset profile (default off: dark launch); `maxCells` bounds the size of a table the profile and the
 * checks read (default 200,000). The most is provisional.
 */
export const MAX_ANALYTICAL_CELLS = 10_000_000;
export const AnalyticalSettingsSchema = z.strictObject({
  profile: z.boolean(),
  maxCells: z.int().min(1).max(MAX_ANALYTICAL_CELLS),
});
export type AnalyticalSettings = z.infer<typeof AnalyticalSettingsSchema>;

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
const RankAxisSchema = z.int().min(0).max(100);
const InsightRankingSchema = z.object({
  relevance: RankAxisSchema,
  impact: RankAxisSchema,
  urgency: RankAxisSchema,
  novelty: RankAxisSchema,
  confidence: RankAxisSchema,
  actionability: RankAxisSchema,
  score: RankAxisSchema,
});
export const InsightSummarySchema = z.object({
  id: z.int().positive(),
  epistemic: z.literal("inferred"),
  summary: z.string(),
  evidenceCount: z.int().nonnegative(),
  /** P01-R13: the type, the rule's fact lines ([] on a legacy row), and who wrote the reason text. */
  type: z.enum(INSIGHT_TYPE_NAMES),
  factLines: z.array(z.string()),
  /** The interpretation's text when there is one, else the code's (P01-D12); no `.max`: the DB counts characters. */
  reasoningSummary: z.string().nullable(),
  /** Null exactly when `reasoningSummary` is. */
  reasoningBy: z.enum(["code", "llm"]).nullable(),
  confidence: z.int().min(0).max(100).nullable(),
  ranking: InsightRankingSchema,
  autoNotifyExcluded: z.boolean(),
});
export const InsightListResponseSchema = z.object({ insights: z.array(InsightSummarySchema) });
export type InsightSummary = z.infer<typeof InsightSummarySchema>;

/** P01-R16: the 13 types and whether each is supported, as the type table says. */
export const InsightTypeListResponseSchema = z.object({
  types: z.array(
    z.object({
      type: z.enum(INSIGHT_TYPE_NAMES),
      label: z.string(),
      judgedBy: z.enum(["code", "llm"]),
      status: z.enum(["supported", "unsupported"]),
      reason: z.string().nullable(),
    }),
  ),
});

export type InsightTypeListResponse = z.infer<typeof InsightTypeListResponseSchema>;

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
/**
 * A row the Insight used that the user wrote or approved with no current evidence (S01-R15): it has
 * no source span, so it is listed as "사용자 입력" by its target, id and status, with no text.
 */
const UserInputSummarySchema = z.object({
  target: z.enum(["fact", "relation"]),
  id: z.int().positive(),
  status: z.enum(["candidate", "verified", "disputed", "superseded", "rejected"]),
});
export const InsightEvidenceResponseSchema = z.object({
  insight: InsightSummarySchema,
  evidence: z.array(EvidenceSummarySchema),
  userInputs: z.array(UserInputSummarySchema),
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
  /** I02C-R6: the attachment of the block holding the span's start, read from the version's meta; else null. */
  attachment: AttachmentSchema.nullable(),
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
 * The Semantic registry's read and user actions (S01-R23, T02). A row is an item, a fact or a relation;
 * the list shows the registry's rows with their status and epistemic type (two columns that never
 * compute each other), the confidence the Provider gave (or null), and whether the user decided
 * or wrote the row. A refusal is a code from the lifecycle gate (`refused`), never a text; a row
 * that is not there, is hidden by the read gate or was deleted all answer `not-found`.
 * The history holds numbers and closed codes only, no name, value or quote (S01-R6).
 */
export const SemanticKindSchema = z.enum(["item", "fact", "relation"]);
export type SemanticKind = z.infer<typeof SemanticKindSchema>;
const SemanticStatusSchema = z.enum([
  "candidate",
  "verified",
  "disputed",
  "superseded",
  "rejected",
]);
const SemanticEpistemicSchema = z.enum(["explicit", "user-approved", "inferred", "hypothesis"]);
export const SEMANTIC_REFUSALS = [
  "invalid-transition",
  "user-override",
  "basis-required",
  "not-latest",
  "nothing-to-undo",
  "value-exists",
  /** A direct add's undo while rows, merge lines, distinct marks or split records still name the item (S02-R11). */
  "existing-data-violation",
  /** An approval of a check-needing fact whose data conditions are not all met (S03-R14); the names are in `unmet`. */
  "data-check-unmet",
] as const;
/** The data conditions an approval can name as unmet: the three set conditions, then a failed check (S03-R14). */
export const DATA_CHECK_UNMET = [
  "no-dataset",
  "spec-conflict",
  "check-missing",
  "schema",
  "grain",
  "join-cardinality",
  "aggregation",
] as const;
export const SemanticRefRequestSchema = z.strictObject({
  kind: SemanticKindSchema,
  id: z.int().positive(),
});
export const SemanticDecideRequestSchema = z.strictObject({
  kind: SemanticKindSchema,
  id: z.int().positive(),
  action: z.enum(["approve", "reject", "dispute"]),
});
/**
 * What the user may type into a direct add or a value fix (S01-R7, R18, R3). A name is an identifier
 * (letter first, then letters, digits, `_` and `.`, at most 40). A value or a name is text of 1 to
 * 500 code points after trimming (the length the spec gives a definition; provisional for the rest).
 * The check of a value's shape against its kind (a date) is the server's, which reads the kind.
 */
export const SEMANTIC_TEXT_MAX = 500;
const SemanticIdentifierSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,39}$/);
const SemanticTextSchema = z.string().refine((v) => {
  const length = [...v.trim()].length;
  return length >= 1 && length <= SEMANTIC_TEXT_MAX;
});
const SemanticIdSchema = z.int().positive();
export const SemanticUserEntrySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("item"),
    type: SemanticIdentifierSchema,
    name: SemanticTextSchema,
  }),
  z.strictObject({
    kind: z.literal("fact"),
    itemId: SemanticIdSchema,
    factKind: SemanticIdentifierSchema,
    /** Text, or the pieces of a value of several (S03-R3). */
    value: z.union([SemanticTextSchema, SemanticPiecesSchema]),
  }),
  z.strictObject({
    kind: z.literal("relation"),
    subjectId: SemanticIdSchema,
    type: SemanticIdentifierSchema,
    objectId: SemanticIdSchema,
  }),
]);
export type SemanticUserEntryRequest = z.infer<typeof SemanticUserEntrySchema>;
/** A direct add, or a fact's value fixed to the one the user wrote (one batch, S01-R7). */
export const SemanticCorrectRequestSchema = z.strictObject({
  correction: z.discriminatedUnion("action", [
    z.strictObject({ action: z.literal("add"), entry: SemanticUserEntrySchema }),
    z.strictObject({
      action: z.literal("replace"),
      id: SemanticIdSchema,
      value: z.union([SemanticTextSchema, SemanticPiecesSchema]),
    }),
  ]),
});
const SemanticRowSchema = z.object({
  id: z.int().positive(),
  status: SemanticStatusSchema,
  epistemic: SemanticEpistemicSchema,
  confidence: z.number().min(0).max(1).nullable(),
  /** The user took an action on it that no undo cancelled. */
  userDecided: z.boolean(),
  /** The user wrote the value (a direct add); false for every row extraction made. */
  userAuthored: z.boolean(),
});
export const SemanticFactSchema = SemanticRowSchema.extend({
  kind: z.string(),
  value: z.string(),
  context: z.string().nullable(),
  /** Evidence on the source's current version. */
  evidenceCount: z.int().nonnegative(),
});
export const SemanticRelationSchema = SemanticRowSchema.extend({
  type: z.string(),
  subjectId: z.int().positive(),
  objectId: z.int().positive(),
  evidenceCount: z.int().nonnegative(),
});
const SemanticItemBaseSchema = SemanticRowSchema.extend({
  type: z.string(),
  name: z.string(),
  facts: z.array(SemanticFactSchema),
  /** The relations whose subject is this item. */
  relations: z.array(SemanticRelationSchema),
});
/** An item merged into another's group (S02-R13): listed under the representative, with the line that makes it one. */
export const SemanticMemberSchema = SemanticItemBaseSchema.extend({
  /** The merge line that makes it a member: what an unmerge takes. */
  mergeId: z.int().positive(),
  /** The item that line points at: the representative, or the next item of a chain. */
  mergedInto: z.int().positive(),
});
export const SemanticItemSchema = SemanticItemBaseSchema.extend({
  /** The active members of the item's group, ascending by id; empty for an item that leads none. */
  members: z.array(SemanticMemberSchema),
});
export const SemanticListResponseSchema = z.object({
  items: z.array(SemanticItemSchema),
  truncated: z.boolean(),
});
export type SemanticList = z.infer<typeof SemanticListResponseSchema>;
const SemanticStateSchema = z.object({
  kind: SemanticKindSchema,
  id: z.int().positive(),
  status: SemanticStatusSchema,
  epistemic: SemanticEpistemicSchema,
});
/**
 * One object (a contract schema must convert to a JSON Schema object): `applied` carries `seq` and
 * `entry`, `unchanged` carries `entry`, `refused` carries `reason`.
 */
export const SemanticOutcomeSchema = z
  .object({
    status: z.enum(["applied", "unchanged", "refused", "removed"]),
    /** The history line the action wrote (`applied` only). */
    seq: z.int().positive().optional(),
    /** The row as it is now (`applied` and `unchanged`). */
    entry: SemanticStateSchema.optional(),
    /** The gate's refusal (`refused` only). */
    reason: z.enum(SEMANTIC_REFUSALS).optional(),
    /** What names the item, counts only: with the refusal `existing-data-violation` and no other (S02-R11). */
    held: z
      .object({
        facts: z.int().nonnegative(),
        relations: z.int().nonnegative(),
        merges: z.int().nonnegative(),
        distinct: z.int().nonnegative(),
        splitMoves: z.int().nonnegative(),
      })
      .optional(),
    /** Every unmet data condition, with the refusal `data-check-unmet` and no other (S03-R14). Names only. */
    unmet: z.array(z.enum(DATA_CHECK_UNMET)).min(1).optional(),
  })
  .refine((o) => (o.reason === "existing-data-violation") === (o.held !== undefined))
  .refine((o) => (o.reason === "data-check-unmet") === (o.unmet !== undefined))
  .refine((o) =>
    o.status === "applied"
      ? o.seq !== undefined && o.entry !== undefined && o.reason === undefined
      : o.status === "unchanged"
        ? o.seq === undefined && o.entry !== undefined && o.reason === undefined
        : o.status === "removed"
          ? o.seq === undefined && o.entry === undefined && o.reason === undefined
          : o.seq === undefined && o.entry === undefined && o.reason !== undefined,
  );
export type SemanticOutcome = z.infer<typeof SemanticOutcomeSchema>;

/**
 * The user's merge, unmerge and distinct mark (S02-R11, R12, R16, R25). A merge names two items, either of
 * which may already be a member: both are read as the tops of their groups. A refusal is a code in a 200
 * body; an item that is absent, deleted or hidden answers the one `not-found` (404), so nothing of a hidden
 * item shows. No name, value or quote is in any of it.
 */
const EntityItemIdSchema = z.int().positive();
export const EntityMergeRequestSchema = z.strictObject({
  member: EntityItemIdSchema,
  into: EntityItemIdSchema,
});
export const ENTITY_MERGE_REFUSALS = ["type-mismatch", "already-merged", "scope-refused"] as const;
export const EntityMergeResponseSchema = z
  .object({
    status: z.enum(["applied", "refused"]),
    /** The line the merge wrote: the number an unmerge names (`applied` only). */
    mergeId: z.int().positive().optional(),
    reason: z.enum(ENTITY_MERGE_REFUSALS).optional(),
  })
  .refine((o) =>
    o.status === "applied"
      ? o.mergeId !== undefined && o.reason === undefined
      : o.reason !== undefined && o.mergeId === undefined,
  );
export type EntityMergeResponse = z.infer<typeof EntityMergeResponseSchema>;
export const EntityUnmergeRequestSchema = z.strictObject({
  mergeId: EntityItemIdSchema,
  /** Whether a distinct mark is left between the two ends; absent means yes (S02-R12). */
  keepDistinct: z.boolean().optional(),
});
export const EntityUnmergeResponseSchema = z.object({ status: z.literal("applied") });
/**
 * A split (S02-R15): the chosen facts and relations of an item go to a new item the user names. `created` is
 * the new item; a refusal is a code and writes nothing; an item that is absent or hidden is the 404.
 */
export const ENTITY_SPLIT_REFUSALS = [
  "row-not-on-item",
  "nothing-selected",
  "nothing-left",
] as const;
export const EntitySplitRequestSchema = z.strictObject({
  itemId: EntityItemIdSchema,
  rows: z
    .array(z.strictObject({ kind: z.enum(["fact", "relation"]), id: EntityItemIdSchema }))
    .max(500),
  name: SemanticTextSchema,
});
export const EntitySplitResponseSchema = z
  .object({
    status: z.enum(["applied", "refused"]),
    created: z.int().positive().optional(),
    reason: z.enum(ENTITY_SPLIT_REFUSALS).optional(),
  })
  .refine((o) =>
    o.status === "applied"
      ? o.created !== undefined && o.reason === undefined
      : o.reason !== undefined && o.created === undefined,
  );
export const EntityDistinctRequestSchema = z
  .strictObject({
    a: EntityItemIdSchema,
    b: EntityItemIdSchema,
    /** True leaves the mark (and drops the pair's candidate); false clears it. */
    on: z.boolean(),
  })
  .refine((r) => r.a !== r.b);
export const EntityDistinctResponseSchema = z.object({ status: z.enum(["applied", "unchanged"]) });
/** A valid-interval end: `YYYY-MM-DD` in shape; the API judges that the day exists (S02-R17). */
const ValidityDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const SemanticValidityRequestSchema = z.strictObject({
  kind: z.enum(["fact", "relation"]),
  id: z.int().positive(),
  from: ValidityDateSchema.nullable(),
  until: ValidityDateSchema.nullable(),
});
export const SemanticValidityResponseSchema = z.object({
  status: z.literal("applied"),
  seq: z.int().positive(),
  /** The interval the fix replaced, so a caller can put it back (S02-R17: a fix is not undone). */
  previous: z.object({ from: z.string().nullable(), until: z.string().nullable() }),
});
/**
 * The conflict list (S02-R19, R25): numbers, codes and dates only. `effectiveUntil` is computed at read from the
 * links the list shows: the fact's own end or the earliest start of a fact that supersedes it.
 */
const ConflictSideSchema = z.object({
  factId: z.int().positive(),
  itemId: z.int().positive(),
  effectiveUntil: z.string().nullable(),
});
export const ConflictsResponseSchema = z.object({
  links: z.array(
    z.object({
      id: z.int().positive(),
      type: z.enum(["SUPERSEDES", "CONTRADICTS"]),
      createdBy: z.enum(["rule", "propagation", "user"]),
      from: ConflictSideSchema,
      to: ConflictSideSchema,
    }),
  ),
  truncated: z.boolean(),
});
/**
 * The merge candidates (S02-R10, R25): two item ids (the smaller first) and the signal codes that make the
 * pair a candidate. A row names no text. `truncated` says the list was cut at the limit.
 */
export const EntityCandidatesResponseSchema = z.object({
  candidates: z.array(
    z.object({
      a: z.number().int().positive(),
      b: z.number().int().positive(),
      signals: z.array(
        z.enum([
          "same-type",
          "name-match",
          "identifier-match",
          "identifier-mismatch",
          "organization-match",
          "organization-mismatch",
          "project-match",
          "shared-neighbor",
        ]),
      ),
    }),
  ),
  truncated: z.boolean(),
});
/** S02-R21, R22, R25 (decision 31). Numbers, codes, spans and dates only: no name, value or quote. */
export const GRAPH_MAX_DEPTH = 3;
const GraphIdSchema = z.int().positive();

export const GraphTraceRequestSchema = z.strictObject({
  kind: z.enum(["insight", "fact", "item"]),
  id: GraphIdSchema,
});
const GraphNodeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("insight"), id: GraphIdSchema }),
  z.object({ kind: z.literal("item"), id: GraphIdSchema }),
  z.object({ kind: z.literal("fact"), id: GraphIdSchema, effectiveUntil: z.string().nullable() }),
  z.object({ kind: z.literal("relation"), id: GraphIdSchema }),
  z.object({
    kind: z.literal("evidence"),
    id: GraphIdSchema,
    start: z.int().nonnegative(),
    end: z.int().positive(),
  }),
  z.object({ kind: z.literal("source-version"), id: GraphIdSchema }),
  z.object({ kind: z.literal("user-input") }),
]);
export const GRAPH_TRACE_EDGES = [
  "DERIVED_FROM",
  "SUPPORTS",
  "SUPERSEDES",
  "CONTRADICTS",
  "MENTIONS",
  "SAME_AS",
  "HAS",
] as const;
const GraphTraceHopSchema = z.object({
  edge: z.enum(GRAPH_TRACE_EDGES),
  from: GraphNodeSchema,
  to: GraphNodeSchema,
  /** SUPERSEDES / CONTRADICTS only: the assertion link, and whether the hop runs the way the link is stored. */
  linkId: GraphIdSchema.optional(),
  direction: z.enum(["forward", "backward"]).optional(),
});
export const GraphTraceResponseSchema = z.object({
  chains: z.array(z.array(GraphTraceHopSchema)),
  truncated: z.boolean(),
});

export const GraphPathsRequestSchema = z.strictObject({
  from: GraphIdSchema,
  to: GraphIdSchema.optional(),
  /** Any positive int parses; above GRAPH_MAX_DEPTH the answer is the `depth-exceeded` refusal, not a 400. */
  depth: z.int().positive(),
});
const GraphPathHopSchema = z.object({
  relationId: GraphIdSchema,
  type: z.string(),
  /** forward: `from` is the stored subject's representative. */
  direction: z.enum(["forward", "backward"]),
  from: GraphIdSchema,
  to: GraphIdSchema,
});
/** `ok` carries `paths` and `truncated`; `refused` carries `reason` (a refusal is a code in a 200 body). */
export const GraphPathsResponseSchema = z
  .object({
    status: z.enum(["ok", "refused"]),
    paths: z.array(z.array(GraphPathHopSchema)).optional(),
    truncated: z.boolean().optional(),
    reason: z.literal("depth-exceeded").optional(),
  })
  .refine((o) =>
    o.status === "ok"
      ? o.paths !== undefined && o.truncated !== undefined && o.reason === undefined
      : o.reason !== undefined && o.paths === undefined && o.truncated === undefined,
  );
/**
 * The answer to a direct add or a value fix. `applied`: `entry` is the row the user wrote, and for a
 * fix `replaced` is the old fact as it stands now. `refused` with `value-exists` names the row that
 * has the value (`existing`); approving it is the next step. A row that is absent or hidden is the
 * 404 `not-found` and not a refusal. No name, value or quote is in any of it.
 */
export const SemanticCorrectionSchema = z
  .object({
    status: z.enum(["applied", "refused"]),
    /** The history line the new row's creation wrote (`applied` only). */
    seq: z.int().positive().optional(),
    entry: SemanticStateSchema.optional(),
    replaced: SemanticStateSchema.optional(),
    reason: z.enum(SEMANTIC_REFUSALS).optional(),
    existing: z.object({ kind: SemanticKindSchema, id: z.int().positive() }).optional(),
  })
  .refine((o) =>
    o.status === "applied"
      ? o.seq !== undefined &&
        o.entry !== undefined &&
        o.reason === undefined &&
        o.existing === undefined
      : o.reason !== undefined &&
        o.seq === undefined &&
        o.entry === undefined &&
        o.replaced === undefined &&
        (o.reason === "value-exists") === (o.existing !== undefined),
  );
export type SemanticCorrection = z.infer<typeof SemanticCorrectionSchema>;
export const SemanticHistoryResponseSchema = z.object({
  lines: z.array(
    z.object({
      seq: z.int().positive(),
      at: z.string(),
      actor: z.enum(["user", "extraction", "propagation", "policy"]),
      action: z.string().max(40),
      fromStatus: SemanticStatusSchema.nullable(),
      toStatus: SemanticStatusSchema,
      fromEpistemic: SemanticEpistemicSchema.nullable(),
      toEpistemic: SemanticEpistemicSchema,
      reason: z.string().max(60).nullable(),
      basisSourceId: z.int().positive().nullable(),
      basisVersion: z.int().positive().nullable(),
      batch: z.int().positive().nullable(),
      revertsSeq: z.int().positive().nullable(),
    }),
  ),
});

/**
 * The type definitions' (ontology's) read and user operations (S01-R23, T07). An element is an item
 * type, a fact kind or a relation type with a rule of a fixed shape, a status and an edition. A refusal
 * is a code with counts, never a name, a rule or a text (the names can come from a source); an id that
 * is not stored, was deleted or whose lineage the read gate hides answers one `not-found`. The history
 * holds numbers and closed codes only (S01-R6).
 */
const OntologyKindSchema = z.enum(["item-type", "fact-kind", "relation-type"]);
const OntologyNameSchema = z.string().max(200);
/** The item type names a rule lists: each as long as a name may be, so a type list cannot carry text. */
const OntologyTypeListSchema = z.array(OntologyNameSchema).max(100);
export const OntologyRuleSchema = z.discriminatedUnion("elementKind", [
  z.strictObject({ elementKind: z.literal("item-type") }),
  z.strictObject({
    elementKind: z.literal("fact-kind"),
    itemTypes: OntologyTypeListSchema,
    valueType: z.enum(FACT_VALUE_TYPES),
    cardinality: z.enum(["one", "many"]),
    dataChecks: z.array(z.enum(DATA_CHECK_NAMES)).optional(),
  }),
  z.strictObject({
    elementKind: z.literal("relation-type"),
    subjectTypes: OntologyTypeListSchema,
    objectTypes: OntologyTypeListSchema,
    symmetric: z.boolean(),
  }),
]);
/**
 * One object (a contract schema must convert to a JSON Schema object); a refinement checks which of
 * `elementKind` and `rule` each `op` carries: `add` a rule, `change-rule` both, `retire` the kind.
 */
export const OntologyChangeSchema = z
  .strictObject({
    op: z.enum(["add", "change-rule", "retire"]),
    name: OntologyNameSchema,
    elementKind: OntologyKindSchema.optional(),
    rule: OntologyRuleSchema.optional(),
  })
  .refine((c) =>
    c.op === "add"
      ? c.rule !== undefined && c.elementKind === undefined
      : c.op === "change-rule"
        ? c.rule !== undefined && c.elementKind !== undefined
        : c.elementKind !== undefined && c.rule === undefined,
  );
export type OntologyChangeRequest = z.infer<typeof OntologyChangeSchema>;
export const OntologyRefRequestSchema = z.strictObject({ id: z.int().positive() });
export const OntologyDecideRequestSchema = z.strictObject({
  id: z.int().positive(),
  action: z.enum(["approve", "reject", "dispute"]),
});
export const ONTOLOGY_REFUSALS = [
  "duplicate",
  "schema-invalid",
  "existing-data-violation",
  "basis-required",
  "invalid-transition",
  "not-found",
  "not-latest",
  "nothing-to-undo",
] as const;
export const OntologyListResponseSchema = z.object({
  elements: z.array(
    z.object({
      id: z.int().positive(),
      elementKind: OntologyKindSchema,
      name: z.string(),
      rule: OntologyRuleSchema,
      status: SemanticStatusSchema,
      edition: z.int().positive(),
      origin: z.enum(["seed", "user", "source-proposed"]),
    }),
  ),
});
export const OntologyCheckResponseSchema = z.object({
  /** How many stored elements the name duplicates (their names are not given). */
  duplicates: z.int().nonnegative(),
  /** Closed codes. */
  schemaErrors: z.array(z.string().max(60)),
  impact: z.object({ liveRows: z.int().nonnegative(), violations: z.int().nonnegative() }),
  applicable: z.boolean(),
});
/**
 * One object: `applied` carries `id`, `edition` and `seq`; `unchanged` and `removed` carry `id`;
 * `refused` carries `reason` and the counts that explain it.
 */
export const OntologyOutcomeSchema = z
  .object({
    status: z.enum(["applied", "unchanged", "removed", "refused"]),
    id: z.int().positive().optional(),
    edition: z.int().positive().optional(),
    seq: z.int().positive().optional(),
    reason: z.enum(ONTOLOGY_REFUSALS).optional(),
    duplicates: z.int().nonnegative().optional(),
    schemaErrors: z.array(z.string().max(60)).optional(),
    impact: z
      .object({ liveRows: z.int().nonnegative(), violations: z.int().nonnegative() })
      .optional(),
  })
  .refine((o) =>
    o.status === "applied"
      ? o.id !== undefined &&
        o.edition !== undefined &&
        o.seq !== undefined &&
        o.reason === undefined
      : o.status === "refused"
        ? o.reason !== undefined &&
          o.duplicates !== undefined &&
          o.schemaErrors !== undefined &&
          o.impact !== undefined &&
          o.id === undefined
        : o.id !== undefined && o.reason === undefined && o.seq === undefined,
  );
export const OntologyHistoryResponseSchema = z.object({
  lines: z.array(
    z.object({
      seq: z.int().positive(),
      at: z.string(),
      actor: z.enum(["user", "extraction", "propagation", "policy"]),
      action: z.string().max(40),
      fromStatus: SemanticStatusSchema.nullable(),
      toStatus: SemanticStatusSchema,
      fromEdition: z.int().positive().nullable(),
      toEdition: z.int().positive(),
      reason: z.string().max(60).nullable(),
      basisSourceId: z.int().positive().nullable(),
      basisVersion: z.int().positive().nullable(),
      batch: z.int().positive().nullable(),
      revertsSeq: z.int().positive().nullable(),
    }),
  ),
});

/**
 * The knowledge-schema catalogue (S02-R25): the edition and, for every name of the catalogue, where it is
 * stored, whether it can be used now (a `verified` type definition exists; `null` for a name that has no type
 * definition) and whether the stored rule is the catalogue's (`null` likewise; a missing definition is `false`).
 * Names only: no source text can be in it.
 */
export const KnowledgeSchemaResponseSchema = z.object({
  edition: z.int().positive(),
  entries: z.array(
    z.object({
      category: z.enum(["knowledge-type", "relation-type", "fact-kind"]),
      name: z.string(),
      place: z.enum(KNOWLEDGE_PLACES),
      usable: z.boolean().nullable(),
      ruleMatches: z.boolean().nullable(),
    }),
  ),
});

/**
 * Where the screens get the backend address and token: the dev server in the browser,
 * the preload in Electron (V01-R3). An empty `baseUrl` means the page's own origin.
 */
export const SessionSchema = z.object({ baseUrl: z.string(), token: z.string().min(32) });
export type Session = z.infer<typeof SessionSchema>;

// K01 (R15): the Wiki. Pages are a projection of the knowledge tables: a claim is one fact or relation
// with its evidence ids, and the words a page reads in are the screen's. Ids, codes, dates and the
// user's own notes; the page's text is what the knowledge rows hold (the same text the Semantic list shows).
const WikiClaimRefSchema = z.object({
  kind: z.enum(["fact", "relation"]),
  id: z.int().positive(),
});
export const WikiClaimSchema = z.object({
  ref: WikiClaimRefSchema,
  /** The fact kind, or the relation type. */
  kind: z.string(),
  value: z.string().optional(),
  context: z.string().nullable().optional(),
  /** A relation's other end: the page key. */
  to: z.string().optional(),
  status: z.string(),
  epistemic: z.string(),
  validAt: z.string().nullable(),
  validUntil: z.string().nullable(),
  evidence: z.array(z.int().positive()),
  contradicts: z.array(WikiClaimRefSchema),
  supersedes: z.array(WikiClaimRefSchema),
});
export type WikiClaim = z.infer<typeof WikiClaimSchema>;
const WikiLogLineSchema = z.object({
  pageKey: z.string(),
  action: z.enum(["created", "changed", "removed"]),
  knowledgeRevision: z.int().nonnegative(),
  changeSeq: z.int().nonnegative(),
  added: z.int().nonnegative(),
  removed: z.int().nonnegative(),
  at: z.string(),
});
const WikiNoteSchema = z.object({
  id: z.int().positive(),
  text: z.string(),
  at: z.string(),
});
/**
 * `stale`: a table the pages read changed since the last build caught up (K01-R7). `buildDead`: stale, and the
 * last build job gave up, so nothing is retrying until the input changes or the user rebuilds (K01-R5, R16).
 */
export const WikiIndexResponseSchema = z.object({
  stale: z.boolean(),
  buildDead: z.boolean(),
  kinds: z.array(
    z.object({
      kind: z.string(),
      pages: z.array(z.object({ key: z.string(), title: z.string() })),
    }),
  ),
  log: z.array(WikiLogLineSchema),
  /** Notes whose page is gone (K01-D7): shown so the user can delete them. */
  orphanNotes: z.array(WikiNoteSchema.extend({ pageKey: z.string() })),
});
export const WikiPageRequestSchema = z.strictObject({ key: z.string().min(1).max(200) });
export const WikiPageResponseSchema = z.object({
  key: z.string(),
  kind: z.string(),
  title: z.string(),
  stale: z.boolean(),
  members: z.array(z.object({ id: z.int().positive(), name: z.string() })),
  claims: z.array(WikiClaimSchema),
  /** The claims the user hid on this page, judged by the same read rules as `claims`: the way back (K01-R11). */
  hidden: z.array(WikiClaimSchema),
  /** The pages this one points at (a relation claim's end, an Insight's two ends). */
  links: z.array(z.object({ key: z.string(), title: z.string() })),
  backlinks: z.array(
    z.object({
      fromKey: z.string(),
      title: z.string(),
      basisKind: z.enum(["relation", "insight"]),
      basisId: z.int().positive(),
    }),
  ),
  /** `syntheses` pages: the Insight the page is. */
  insight: z
    .object({ summary: z.string(), epistemic: z.string(), evidence: z.array(z.int().positive()) })
    .optional(),
  notes: z.array(WikiNoteSchema),
  /** Oldest first. */
  history: z.array(WikiLogLineSchema),
  /** The LLM summary's state (K01-R14); `sentences` only with `ready`. */
  summary: z.object({
    state: z.enum(["off", "none", "held", "ready"]),
    sentences: z
      .array(
        z.object({
          text: z.string(),
          sourceId: z.int().positive(),
          version: z.int().positive(),
          start: z.int().nonnegative(),
          end: z.int().nonnegative(),
        }),
      )
      .optional(),
  }),
});
/**
 * One object (a contract schema converts to a JSON Schema object), the shape of each `op` checked by a
 * refinement: `note-add` names a page key and the text, `note-remove` a note id, `hide` and `unhide` a claim.
 */
export const WikiEditRequestSchema = z
  .strictObject({
    op: z.enum(["note-add", "note-remove", "hide", "unhide"]),
    key: z.string().min(1).max(200).optional(),
    text: z.string().trim().min(1).max(2000).optional(),
    id: z.int().positive().optional(),
    claim: WikiClaimRefSchema.optional(),
  })
  .refine((r) =>
    r.op === "note-add"
      ? r.key !== undefined && r.text !== undefined && r.id === undefined && r.claim === undefined
      : r.op === "note-remove"
        ? r.id !== undefined && r.key === undefined && r.text === undefined && r.claim === undefined
        : r.claim !== undefined &&
          r.key === undefined &&
          r.text === undefined &&
          r.id === undefined,
  );
export const WikiEditResponseSchema = z.object({ status: z.literal("applied") });
export const WikiRebuildRequestSchema = z.strictObject({});
/** `queued`: a build was queued; `open`: one was open already and will do it. */
export const WikiRebuildResponseSchema = z.object({ status: z.enum(["queued", "open"]) });

// K02 (R15): reflection and knowledge lint. A finding is a candidate: the rule, the rows it bears on and the
// evidence ids the existing evidence view opens; the words on the screen are the screen's.
const LintRuleSchema = z.enum(["synonym", "stale", "overdue-work", "missing-link"]);
const LintTargetKindSchema = z.enum(["item", "fact", "relation"]);
export const LintFindingSchema = z.object({
  id: z.int().positive(),
  rule: LintRuleSchema,
  status: z.enum(["open", "accepted", "dismissed", "resolved", "oscillating"]),
  /** `user`: the user reported it as missed (K02-R12). */
  origin: z.enum(["rule", "user"]),
  flips: z.int().nonnegative(),
  /** The rows it bears on, with the words the rows hold (shown only while every row is). */
  targets: z.array(
    z.object({ kind: LintTargetKindSchema, id: z.int().positive(), label: z.string() }),
  ),
  evidence: z.array(z.int().positive()),
  /** The LLM's verdict on a `synonym` or `missing-link` pair, when the optional refinement gave one (K02-R17). */
  opinion: z.enum(["same", "related", "unrelated"]).optional(),
});
export const LintResponseSchema = z.object({
  findings: z.array(LintFindingSchema),
  /** The shown findings counted by rule (K02-R12). */
  counts: z.array(
    z.object({
      rule: LintRuleSchema,
      open: z.int().nonnegative(),
      accepted: z.int().nonnegative(),
      falsePositive: z.int().nonnegative(),
      missed: z.int().nonnegative(),
      oscillating: z.int().nonnegative(),
    }),
  ),
  /** The latest finished `reflect` job's time and result counts; null before the first run. */
  lastRun: z
    .object({ at: z.string(), counts: z.record(z.string(), z.int().nonnegative()) })
    .nullable(),
  /** Items still marked for the next run. */
  dirty: z.int().nonnegative(),
});
export const LintDecideRequestSchema = z.strictObject({
  id: z.int().positive(),
  op: z.enum(["accept", "dismiss", "reopen"]),
  /** `missing-link` accepted: the relation type the user chose. */
  relationType: SemanticIdentifierSchema.optional(),
});
/**
 * `refused`: the existing entry's own code (`type-mismatch`, `value-exists`, `scope-refused`…) or ours.
 * `not-found`: no such finding, or not one the caller may see (the one answer for both).
 */
export const LintDecideResponseSchema = z.object({
  status: z.enum(["applied", "refused", "not-found"]),
  reason: z.string().optional(),
  finding: LintFindingSchema.optional(),
});
export const LintReportRequestSchema = z.strictObject({
  rule: LintRuleSchema,
  kind: LintTargetKindSchema,
  a: z.int().positive(),
  b: z.int().positive().optional(),
});
export const LintReportResponseSchema = z.object({
  /** `exists`: the rules had found it already; `not-found`: a target row is gone or not shown. */
  status: z.enum(["applied", "exists", "not-found"]),
  finding: LintFindingSchema.optional(),
});

// P02 (R14, R16): notifications. A line is ids, codes and times; the words are the Insight's, read through the read
// gate when shown, in the Insight response's own shape. Nothing of an OS toast's text is here: the shell owns it.
/** The three "remind me later" times, in minutes (P02-D16); the request schema below lists the same three. */
export const NOTIFICATION_SNOOZE_MINUTES = [60, 240, 1440] as const;
export const NOTIFICATION_ACTIONS = ["evidence", "read", "snooze", "unsnooze", "dismiss"] as const;
export type NotificationAction = (typeof NOTIFICATION_ACTIONS)[number];
/** Why a line went to the digest only (P02-R2). */
export const NOTIFICATION_REASONS = [
  "low-confidence",
  "below-threshold",
  "repeat",
  "muted",
] as const;
export type NotificationReason = (typeof NOTIFICATION_REASONS)[number];

export const NotificationLineSchema = z.object({
  id: z.int().positive(),
  status: z.enum(["sent", "digest", "deferred", "dismissed"]),
  reason: z.enum(NOTIFICATION_REASONS).nullable(),
  /** `deferred` only: when the line comes back. */
  notBefore: z.string().nullable(),
  createdAt: z.string(),
  readAt: z.string().nullable(),
  /** What the user can do with the line now. */
  actions: z.array(z.enum(NOTIFICATION_ACTIONS)),
  insight: InsightSummarySchema,
});
export type NotificationLine = z.infer<typeof NotificationLineSchema>;
const NotificationDigestRowSchema = z.object({
  id: z.int().positive(),
  kind: z.enum(["daily", "weekly"]),
  windowStart: z.string(),
  windowEnd: z.string(),
  createdAt: z.string(),
  readAt: z.string().nullable(),
  /** How many lines of the window are shown now. */
  count: z.int().nonnegative(),
});
export type NotificationDigestRow = z.infer<typeof NotificationDigestRowSchema>;
/** The feed, the digest rows and the timeline are one answer: the screen shows it three ways. */
export const NotificationListResponseSchema = z.object({
  lines: z.array(NotificationLineSchema),
  digests: z.array(NotificationDigestRowSchema),
  unread: z.int().nonnegative(),
});
export const NotificationDigestRequestSchema = z.strictObject({ id: z.int().positive() });
/**
 * The digest's or the report's content, computed when asked; the report adds the lint's counts by rule (K02).
 * `digest` is null for a row that is absent or not shown (the one answer for both).
 */
export const NotificationDigestResponseSchema = z.object({
  digest: z
    .object({
      kind: z.enum(["daily", "weekly"]),
      windowStart: z.string(),
      windowEnd: z.string(),
      lines: z.array(NotificationLineSchema),
      lint: z
        .object({
          counts: z.array(
            z.object({
              rule: LintRuleSchema,
              open: z.int().nonnegative(),
              accepted: z.int().nonnegative(),
              falsePositive: z.int().nonnegative(),
              missed: z.int().nonnegative(),
              oscillating: z.int().nonnegative(),
            }),
          ),
          /** Shown findings first seen inside the window. */
          opened: z.int().nonnegative(),
        })
        .nullable(),
    })
    .nullable(),
});
/** The four actions (P02-R11); a value outside them, or a snooze time outside the three, is a 400. */
export const NotificationActRequestSchema = z
  .strictObject({
    id: z.int().positive(),
    op: z.enum(["read", "dismiss", "snooze", "unsnooze"]),
    /** With `snooze` and only then. */
    minutes: z.union([z.literal(60), z.literal(240), z.literal(1440)]).optional(),
  })
  .refine((r) => (r.op === "snooze") === (r.minutes !== undefined));
/** `refused`: the line is there but not in a state the action applies to; `not-found`: absent or not shown (the one answer). */
export const NotificationActResponseSchema = z.object({
  status: z.enum(["applied", "refused", "not-found"]),
  unread: z.int().nonnegative(),
});
const ClockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const QuietHoursSchema = z.strictObject({
  enabled: z.boolean(),
  start: ClockTimeSchema,
  end: ClockTimeSchema,
});
/** `notifications.os`, `.quietHours` and `.snoozeUntil` (P02-R6, R10, D10). */
export const NotificationSettingsSchema = z.strictObject({
  os: z.boolean(),
  quietHours: QuietHoursSchema,
  snoozeUntil: z.string().nullable(),
});
/** The write: a key left out stays as it is; `snoozeUntil` null ends a pause. */
export const NotificationSettingsRequestSchema = z.strictObject({
  os: z.boolean().optional(),
  quietHours: QuietHoursSchema.optional(),
  snoozeUntil: z
    .string()
    .max(40)
    .refine((value) => !Number.isNaN(Date.parse(value)))
    .nullable()
    .optional(),
});
/** The cheap read the open screens poll (P02-R16, D14): three sequence numbers and the unread count, no text. */
export const ChangesResponseSchema = z.object({
  sources: z.int().nonnegative(),
  knowledge: z.int().nonnegative(),
  notifications: z.int().nonnegative(),
  unread: z.int().nonnegative(),
});

export const routes = {
  status: { method: "GET", path: "/api/status", response: StatusResponseSchema },
  connectors: { method: "GET", path: "/api/connectors", response: ConnectorListResponseSchema },
  syncConnector: {
    method: "POST",
    path: "/api/connectors/sync",
    request: SyncRequestSchema,
    response: SyncResponseSchema,
  },
  credentialsChanged: {
    method: "POST",
    path: "/api/connectors/credentials-changed",
    request: CredentialsChangedRequestSchema,
    response: CredentialsChangedResponseSchema,
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
  pruneVersions: {
    method: "POST",
    path: "/api/sources/prune-versions",
    request: VersionsPruneRequestSchema,
    response: VersionsPruneResponseSchema,
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
  analyticalSettings: {
    method: "GET",
    path: "/api/settings/analytical",
    response: AnalyticalSettingsSchema,
  },
  setAnalyticalSettings: {
    method: "POST",
    path: "/api/settings/analytical",
    request: AnalyticalSettingsSchema,
    response: AnalyticalSettingsSchema,
  },
  analytical: { method: "GET", path: "/api/analytical", response: AnalyticalListSchema },
  analyticalCheck: {
    method: "POST",
    path: "/api/analytical/check",
    request: AnalyticalCheckRequestSchema,
    response: AnalyticalCheckResponseSchema,
  },
  localLocations: {
    method: "GET",
    path: "/api/local-locations",
    response: LocalLocationListSchema,
  },
  approveLocalLocation: {
    method: "POST",
    path: "/api/local-locations",
    request: LocalApprovalRequestSchema,
    response: LocalLocationSchema,
  },
  relinkLocalLocation: {
    method: "POST",
    path: "/api/local-locations/relink",
    request: LocalRelinkRequestSchema,
    response: LocalLocationSchema,
  },
  pauseLocalLocation: {
    method: "POST",
    path: "/api/local-locations/pause",
    request: LocalLocationIdRequestSchema,
    response: LocalLocationSchema,
  },
  resumeLocalLocation: {
    method: "POST",
    path: "/api/local-locations/resume",
    request: LocalLocationIdRequestSchema,
    response: LocalLocationSchema,
  },
  rescanLocalLocation: {
    method: "POST",
    path: "/api/local-locations/rescan",
    request: LocalLocationIdRequestSchema,
    response: LocalReimportResponseSchema,
  },
  confirmLocalDeletions: {
    method: "POST",
    path: "/api/local-locations/confirm-deletions",
    request: LocalConfirmDeletionsRequestSchema,
    response: LocalLocationSchema,
  },
  localSkipped: {
    method: "POST",
    path: "/api/local-locations/skipped",
    request: LocalSkippedRequestSchema,
    response: LocalSkippedResponseSchema,
  },
  reimportLocalFile: {
    method: "POST",
    path: "/api/local-locations/reimport",
    request: LocalReimportRequestSchema,
    response: LocalReimportResponseSchema,
  },
  localSourceInfo: {
    method: "POST",
    path: "/api/local-locations/source",
    request: LocalSourceInfoRequestSchema,
    response: LocalSourceInfoResponseSchema,
  },
  revokeLocalLocation: {
    method: "POST",
    path: "/api/local-locations/revoke",
    request: LocalRevokeRequestSchema,
    response: LocalRevokeResponseSchema,
  },
  localFilesSettings: {
    method: "GET",
    path: "/api/settings/local-files",
    response: LocalFilesSettingsSchema,
  },
  setLocalFilesSettings: {
    method: "POST",
    path: "/api/settings/local-files",
    request: LocalFilesSettingsPatchSchema,
    response: LocalFilesSettingsSchema,
  },
  semanticSettings: {
    method: "GET",
    path: "/api/settings/semantic",
    response: SemanticSettingsSchema,
  },
  setSemanticSettings: {
    method: "POST",
    path: "/api/settings/semantic",
    request: SemanticSettingsRequestSchema,
    response: SemanticSettingsSchema,
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
  insightTypes: {
    method: "GET",
    path: "/api/insights/types",
    response: InsightTypeListResponseSchema,
  },
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
  semantic: { method: "GET", path: "/api/semantic", response: SemanticListResponseSchema },
  semanticHistory: {
    method: "POST",
    path: "/api/semantic/history",
    request: SemanticRefRequestSchema,
    response: SemanticHistoryResponseSchema,
  },
  semanticDecide: {
    method: "POST",
    path: "/api/semantic/decide",
    request: SemanticDecideRequestSchema,
    response: SemanticOutcomeSchema,
  },
  semanticCorrect: {
    method: "POST",
    path: "/api/semantic/correct",
    request: SemanticCorrectRequestSchema,
    response: SemanticCorrectionSchema,
  },
  semanticUndo: {
    method: "POST",
    path: "/api/semantic/undo",
    request: SemanticRefRequestSchema,
    response: SemanticOutcomeSchema,
  },
  semanticValidity: {
    method: "POST",
    path: "/api/semantic/validity",
    request: SemanticValidityRequestSchema,
    response: SemanticValidityResponseSchema,
  },
  conflicts: { method: "GET", path: "/api/conflicts", response: ConflictsResponseSchema },
  entityMerge: {
    method: "POST",
    path: "/api/entities/merge",
    request: EntityMergeRequestSchema,
    response: EntityMergeResponseSchema,
  },
  entityUnmerge: {
    method: "POST",
    path: "/api/entities/unmerge",
    request: EntityUnmergeRequestSchema,
    response: EntityUnmergeResponseSchema,
  },
  entitySplit: {
    method: "POST",
    path: "/api/entities/split",
    request: EntitySplitRequestSchema,
    response: EntitySplitResponseSchema,
  },
  entityDistinct: {
    method: "POST",
    path: "/api/entities/distinct",
    request: EntityDistinctRequestSchema,
    response: EntityDistinctResponseSchema,
  },
  entityCandidates: {
    method: "GET",
    path: "/api/entities/candidates",
    response: EntityCandidatesResponseSchema,
  },
  graphTrace: {
    method: "POST",
    path: "/api/graph/trace",
    request: GraphTraceRequestSchema,
    response: GraphTraceResponseSchema,
  },
  graphPaths: {
    method: "POST",
    path: "/api/graph/paths",
    request: GraphPathsRequestSchema,
    response: GraphPathsResponseSchema,
  },
  knowledgeSchema: {
    method: "GET",
    path: "/api/knowledge-schema",
    response: KnowledgeSchemaResponseSchema,
  },
  ontology: { method: "GET", path: "/api/ontology", response: OntologyListResponseSchema },
  ontologyCheck: {
    method: "POST",
    path: "/api/ontology/check",
    request: OntologyChangeSchema,
    response: OntologyCheckResponseSchema,
  },
  ontologyChange: {
    method: "POST",
    path: "/api/ontology/change",
    request: OntologyChangeSchema,
    response: OntologyOutcomeSchema,
  },
  ontologyDecide: {
    method: "POST",
    path: "/api/ontology/decide",
    request: OntologyDecideRequestSchema,
    response: OntologyOutcomeSchema,
  },
  ontologyUndo: {
    method: "POST",
    path: "/api/ontology/undo",
    request: OntologyRefRequestSchema,
    response: OntologyOutcomeSchema,
  },
  ontologyHistory: {
    method: "POST",
    path: "/api/ontology/history",
    request: OntologyRefRequestSchema,
    response: OntologyHistoryResponseSchema,
  },
  // K01 (R15): the Wiki. The page read is a POST with its key in the body, as the other by-id reads are.
  wiki: { method: "GET", path: "/api/wiki", response: WikiIndexResponseSchema },
  wikiPage: {
    method: "POST",
    path: "/api/wiki/page",
    request: WikiPageRequestSchema,
    response: WikiPageResponseSchema,
  },
  // X02 (R1-R3): the Explore screen's reads.
  exploreItems: {
    method: "POST",
    path: "/api/explore/items",
    request: ExploreItemsRequestSchema,
    response: ExploreItemsResponseSchema,
  },
  exploreItem: {
    method: "POST",
    path: "/api/explore/item",
    request: ExploreItemRequestSchema,
    response: ExploreItemResponseSchema,
  },
  exploreSource: {
    method: "POST",
    path: "/api/explore/source",
    request: ExploreSourceRequestSchema,
    response: ExploreSourceResponseSchema,
  },
  // I02-B (R55): the thread a source version belongs to. A POST with the version number in the body, as the other by-number reads are.
  sourceThread: {
    method: "POST",
    path: "/api/sources/thread",
    request: SourceThreadRequestSchema,
    response: SourceThreadResponseSchema,
  },
  wikiEdit: {
    method: "POST",
    path: "/api/wiki/edit",
    request: WikiEditRequestSchema,
    response: WikiEditResponseSchema,
  },
  wikiRebuild: {
    method: "POST",
    path: "/api/wiki/rebuild",
    request: WikiRebuildRequestSchema,
    response: WikiRebuildResponseSchema,
  },
  // K02 (R15): reflection and knowledge lint
  lint: { method: "GET", path: "/api/lint", response: LintResponseSchema },
  lintDecide: {
    method: "POST",
    path: "/api/lint/decide",
    request: LintDecideRequestSchema,
    response: LintDecideResponseSchema,
  },
  lintReport: {
    method: "POST",
    path: "/api/lint/report",
    request: LintReportRequestSchema,
    response: LintReportResponseSchema,
  },
  // P03 (R14): feedback on an Insight or a knowledge row, its undo and the live list
  feedbackList: { method: "GET", path: "/api/feedback", response: FeedbackListResponseSchema },
  feedbackRecord: {
    method: "POST",
    path: "/api/feedback",
    request: FeedbackRecordRequestSchema,
    response: FeedbackRecordResponseSchema,
  },
  feedbackUndo: {
    method: "POST",
    path: "/api/feedback/undo",
    request: FeedbackUndoRequestSchema,
    response: FeedbackUndoResponseSchema,
  },
  // P02 (R14, R16): notifications, their settings and the poll of change numbers
  notifications: {
    method: "GET",
    path: "/api/notifications",
    response: NotificationListResponseSchema,
  },
  notificationDigest: {
    method: "POST",
    path: "/api/notifications/digest",
    request: NotificationDigestRequestSchema,
    response: NotificationDigestResponseSchema,
  },
  notificationAct: {
    method: "POST",
    path: "/api/notifications/act",
    request: NotificationActRequestSchema,
    response: NotificationActResponseSchema,
  },
  notificationSettings: {
    method: "GET",
    path: "/api/settings/notifications",
    response: NotificationSettingsSchema,
  },
  setNotificationSettings: {
    method: "POST",
    path: "/api/settings/notifications",
    request: NotificationSettingsRequestSchema,
    response: NotificationSettingsSchema,
  },
  changes: { method: "GET", path: "/api/changes", response: ChangesResponseSchema },
} as const;
export type RouteName = keyof typeof routes;
export type RouteResponse<Name extends RouteName> = z.infer<(typeof routes)[Name]["response"]>;
export type RouteRequest<Name extends RouteName> = (typeof routes)[Name] extends {
  request: z.ZodType<infer Request>;
}
  ? Request
  : undefined;
