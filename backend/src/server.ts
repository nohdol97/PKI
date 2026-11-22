// Local API server (V01-R2, ADR 0008): loopback-only, and every request must
// carry the per-run session token, name this server as Host, and come from an
// allowlisted Origin (or no Origin: non-browser clients such as the shell).
import { MAX_JSONL_BYTES } from "@pki/connector-sdk";
import {
  ComponentStatusSchema,
  EmbeddingStatusSchema,
  routes,
  type ComponentStatus,
  type ConnectionTestResult,
  type EmbeddingProvider,
  type EmbeddingStatusEntry,
  type ErrorResponse,
  type OntologyChangeRequest,
  type LLMProvider,
  type ProviderCheck,
  type ProviderId,
  type ProviderInfo,
  type ProviderList,
  type ProviderStatus,
  type PrepareSource,
  type RouteName,
  type RouteRequest,
  type RouteResponse,
  type SemanticKind,
  type SemanticCorrection,
  type SecretSource,
  type VectorIndex,
} from "@pki/contracts";
import {
  CLI_BACKGROUND_SETTING,
  errorClass,
  log,
  OPENAI_BASE_URL_SETTING,
  OPENAI_MODEL_SETTING,
  openaiKeySecretName,
  parseEndpoint,
  readCliBackground,
  readDefaultProvider,
  selectProvider,
  writeDefaultProvider,
  type Broker,
  type BrokerResult,
  type EgressControls,
  type ExecutionGate,
  type ExecutionInput,
  type UserActionIssuer,
} from "@pki/providers";
import { defaultEntries, type CanonicalEntries } from "@pki/knowledge-engine";
import {
  databaseEncryption,
  canonicalTransaction,
  LedgerLineUnwritableError,
  findSourceId,
  listLiftableTombstones,
  countScopePolicyDrops,
  listInvalidations,
  listProviderCalls,
  LEGACY_CLEANUP_SETTING,
  readFact,
  checkOntologyChange,
  factValueFit,
  readOntologyHistory,
  readSemanticHistory,
  readSemanticState,
  readSetting,
  schemaVersion,
  writeSetting,
  type DerivativeRegistry,
  type OntologyActionOutcome,
  type OntologyChange,
  type UserChangeOutcome,
  type SqlDriver,
  type UndoResult,
  type UserDecisions,
} from "@pki/storage";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ConnectorManager, ConnectorRebuild } from "./connectors.ts";
import { releaseHeldOnEvent, type HeldEvent } from "./held-release.ts";
import type { InstanceImporter } from "./imports.ts";
import { InstanceBusyError, type JsonlImporter } from "./jsonl-import.ts";
import { ledgerStatus } from "./ledger-status.ts";
import { jobsApi, type JobsPort } from "./jobs-view.ts";
import { createReadGate, defaultReadRegistry } from "./read-gate.ts";
import { matchRoute } from "./routing.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";

const LOOPBACK = "127.0.0.1";
const MIN_TOKEN_LENGTH = 32;
const MAX_BODY_BYTES = 16 * 1024;
/** Provisional (V02-T04): the import route takes a file; every other route stays at 16 KiB. */
export const IMPORT_BODY_LIMIT = 8 * 1024 * 1024;
/** Provisional (I01-R24): the body of POST /api/imports, which answers 413 above it. */
export const IMPORTS_BODY_LIMIT = MAX_JSONL_BYTES;
const BODY_LIMITS: Partial<Record<RouteName, number>> = {
  importJsonl: IMPORT_BODY_LIMIT,
  imports: IMPORTS_BODY_LIMIT,
};
/** The routes whose too-large body answers 413 `payload-too-large`; the others answer 400. */
const ANSWERS_413: ReadonlySet<RouteName> = new Set(["imports"]);
/** How many of the latest invalidation records the status API returns (provisional, I04-T01). */
const STATUS_INVALIDATIONS = 20;

export interface ServerOptions {
  /** Fresh per run; the caller generates it and passes it in-process, never via argv/env. */
  token: string;
  /** Exact `Origin` values allowed to call, e.g. the browser dev server. */
  allowedOrigins: readonly string[];
  /** 0 (default) picks a free port. */
  port?: number;
  /** Chosen by the composition point (composition.ts), never here. */
  vectorIndex: VectorIndex;
  /** Chosen by the composition point; null while no implementation is bound (reported not implemented). */
  embedder: EmbeddingProvider | null;
  /**
   * Built by the composition point (composition.ts), never here. Its `rebuild` (I06-R12) is what a
   * change notice calls; a manager without it answers connector-unavailable.
   */
  connectors: ConnectorManager & Partial<ConnectorRebuild>;
  /** The migrated canonical DB the screens read from. */
  db: SqlDriver;
  /** The folder holding `db`, shown read-only in Settings. */
  dataDirectory: string;
  /** The canonical file behind `db`, read to show its encryption state; absent for in-memory. */
  databaseFile?: string;
  /** Consent and egress rules, the same instance the Broker asks (composition.ts). */
  egress: EgressControls;
  /** Asked for the presence (never the value) of the key Settings shows; default: none. */
  secrets?: SecretSource;
  /**
   * The Broker and the user action issuer (composition.ts productCalls); only this
   * API layer holds the issuer. Without them the connection test is blocked
   * ("broker-not-bound"); boot.ts always binds them. `providers` are the ones
   * the Broker selects from (the user's default among them); none without it.
   * `execution` is the Broker's own execution gate, asked again for Home's status
   * (V01-T17), so the status never carries a second copy of the rule.
   */
  calls?: {
    broker: Pick<Broker, "call">;
    issuer: UserActionIssuer;
    providers?: readonly LLMProvider[];
    execution: ExecutionGate;
  };
  /** The JSONL import (composition.ts productImporter); without it the route answers connector-unavailable. */
  importer?: JsonlImporter;
  /** The local import API's importer (composition.ts productInstanceImporter); without it the route answers connector-unavailable. */
  instanceImporter?: InstanceImporter;
  /**
   * The entries that run the derivative registry (composition.ts `productEntries`); default the
   * entries over the registry with no composition (knowledge-engine entries.ts).
   */
  entries?: Pick<CanonicalEntries, "userDelete" | "liftTombstone" | "pruneVersions">;
  /**
   * The registry every read path asks before it shows a derived row (I04-R13, read-gate.ts); default
   * the product's kinds with the default scope policy (the composition point passes its own, boot.ts).
   */
  registry?: DerivativeRegistry;
  /**
   * Called after the background setting, a consent, the endpoint or the default
   * Provider changed and the held jobs it can lift were put back in the queue, in
   * the same transaction as the change (held-release.ts), and after a deletion registered
   * the projections' removal jobs (I04-R12); boot wakes the runner.
   * Default none.
   */
  onRunConditionsChanged?: () => void;
  /**
   * The scheduler, the job actions and the budget the Activity screen's job area uses
   * (jobs-view.ts, I03-R23); boot.ts binds them. Without it the job list still reads the
   * rows and every action answers `unavailable`.
   */
  jobs?: JobsPort;
  /**
   * The user's entry to the Semantic registry (composition.ts `productUserDecisions`): the one place
   * a status or epistemic type is set by the user's hand (S01-R7). Only this API layer holds it; without
   * it the approve, reject, dispute and undo routes answer `not-found`.
   */
  decisions?: UserDecisions;
  /** Milliseconds now, for the Provider check's reuse window (tests); default Date.now. */
  now?: () => number;
}

export interface RunningServer {
  url: string;
  /** The address actually bound, as reported by the socket. */
  address: string;
  port: number;
  close(): Promise<void>;
}

type Handlers = {
  [Name in RouteName]: (
    input: RouteRequest<Name>,
  ) => Promise<RouteResponse<Name> | { error: ErrorResponse["error"] }>;
};

export const errorStatus: Partial<Record<ErrorResponse["error"], number>> = {
  "not-found": 404,
  "bad-request": 400,
  "connector-unavailable": 409,
  "destination-unavailable": 409,
  "consent-stale": 409,
  "invalid-endpoint": 400,
  "secret-store-unavailable": 409,
  "embedding-not-implemented": 409,
  "embedding-busy": 409,
  // I01-R21, R24: the import API's own answers; an oversize body answers 413 where it is read
  "instance-busy": 409,
  "storage-failed": 500,
};

/** Provisional: below the Broker's 120 s ceiling, long enough for a CLI to start. */
const CONNECTION_TEST_TIMEOUT_MS = 60_000;

function connectionTestResult(result: BrokerResult): ConnectionTestResult {
  switch (result.status) {
    case "ok":
      return { outcome: "ok", reason: null, isolation: result.cli?.isolation ?? null };
    case "failed":
      return { outcome: "failed", reason: result.error, isolation: null };
    case "cancelled":
      // this call carries no signal: nothing here cuts one
      return { outcome: "blocked", reason: "cancelled", isolation: null };
    default:
      return { outcome: result.status, reason: result.reason, isolation: null };
  }
}

/**
 * V01-R21: the user's one call of Phase 1. This layer opens the user action record
 * (with the acknowledgement the screen sent for this call) and asks the Broker for
 * a connection test; the Broker decides everything else.
 */
async function connectionTest(
  calls: ServerOptions["calls"],
  db: SqlDriver,
  acknowledgeUnverified: boolean,
  check: (provider: LLMProvider) => Promise<ProviderCheck>,
): Promise<ConnectionTestResult> {
  if (!calls) return { outcome: "blocked", reason: "broker-not-bound", isolation: null };
  const result = await calls.issuer.during(
    (userActionId) =>
      calls.broker.call({
        taskKind: "connection-test",
        sourceVersionIds: [],
        candidateItemIds: [],
        origin: { userActionId },
        schemaVersion: 1,
        budget: { timeoutMs: CONNECTION_TEST_TIMEOUT_MS },
        retryable: false,
      }),
    { acknowledgeUnverified },
  );
  const answer = connectionTestResult(result);
  // only where the CLI itself may be why: its run failed, or its execution condition
  // blocked it (a missing CLI reads as "not listed"); never before consent and egress
  const cliStage =
    answer.outcome === "failed" ||
    (answer.outcome === "blocked" && /^(cli|unverified)-/.test(answer.reason ?? ""));
  if (!cliStage) return answer;
  // R5: a default CLI that is missing or logged out gets its install or login guidance
  const provider = selectProvider(calls.providers ?? [], readDefaultProvider(db));
  if (provider?.transport !== "cli") return answer;
  const found = await check(provider);
  const guide =
    !found.installed || found.authentication === "unauthenticated" || found.problem !== undefined;
  return guide ? { ...answer, providerCheck: found } : answer;
}

function providerList(options: ServerOptions): ProviderList {
  const providers = options.calls?.providers ?? [];
  const chosen = readDefaultProvider(options.db);
  return {
    defaultProvider: providers.some((p) => p.id === chosen) ? (chosen ?? null) : null,
    providers: providers.map((p) => ({ providerId: p.id, transport: p.transport })),
  };
}

function setDefaultProvider(
  options: ServerOptions,
  providerId: ProviderId,
): ProviderList | { error: ErrorResponse["error"] } {
  if (!(options.calls?.providers ?? []).some((p) => p.id === providerId)) {
    return { error: "not-found" };
  }
  writeDefaultProvider(options.db, providerId);
  return providerList(options);
}

/**
 * The two queries that need no decision (V01-R9) for one Provider. Run when the user
 * asks ("Provider 확인", a connection test's guidance) and, through the reuse window
 * of `providerChecks`, for the status Home reads (T16). A Provider that fails to
 * answer is reported not installed; its message stays out.
 */
async function checkProvider(provider: LLMProvider): Promise<ProviderCheck> {
  const info: ProviderInfo = await Promise.resolve()
    .then(() => provider.detect())
    .catch(() => ({ installed: false }));
  const runnable = info.installed && info.problem === undefined;
  const authentication = runnable
    ? await Promise.resolve()
        .then(() => provider.checkAuthentication())
        .catch(() => "unknown" as const)
    : "unknown";
  return {
    providerId: provider.id,
    installed: info.installed === true,
    version: info.installed && typeof info.version === "string" ? info.version : null,
    authentication,
    ...(info.problem === "cli-runs-root-refused" ? { problem: info.problem } : {}),
  };
}

/** How long a check's result answers the status without running the queries again (T16, provisional). */
export const PROVIDER_CHECK_REUSE_MS = 60_000;

/**
 * The Provider checks a server shares (T16 handoff 2): `fresh` runs the two queries,
 * and requests that come while they run share them (one set of processes per
 * Provider); `recent` answers a CLI with its last result for PROVIDER_CHECK_REUSE_MS,
 * so Home's status reads, its 1 s polling while a model prepares included, spawn
 * nothing in between. An HTTP Provider's check reads settings and key presence only
 * (no process, no network), so it is always read fresh: an endpoint or key the user
 * just saved shows at once. The user's own check refreshes the result, and `forget`
 * (a new default, saved provider settings) drops what is kept.
 */
function providerChecks(now: () => number) {
  const running = new Map<ProviderId, Promise<ProviderCheck>>();
  const last = new Map<ProviderId, { at: number; check: ProviderCheck }>();
  const fresh = (provider: LLMProvider) => {
    let check = running.get(provider.id);
    if (!check) {
      check = checkProvider(provider)
        .then((found) => (last.set(provider.id, { at: now(), check: found }), found))
        .finally(() => running.delete(provider.id));
      running.set(provider.id, check);
    }
    return check;
  };
  const recent = (provider: LLMProvider) => {
    if (provider.transport !== "cli") return fresh(provider);
    const kept = last.get(provider.id);
    return kept && now() - kept.at < PROVIDER_CHECK_REUSE_MS
      ? Promise.resolve(kept.check)
      : fresh(provider);
  };
  return { fresh, recent, forget: () => last.clear() };
}

/**
 * The call Home's status asks about (V01-T17 handoff 1, provisional): the product's
 * main one, the extraction of an imported general document, which the job runner
 * makes in the background. Set `trigger` to "user" for the connection test's answer
 * instead (a listed CLI with background calls off would then read usable).
 */
const STATUS_EXECUTION = {
  taskKind: "extract",
  trigger: "background",
  classification: "general",
  malicious: false,
  unverifiedAcknowledged: false,
} as const satisfies Partial<ExecutionInput>;

/**
 * Whether the user's default Provider could take a call now (V01-R5, T16, T17), for
 * Home: none chosen, its two queries (a CLI's version and login status, an HTTP
 * Provider's settings and key presence; nothing goes over the network) find it
 * missing or logged out, the egress rules would stop a general document going to
 * it, or the Broker's execution gate would block it (a CLI not on the verified
 * list, background calls off). Only the default is checked: a blocked default is
 * never covered by another Provider (R5), so the others' state is not what Home must show.
 */
async function providerStatus(
  options: ServerOptions,
  check: (provider: LLMProvider) => Promise<ProviderCheck>,
): Promise<ProviderStatus> {
  // one failing read degrades only this row, like the embedding and the index (R5)
  try {
    return await readProviderStatus(options, check);
  } catch {
    return { state: "unavailable", providerId: null, reason: "status-check-failed" };
  }
}

async function readProviderStatus(
  options: ServerOptions,
  check: (provider: LLMProvider) => Promise<ProviderCheck>,
): Promise<ProviderStatus> {
  const provider = selectProvider(options.calls?.providers ?? [], readDefaultProvider(options.db));
  if (!provider) return { state: "unavailable", providerId: null, reason: "no-provider" };
  const found = await check(provider);
  const cli = provider.transport === "cli";
  const reason = !found.installed
    ? cli
      ? "cli-not-installed"
      : "destination-unavailable"
    : (found.problem ??
      (found.authentication === "unauthenticated"
        ? cli
          ? "cli-not-logged-in"
          : "api-key-missing"
        : undefined));
  if (reason !== undefined) {
    return { state: "unavailable", providerId: provider.id, reason, check: found };
  }
  const decision = options.egress.decide({
    providerId: provider.id,
    taskKind: "extract",
    classification: "general",
  });
  if (!decision.allowed) {
    return { state: "unavailable", providerId: provider.id, reason: decision.reason };
  }
  // the Broker's gate, with the version the check found (kept up to 60 s); no process runs
  const execution = options.calls?.execution.decide({
    ...STATUS_EXECUTION,
    providerId: provider.id,
    transport: provider.transport,
    version: found.version ?? undefined,
  });
  if (execution && !execution.run) {
    return { state: "unavailable", providerId: provider.id, reason: execution.reason };
  }
  // a CLI whose login cannot be read (Claude Code has no status command) may still
  // work: ready, with the finding so Home guides like Settings does
  return cli && found.authentication !== "authenticated"
    ? { state: "ready", providerId: provider.id, check: found }
    : { state: "ready", providerId: provider.id };
}

const STATUS_CHECK_FAILED: ComponentStatus = {
  state: "unavailable",
  reason: "status check failed",
};

// One misbehaving adapter degrades only its own entry, so the UI still shows what works (V01-R5).
async function vectorIndexState(index: VectorIndex): Promise<ComponentStatus> {
  try {
    const status = await index.status();
    const mapped = ComponentStatusSchema.safeParse(
      typeof status === "string"
        ? { state: status }
        : { state: "unavailable", reason: status.unavailable },
    );
    // An index that cannot report a valid state cannot serve searches either.
    return mapped.success ? mapped.data : STATUS_CHECK_FAILED;
  } catch {
    return STATUS_CHECK_FAILED;
  }
}

const EMBEDDING_CHECK_FAILED: EmbeddingStatusEntry = {
  state: "unavailable",
  reason: "status check failed",
};

const EMBEDDER_STATES = new Set(["ready", "model-missing", "preparing"]);

// Reads state only: a status request never prepares a model or embeds (V01-R14).
async function embeddingState(embedder: EmbeddingProvider | null): Promise<EmbeddingStatusEntry> {
  if (embedder === null) return { state: "not-implemented" };
  try {
    const { egress } = embedder.describe();
    const status = await embedder.status();
    // "not-implemented" is the API's word for "nothing bound", never an embedder's.
    if (typeof status === "string" && !EMBEDDER_STATES.has(status)) return EMBEDDING_CHECK_FAILED;
    const mapped = EmbeddingStatusSchema.safeParse(
      typeof status === "string"
        ? { state: status, egress }
        : { state: "unavailable", reason: status.unavailable, egress },
    );
    return mapped.success ? mapped.data : EMBEDDING_CHECK_FAILED;
  } catch {
    return EMBEDDING_CHECK_FAILED;
  }
}

/**
 * The endpoint as it will be stored, or undefined when refused. Loopback `http` is
 * stored; the egress policy decides, per build kind, whether it is used.
 */
function storableEndpoint(raw: string): string | undefined {
  const checked = parseEndpoint(raw, true);
  if ("problem" in checked || /[?#]/.test(raw)) return undefined;
  return checked.url.href;
}

/**
 * Starts the preparation the user asked for and answers with the state it left,
 * without waiting (V01-R14). A running one is not restarted, a ready model is left
 * as is. The embedder's error text never reaches the response or the log.
 */
async function prepareEmbedding(
  embedder: EmbeddingProvider | null,
  source: PrepareSource,
  running: Set<AbortController>,
): Promise<RouteResponse<"prepareEmbedding"> | { error: ErrorResponse["error"] }> {
  if (embedder === null) return { error: "embedding-not-implemented" };
  const before = await embeddingState(embedder);
  // `running` is checked after the await too: two requests can both read the
  // state before either starts, and the later one is busy, not a failed start.
  if (before.state === "preparing" || running.size > 0) return { error: "embedding-busy" };
  if (before.state === "ready") return { embedding: before };
  const controller = new AbortController();
  running.add(controller);
  const failed = (error: unknown) => log("embedding-prepare-failed", { error: errorClass(error) });
  try {
    embedder
      .prepare(source, controller.signal)
      .catch(failed)
      .finally(() => running.delete(controller));
  } catch (error) {
    running.delete(controller);
    failed(error);
  }
  return { embedding: await embeddingState(embedder) };
}

function createHandlers(options: ServerOptions, preparations: Set<AbortController>): Handlers {
  // a condition that holds jobs changes together with the release it allows: one
  // transaction, so a stop between the two cannot lose the release (I03-R16 ①)
  const releasing = <T>(
    event: HeldEvent,
    change: () => T,
    applied: (result: T) => boolean = () => true,
  ): T => {
    const result = options.db.transaction(() => {
      const done = change();
      if (applied(done)) releaseHeldOnEvent(options.db, event);
      return done;
    });
    options.onRunConditionsChanged?.();
    return result;
  };
  const entries = options.entries ?? defaultEntries;
  const gate = createReadGate(options.db, options.registry ?? defaultReadRegistry);
  const secrets = options.secrets ?? NO_SECRET_STORE;
  const settings = async () => {
    const baseUrl = readSetting(options.db, OPENAI_BASE_URL_SETTING) ?? null;
    const host = baseUrl !== null && URL.canParse(baseUrl) ? new URL(baseUrl).host : null;
    const keyName = host === null ? null : openaiKeySecretName(host);
    return {
      dataDirectory: options.dataDirectory,
      schemaVersion: schemaVersion(options.db),
      databaseEncryption: databaseEncryption(options.databaseFile),
      openaiCompatible: {
        baseUrl,
        model: readSetting(options.db, OPENAI_MODEL_SETTING) ?? null,
        host,
        keyName,
        key: keyName === null ? null : await secrets.has(keyName),
      },
    };
  };
  const checks = providerChecks(options.now ?? Date.now);
  const jobs = jobsApi(options.db, options.jobs);
  /**
   * One user action on a registry row, in one transaction with the visibility check: a row that is
   * absent, deleted or hidden answers `not-found` (the same, so nothing of a hidden row shows); a
   * refusal of the gate is a code in a 200 body.
   */
  const semanticAction = (
    ref: { kind: SemanticKind; id: number },
    act: (decisions: UserDecisions, at: string) => UndoResult,
  ): RouteResponse<"semanticDecide"> | { error: ErrorResponse["error"] } => {
    const { decisions } = options;
    if (!decisions) return { error: "not-found" };
    return options.db.transaction(() => {
      if (!gate.semanticShown(ref.kind, ref.id)) return { error: "not-found" as const };
      const outcome = act(decisions, new Date(options.now?.() ?? Date.now()).toISOString());
      if (outcome.status === "removed") return { status: "removed" as const };
      if (outcome.status === "refused") {
        return outcome.reason === "not-found"
          ? { error: "not-found" as const }
          : { status: "refused" as const, reason: outcome.reason };
      }
      const now = readSemanticState(options.db, ref);
      if (!now) return { error: "not-found" as const };
      const entry = { ...ref, status: now.status, epistemic: now.epistemic };
      return outcome.status === "applied"
        ? { status: "applied" as const, seq: outcome.seq, entry }
        : { status: "unchanged" as const, entry };
    });
  };
  /**
   * A direct add or a value fix, in one transaction with the visibility checks. Every row it names
   * (the item a fact belongs to, a relation's ends, the fact to fix) must be shown, else `not-found`
   * as for any hidden row. A value the item already has answers `value-exists` with that row's id
   * only when that row is shown too: a hidden row's existence is not told, the answer is `not-found`
   * (S01 spec "S01-T03이 넘기는 것"). The shape of a date value is judged after the visibility.
   */
  const semanticCorrect = (
    correction: RouteRequest<"semanticCorrect">["correction"],
  ): RouteResponse<"semanticCorrect"> | { error: ErrorResponse["error"] } => {
    const { decisions } = options;
    if (!decisions) return { error: "not-found" };
    // the value check is the type definitions' (R21), the one extraction uses; a kind no verified element names is not governed here
    const badValue = (kind: string, value: string) =>
      factValueFit(options.db, kind, value) === "misfit";
    const state = (ref: { kind: SemanticKind; id: number }) => {
      const now = readSemanticState(options.db, ref);
      return now && { ...ref, status: now.status, epistemic: now.epistemic };
    };
    return options.db.transaction((): SemanticCorrection | { error: ErrorResponse["error"] } => {
      const at = new Date(options.now?.() ?? Date.now()).toISOString();
      const refused = (reason: string, existing?: { kind: SemanticKind; id: number }) => {
        if (reason === "not-found") return { error: "not-found" as const };
        if (reason === "value-exists" && existing) {
          // a hidden row's existence is not told
          return gate.semanticShown(existing.kind, existing.id)
            ? { status: "refused" as const, reason: "value-exists" as const, existing }
            : { error: "not-found" as const };
        }
        return { status: "refused" as const, reason: reason as "invalid-transition" };
      };
      if (correction.action === "add") {
        const entry =
          correction.entry.kind === "item"
            ? { ...correction.entry, name: correction.entry.name.trim() }
            : correction.entry.kind === "fact"
              ? { ...correction.entry, value: correction.entry.value.trim() }
              : correction.entry;
        const shown =
          entry.kind === "fact"
            ? gate.semanticShown("item", entry.itemId)
            : entry.kind === "relation"
              ? gate.semanticShown("item", entry.subjectId) &&
                gate.semanticShown("item", entry.objectId)
              : true;
        if (!shown) return { error: "not-found" };
        if (entry.kind === "fact" && badValue(entry.factKind, entry.value)) {
          return { error: "bad-request" };
        }
        const added = decisions.add(options.db, entry, at);
        if (added.status === "refused")
          return refused(added.reason, "existing" in added ? added.existing : undefined);
        const row = state(added.ref);
        return row ? { status: "applied", seq: added.seq, entry: row } : { error: "not-found" };
      }
      const fact = { kind: "fact", id: correction.id } as const;
      if (!gate.semanticShown("fact", fact.id)) return { error: "not-found" };
      const value = correction.value.trim();
      const kind = readFact(options.db, fact.id)?.kind;
      if (kind !== undefined && badValue(kind, value)) return { error: "bad-request" };
      const fixed = decisions.replaceValue(options.db, fact, value, at);
      if (fixed.status === "refused") return refused(fixed.reason, fixed.existing);
      const added = state(fixed.added);
      const replaced = state(fixed.replaced);
      return added && replaced
        ? { status: "applied", seq: fixed.seq, entry: added, replaced }
        : { error: "not-found" };
    });
  };
  /** An outcome as the contract types it: the refusal's code list is a mutable array. */
  const plainOutcome = (outcome: OntologyActionOutcome | UserChangeOutcome) =>
    outcome.status === "refused"
      ? { ...outcome, schemaErrors: [...outcome.schemaErrors] }
      : outcome;
  /** The request's one object as the storage's union: the schema's refinement guarantees what each `op` carries. */
  const changeOf = (c: OntologyChangeRequest): OntologyChange =>
    c.op === "add"
      ? { op: "add", name: c.name, rule: c.rule as NonNullable<typeof c.rule> }
      : c.op === "change-rule"
        ? {
            op: "change-rule",
            name: c.name,
            elementKind: c.elementKind as NonNullable<typeof c.elementKind>,
            rule: c.rule as NonNullable<typeof c.rule>,
          }
        : {
            op: "retire",
            name: c.name,
            elementKind: c.elementKind as NonNullable<typeof c.elementKind>,
          };
  const serverTime = () => new Date(options.now?.() ?? Date.now()).toISOString();
  /**
   * One user action on an element, in one transaction with the visibility check: the id's one
   * not-found is answered before the action, so the action never meets an absent element.
   */
  const ontologyAction = (
    id: number,
    act: (decisions: UserDecisions, at: string) => OntologyActionOutcome,
  ): RouteResponse<"ontologyDecide"> | { error: ErrorResponse["error"] } => {
    const { decisions } = options;
    if (!decisions) return { error: "not-found" };
    return options.db.transaction(() => {
      if (!gate.ontologyShown(id)) return { error: "not-found" as const };
      const outcome = act(decisions, serverTime());
      return plainOutcome(outcome);
    });
  };
  return {
    status: async () => ({
      backend: { state: "ready" },
      provider: await providerStatus(options, checks.recent),
      embedding: await embeddingState(options.embedder),
      vectorIndex: await vectorIndexState(options.vectorIndex),
      invalidations: {
        recent: listInvalidations(options.db, STATUS_INVALIDATIONS).map((r) => ({
          changeSeq: r.changeSeq,
          sourceId: r.sourceId,
          changeKind: r.changeKind,
          removedByKind: r.removedByKind,
          recomputedByKind: r.recomputedByKind,
          at: r.at,
        })),
        scopePolicyDrops: countScopePolicyDrops(options.db),
      },
      dataProtection: {
        legacyCleanup:
          readSetting(options.db, LEGACY_CLEANUP_SETTING) === "done" ? "done" : "pending",
        ledger: ledgerStatus(options.db, options.dataDirectory),
      },
    }),
    connectors: async () => ({ connectors: options.connectors.list() }),
    syncConnector: (input) => options.connectors.sync(input.connectorId),
    // I06-R12: the id only; the manager rebuilds the instance and answers its summary (never a value)
    credentialsChanged: async ({ connectorId }) => {
      if (!options.connectors.rebuild) return { error: "connector-unavailable" };
      return (await options.connectors.rebuild(connectorId)) ?? { error: "not-found" };
    },
    importJsonl: async ({ text }) => {
      if (!options.importer) return { error: "connector-unavailable" };
      try {
        return await options.importer(text);
      } catch (error) {
        if (error instanceof InstanceBusyError) return { error: "instance-busy" };
        throw error;
      }
    },
    imports: async ({ instanceId, content }) =>
      options.instanceImporter
        ? options.instanceImporter(instanceId, content)
        : { error: "connector-unavailable" },
    sources: async () => ({ sources: gate.sources() }),
    searchSources: async (input) => ({ sources: gate.searchSources(input.query) }),
    // V02-R12: the user's deletion; until an explicit lift (none in V02) nothing brings it back
    // The request names the source's whole identity (I01-R8), as the listing shows it.
    deleteSource: async ({ connectorId, namespace, externalId }) => {
      const sourceId = findSourceId(options.db, connectorId, namespace, externalId);
      if (sourceId === undefined) return { error: "not-found" };
      const { outcome } = entries.userDelete(
        options.db,
        { connectorInstanceId: connectorId, namespace, externalId },
        new Date().toISOString(),
      );
      if (outcome === "unchanged") return { outcome: "already-deleted" };
      options.onRunConditionsChanged?.(); // wakes the runner for the removal jobs the deletion registered (I04-R12)
      return { outcome: "deleted" };
    },
    // I04-R10 (optional, I04-T12): the user's prune of one source's earlier versions; never automatic
    pruneVersions: async ({ connectorId, namespace, externalId }) => {
      const result = entries.pruneVersions(
        options.db,
        { connectorInstanceId: connectorId, namespace, externalId },
        new Date().toISOString(),
      );
      if (result.outcome === "not-found") return { error: "not-found" };
      if (result.outcome === "pruned") options.onRunConditionsChanged?.(); // the removal jobs it registered (I04-R12)
      return { outcome: result.outcome, prunedVersions: result.prunedVersions };
    },
    // I04-R9: the only caller of liftTombstone; Connector and source events never lift
    tombstones: async () => ({
      tombstones: listLiftableTombstones(options.db).map((t) => ({
        id: t.sourceId,
        connectorId: t.connectorInstanceId,
        reason: t.reason,
        coversVersion: t.coversVersion,
        at: t.at,
      })),
    }),
    liftTombstone: async ({ id }) =>
      canonicalTransaction(options.db, (tx) =>
        entries.liftTombstone(tx, id, new Date().toISOString()),
      ),
    activity: async () => ({ calls: listProviderCalls(options.db) }),
    jobs: async () => jobs.read(),
    cancelJob: async (input) => jobs.cancel(input),
    retryJob: async (input) => jobs.retry(input),
    discardJob: async (input) => jobs.discard(input),
    changeSchedule: async (input) => jobs.changeSchedule(input),
    disableSchedule: async (input) => jobs.disableSchedule(input),
    enableSchedule: async (input) => jobs.enableSchedule(input),
    runSchedule: async (input) => jobs.runSchedule(input),
    rebuildProjection: async (input) => jobs.rebuildProjection(input),
    settings: async () => settings(),
    writeSettings: async ({ openaiCompatible }) => {
      const baseUrl = storableEndpoint(openaiCompatible.baseUrl);
      if (baseUrl === undefined) return { error: "invalid-endpoint" };
      // keys of other hosts go first, or nothing changes (review N1)
      const keep = openaiKeySecretName(new URL(baseUrl).host);
      if ((await secrets.deleteOthers(keep)) !== "done") {
        return { error: "secret-store-unavailable" };
      }
      releasing("provider-config", () => {
        writeSetting(options.db, OPENAI_BASE_URL_SETTING, baseUrl);
        writeSetting(options.db, OPENAI_MODEL_SETTING, openaiCompatible.model);
      });
      checks.forget();
      return settings();
    },
    consents: async () => options.egress.overview(),
    grantConsent: async ({ providerId, allowedClasses, destination, policyVersion }) => {
      return releasing(
        "consent",
        () => options.egress.grant(providerId, allowedClasses, { destination, policyVersion }),
        (granted) => !("error" in granted),
      );
    },
    revokeConsent: async (input) => {
      return releasing("consent", () => options.egress.revoke(input.providerId));
    },
    connectionTest: (input) =>
      connectionTest(options.calls, options.db, input.acknowledgeUnverified, checks.fresh),
    executionSettings: async () => ({ cliBackground: readCliBackground(options.db) }),
    setExecutionSettings: async ({ cliBackground }) => {
      releasing("background", () =>
        writeSetting(options.db, CLI_BACKGROUND_SETTING, cliBackground ? "on" : "off"),
      );
      return { cliBackground: readCliBackground(options.db) };
    },
    providers: async () => providerList(options),
    setDefaultProvider: async ({ providerId }) => {
      const set = releasing(
        "default-provider",
        () => setDefaultProvider(options, providerId),
        (result) => !("error" in result), // jobs held for "no-provider" are judged again
      );
      checks.forget();
      return set;
    },
    // requests that come while a check runs share it (one set of query processes per
    // Provider, the status's too); the results refresh what the status reuses
    checkProviders: async () => ({
      providers: await Promise.all((options.calls?.providers ?? []).map(checks.fresh)),
    }),
    prepareEmbedding: (input) => prepareEmbedding(options.embedder, input.source, preparations),
    // V02-R14: only active Insights, and a hidden one's evidence list is not-found. A source
    // opens by evidence id while its rows exist (until T08's purge deletes them).
    insights: async () => ({ insights: gate.insights() }),
    insightEvidence: async ({ insightId }) =>
      gate.insightEvidence(insightId) ?? { error: "not-found" },
    evidenceSource: async ({ evidenceId }) =>
      gate.evidenceSource(evidenceId) ?? { error: "not-found" },
    // S01-R23: the registry's rows behind the read gate; the user's actions through the one entry
    semantic: async () => gate.semantic(),
    semanticHistory: async (ref) =>
      gate.semanticShown(ref.kind, ref.id)
        ? { lines: readSemanticHistory(options.db, ref) }
        : { error: "not-found" },
    semanticDecide: async ({ action, ...ref }) =>
      semanticAction(ref, (decisions, at) => decisions.decide(options.db, ref, action, at)),
    semanticCorrect: async ({ correction }) => semanticCorrect(correction),
    semanticUndo: async (ref) =>
      semanticAction(ref, (decisions, at) => decisions.undo(options.db, ref, at)),
    // S01-R23, T07: the type definitions. The user's operations take the same one entry; an id that is
    // absent, deleted or hidden is the one same not-found; a refusal is a code with counts in a 200 body.
    knowledgeSchema: async () => gate.knowledgeSchema(),
    ontology: async () => gate.ontology(),
    ontologyHistory: async ({ id }) =>
      gate.ontologyShown(id)
        ? { lines: readOntologyHistory(options.db, id) }
        : { error: "not-found" },
    ontologyCheck: async (change) => {
      const check = checkOntologyChange(options.db, changeOf(change));
      return {
        duplicates: check.duplicates.length,
        schemaErrors: [...check.schemaErrors],
        impact: check.impact,
        applicable: check.applicable,
      };
    },
    ontologyChange: async (change) => {
      const { decisions } = options;
      if (!decisions) return { error: "not-found" };
      return options.db.transaction(() => {
        return plainOutcome(decisions.ontology.change(options.db, changeOf(change), serverTime()));
      });
    },
    ontologyDecide: async ({ id, action }) =>
      ontologyAction(id, (decisions, at) => decisions.ontology.decide(options.db, id, action, at)),
    ontologyUndo: async ({ id }) =>
      ontologyAction(id, (decisions, at) => decisions.ontology.undo(options.db, id, at)),
  };
}

const TOO_LARGE = Symbol("too-large");

/**
 * The JSON body, TOO_LARGE when it is over `limit` (judged by the declared length first
 * and by the bytes received after, before anything is parsed), or undefined when it is not JSON.
 */
async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  if (Number(req.headers["content-length"]) > limit) return TOO_LARGE;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) return TOO_LARGE;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

async function handle(
  handlers: Handlers,
  name: RouteName,
  req: IncomingMessage,
  res: ServerResponse,
) {
  const route = routes[name];
  let input: unknown;
  if ("request" in route) {
    const body = await readJson(req, BODY_LIMITS[name] ?? MAX_BODY_BYTES);
    if (body === TOO_LARGE && ANSWERS_413.has(name)) return reject(res, 413, "payload-too-large");
    const parsed = route.request.safeParse(body === TOO_LARGE ? undefined : body);
    if (!parsed.success) return reject(res, 400, "bad-request");
    input = parsed.data;
  }
  let result: unknown;
  try {
    result = await (handlers[name] as (input: unknown) => Promise<unknown>)(input);
  } catch (error) {
    // fail closed, with its own answer: no tombstone without a readable ledger line
    if (error instanceof LedgerLineUnwritableError) return reject(res, 409, "ledger-unwritable");
    throw error;
  }
  if (typeof result === "object" && result !== null && "error" in result) {
    const { error } = result as ErrorResponse;
    return reject(res, errorStatus[error] ?? 500, error);
  }
  // Responses are checked against the shared schema before they leave.
  reply(res, 200, routes[name].response.parse(result));
}

function reply(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function reject(res: ServerResponse, status: number, error: ErrorResponse["error"]) {
  reply(res, status, { error });
}

function tokenMatches(header: string | undefined, expected: Buffer) {
  const given = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  if (options.token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`session token must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  const token = Buffer.from(options.token);
  const allowedOrigins = new Set(options.allowedOrigins);
  // Preparations still running when the server closes are aborted; an aborted one leaves no model.
  const preparations = new Set<AbortController>();
  const handlers = createHandlers(options, preparations);
  let selfHost = "";

  const server = createServer((req, res) => {
    // Node keeps only the first Host header, and an absolute-form URI names a host of its
    // own; both would let the Host check read something other than what is routed.
    const hostHeaders = req.rawHeaders.filter((name, i) => i % 2 === 0 && /^host$/i.test(name));
    if (hostHeaders.length > 1) return reject(res, 400, "bad-request");
    // A target starting with "//" would be parsed as naming its own authority too.
    if (!req.url?.startsWith("/") || req.url.startsWith("//")) {
      return reject(res, 400, "bad-request");
    }
    if (req.headers.host !== selfHost) return reject(res, 403, "forbidden-host");
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      return reject(res, 403, "forbidden-origin");
    }
    if (!tokenMatches(req.headers.authorization, token)) return reject(res, 401, "unauthorized");

    const match = matchRoute(routes, req.method, new URL(`http://_${req.url}`).pathname);
    if (typeof match !== "string") {
      return reject(res, match.error === "not-found" ? 404 : 405, match.error);
    }
    // Last resort: any handler failure answers a generic 500. The log names the route
    // and a known error class only; messages can carry content (ADR 0008, V01-R13).
    handle(handlers, match, req, res).catch((error: unknown) => {
      log("route-failed", { route: match, error: errorClass(error) });
      reject(res, 500, "internal-error");
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, LOOPBACK, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { address, port } = server.address() as AddressInfo;
  selfHost = `${LOOPBACK}:${port}`;
  return {
    url: `http://${selfHost}`,
    address,
    port,
    close: () => {
      for (const controller of preparations) controller.abort();
      return new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    },
  };
}
