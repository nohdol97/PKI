// Single schema source for the local HTTP API (V01-R2). The UI and the backend
// both import these; TypeScript types come from z.infer, JSON Schema from z.toJSONSchema.
import { z } from "zod";
import type { EmbeddingEgress } from "./embedding.ts";
import { ImportJsonlRequestSchema, ImportJsonlResponseSchema } from "./import-record.ts";
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
    }),
  ),
});
export type ConnectorSummary = z.infer<typeof ConnectorListResponseSchema>["connectors"][number];

export const SyncRequestSchema = z.strictObject({ connectorId: z.string().min(1) });

/** `received` counts changes read; `created` the new source versions (same content makes none). */
export const SyncResponseSchema = z.object({
  connectorId: z.string(),
  received: z.int().nonnegative(),
  created: z.int().nonnegative(),
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

export const StatusResponseSchema = z.object({
  backend: ComponentStatusSchema,
  provider: ProviderStatusSchema,
  embedding: EmbeddingStatusSchema,
  vectorIndex: ComponentStatusSchema,
  /**
   * I04-R4; Activity shows it (I03-T11). `recent`: the latest records, newest
   * first. I04-T09 adds `scopePolicyDrops` (how many items the scope policy
   * dropped) beside `recent`, with the table it counts.
   */
  invalidations: z.object({ recent: z.array(InvalidationSchema) }),
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
  activity: { method: "GET", path: "/api/activity", response: ActivityResponseSchema },
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
