// Connector management (ARCHITECTURE 5.5, I01-R14 to R21): initializes the configured
// instances once, and syncs one by calling getChanges until it has no more pages. Each
// page, the extraction job of each new version (V02-R4) and the cursor after it are
// written in one transaction, so the stored cursor never runs ahead of the stored
// records (ADR 0013 decision 1) and no version is stored without its job. The change
// sequence rises in the same transaction (storage trigger), and so does a new version's
// propagation to the knowledge its previous versions supported (V02-R11).
// Each change is judged apart from the others (I01-R14): a record that fails its
// schema, its capability declaration or its block rules, or arrives at a tombstone's
// door or with the same revision and other content, is refused alone and the page goes
// on; a page of the wrong shape, one with more than `limit` changes, and a failing
// storage transaction fail the page. What is stored is judged by the knowledge-engine's
// acceptChange (I01-R8 to R12). A sync that stops says why by a code of the closed list
// (SYNC_STOP_CODES), never by the Connector's own text (I01-R4); one instance syncs at
// most once at a time (I01-R21). Each stored version becomes a notice to the
// KnowledgeEngine and VectorIndex, built in the page's transaction with the change
// sequence it reached and delivered after the commit, before the runner is woken
// (V02-R13). A deletion is no notice: the tombstone's transaction registers the
// projections' removal jobs (I04-R12) and the runner is woken after the page's notices. A Connector of another SDK version than CONNECTOR_SDK_VERSION is never
// initialized (I01-R1). The start waits for each instance at most INITIALIZE_TIMEOUT_MS and an
// instance that fails, is late or has no kind is unavailable alone (I05-R10, R11); a recheck builds a
// new object and keeps its result only while its turn still waits (I05-R13).
import {
  ChangeSetEnvelopeSchema,
  CONNECTOR_SDK_VERSION,
  ConnectorError,
  ConnectorNotImplementedError,
  ConnectorRateLimitError,
  type Connector,
  type ConnectorSummary,
  type ErrorResponse,
  type SyncResponse,
  type SyncStopCode,
} from "@pki/contracts";
import { log } from "@pki/providers";
import {
  beginRescan,
  readCursor,
  readRescanState,
  registerConnectorInstance,
  type SqlDriver,
} from "@pki/storage";
import { tryLockInstance } from "./instance-lock.ts";
import { systemClock, type Clock } from "./clock.ts";
import { applyConfiguredScope, NO_SCOPES, type ConnectorScopes } from "./connector-scopes.ts";
import {
  addPage,
  emptyResult,
  storePage,
  type PageOptions,
  type SyncResult,
} from "./page-store.ts";

export { tryLockInstance } from "./instance-lock.ts";
export { EXTRACT_JOB_KIND, REJECTED_LIST_LIMIT } from "./page-store.ts";
export type { RefusalReason, StoredOutcome, SyncResult } from "./page-store.ts";

const PAGE_LIMIT = 100;

/** Provisional (I01-R18), one place: tries per page, the longest wait, the first retry wait. */
export const SYNC_BACKOFF = { attempts: 3, maxWaitMs: 30_000, firstWaitMs: 1000 } as const;

export interface SyncOptions extends PageOptions {
  signal?: AbortSignal;
  /**
   * Read from the start, not from the stored cursor (an import reads its whole text).
   * Not the rescan of I01-R17, which a sync starts itself on an expired cursor: no mark is kept.
   */
  rescan?: boolean;
  /**
   * The caller holds the instance's lock (`tryLockInstance`) for this whole call, as the JSONL
   * import of the Sources screen does for every instance of a request (I01-R21): the sync does
   * not take it again and does not answer `instance-busy`.
   */
  lockHeld?: boolean;
  /**
   * The configured scopes of this backend (I07-R2), copied into the instance's row when this sync
   * first names it; default none, every instance unknown.
   */
  scopes?: ConnectorScopes;
}

export interface ConnectorInstanceConfig {
  id: string;
  kind: string;
  config: unknown;
}

export type ConnectorFactory = () => Connector;

/** Provisional (I05-R10), one place: the longest the start waits for one instance's initialize. */
export const INITIALIZE_TIMEOUT_MS = 10_000;

/** Provisional (I05-R13), one place: rechecks in a row that ended late before an instance's are given up. */
export const RECHECK_LATE_LIMIT = 3;

export interface ConnectorManager {
  list(): ConnectorSummary[];

  sync(
    id: string,
    options?: Pick<SyncOptions, "signal">,
  ): Promise<
    SyncResponse | { error: Extract<ErrorResponse["error"], "not-found" | "connector-unavailable"> }
  >;
}

/** What the hourly recheck of an instance that is not ready needs of the manager (I03-R16 ②′). */
export interface ConnectorRecheck {
  /**
   * Makes a new object of an instance that was not ready, initializes it and asks its health: the
   * instance takes the object and is ready only when both succeed (I05-R13). Returns the
   * instance's state now; undefined for an unknown id, and for a result that came after `turn`
   * was closed: that one is dropped (`turn.open` false), and counts toward giving the instance up.
   */
  recheck(id: string, turn?: RecheckTurn): Promise<ConnectorSummary["state"] | undefined>;
}

/** The one turn that waits for a recheck's result; its owner closes it when it stops waiting. */
export interface RecheckTurn {
  open: boolean;
}

/** The configuration an instance was made with (shown by no API); the default schedules read it. */
export interface ConnectorConfigs {
  configOf(id: string): unknown;
}

/** A page, or the code a sync stops with when it cannot be had (I01-R18). */
type Fetched = { page: unknown } | { stop: SyncStopCode; retryAfterMs?: number };

/**
 * One page, tried up to SYNC_BACKOFF.attempts times with the same cursor (I01-R18). A
 * rate limit waits what the origin asked, at most the cap; a retryable error waits 1
 * second and doubles. The text of what the Connector threw is never kept. An error that
 * is none of the Connector's own failures (a plain exception) is not known to be safe to
 * try again, so it stops as `connector-failed`.
 */
async function fetchPage(
  connector: Connector,
  cursor: string | null,
  signal: AbortSignal,
  clock: Pick<Clock, "sleep">,
): Promise<Fetched> {
  for (let attempt = 1; ; attempt++) {
    if (signal.aborted) return { stop: "aborted" };
    try {
      return { page: await connector.getChanges(cursor, { limit: PAGE_LIMIT, signal }) };
    } catch (error) {
      if (signal.aborted) return { stop: "aborted" };
      let waitMs: number;
      let exhausted: Fetched & { stop: SyncStopCode };
      if (error instanceof ConnectorRateLimitError) {
        waitMs = Math.min(error.retryAfterMs, SYNC_BACKOFF.maxWaitMs);
        exhausted = { stop: "rate-limited", retryAfterMs: error.retryAfterMs };
      } else if (error instanceof ConnectorError && error.retryable) {
        waitMs = Math.min(SYNC_BACKOFF.firstWaitMs * 2 ** (attempt - 1), SYNC_BACKOFF.maxWaitMs);
        exhausted = { stop: "connector-error" };
      } else {
        return { stop: "connector-failed" };
      }
      if (attempt >= SYNC_BACKOFF.attempts) return exhausted;
      await clock.sleep(waitMs, signal);
    }
  }
}

export async function syncConnector(
  db: SqlDriver,
  instanceId: string,
  kind: string,
  connector: Connector,
  options: SyncOptions = {},
): Promise<SyncResult> {
  if (options.lockHeld) return runSync(db, instanceId, kind, connector, options);
  const release = tryLockInstance(db, instanceId);
  if (!release) return { ...emptyResult(), stopped: "instance-busy" };
  try {
    return await runSync(db, instanceId, kind, connector, options);
  } finally {
    release();
  }
}

async function runSync(
  db: SqlDriver,
  instanceId: string,
  kind: string,
  connector: Connector,
  options: SyncOptions,
): Promise<SyncResult> {
  const signal = options.signal ?? new AbortController().signal;
  const clock = options.clock ?? systemClock;
  const capabilities = connector.manifest.capabilities;
  db.transaction(() => {
    registerConnectorInstance(db, instanceId, kind);
    applyConfiguredScope(db, instanceId, options.scopes ?? NO_SCOPES); // a source's grade compares claims with it (I01-R15)
  });
  // A rescan the last sync left unfinished is this one's to end (I01-R17).
  let rescanning = readRescanState(db, instanceId).pending;
  // Only a rescan this sync started ends it when its cursor expires; a carried-over
  // one may be restarted once (I01-R17: one rescan per sync).
  let startedHere = false;
  let cursor = options.rescan ? null : readCursor(db, instanceId);
  const result = emptyResult();
  const stop = (code: SyncStopCode, retryAfterMs?: number): SyncResult => ({
    ...result,
    rescanned: rescanning,
    deletionsMayBeMissed: rescanning && !capabilities.deletionsOnRescan,
    stopped: code,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
  for (;;) {
    const fetched = await fetchPage(connector, cursor, signal, clock);
    if ("stop" in fetched) return stop(fetched.stop, fetched.retryAfterMs);
    if (signal.aborted) return stop("aborted"); // a page that arrived after the cut is not stored
    const envelope = ChangeSetEnvelopeSchema.safeParse(fetched.page);
    if (!envelope.success || envelope.data.changes.length > PAGE_LIMIT) return stop("invalid-page");
    const page = envelope.data;
    if (page.cursorExpired) {
      // One full rescan per sync, and only for a Connector that can: a second expiry
      // while rescanning, or one on a null cursor, ends it (I01-R17).
      if (startedHere || cursor === null || !capabilities.fullRescan) return stop("cursor-expired");
      db.transaction(() => beginRescan(db, instanceId, !capabilities.deletionsOnRescan));
      rescanning = true;
      startedHere = true;
      cursor = null;
      continue;
    }
    // A page that promises more without moving would otherwise loop forever.
    if (page.hasMore && page.nextCursor === cursor) return stop("no-progress");

    const stored = storePage(
      { db, instanceId, kind, capabilities, options },
      {
        changes: page.changes,
        rejected: page.rejected,
        nextCursor: page.nextCursor,
        endsRescan: rescanning && !page.hasMore,
      },
    );
    if ("stopped" in stored) return stop(stored.stopped);
    addPage(result, stored);
    cursor = page.nextCursor;
    if (!page.hasMore) {
      return {
        ...result,
        rescanned: rescanning,
        deletionsMayBeMissed: rescanning && !capabilities.deletionsOnRescan,
      };
    }
  }
}

/** What initializing one Connector came to, as the Connector list shows it. */
export type InitializeOutcome =
  | { state: "ready" }
  | { state: "unavailable"; reason: "unsupported-sdk-version" }
  | { state: "not-implemented" | "unavailable"; error: unknown };

/**
 * Initializes a Connector unless it implements another SDK version (I01-R1): that
 * one is never initialized and is unavailable for `unsupported-sdk-version`. So
 * is one whose manifest cannot be read (missing, or a getter that throws): only
 * that instance fails, and the thrown text is dropped.
 */
export async function initializeConnector(
  connector: Connector,
  config: unknown,
): Promise<InitializeOutcome> {
  let version: unknown;
  try {
    version = connector.manifest.schemaVersion;
  } catch {
    version = undefined;
  }
  if (version !== CONNECTOR_SDK_VERSION) {
    return { state: "unavailable", reason: "unsupported-sdk-version" };
  }
  try {
    await connector.initialize(config);
    return { state: "ready" };
  } catch (error) {
    const state = error instanceof ConnectorNotImplementedError ? "not-implemented" : "unavailable";
    return { state, error };
  }
}

/**
 * `site-check <kind>` (V01-R18, I01-R1): one line naming the kind and its outcome,
 * the version reason or the initialization error's message, and whether it is ok.
 */
export async function siteCheck(
  kind: string,
  create: ConnectorFactory,
): Promise<{ ok: boolean; line: string }> {
  const outcome = await initializeConnector(create(), {});
  if (outcome.state === "ready") return { ok: true, line: `${kind}: ok` };
  if ("reason" in outcome) return { ok: false, line: `${kind}: ${outcome.reason}` };
  const { error } = outcome;
  return { ok: false, line: `${kind}: ${error instanceof Error ? error.message : String(error)}` };
}

/** What one instance is: its state, the object that initialized (only a ready one is used), and how to make another. */
interface Entry {
  summary: ConnectorSummary;
  config: unknown;
  connector: Connector | undefined;
  /** Undefined for a kind this build does not have. */
  factory: ConnectorFactory | undefined;
  /** Rechecks in a row that ended after their turn closed (I05-R13). */
  lateRechecks: number;
  abandonedLogged: boolean;
}

/**
 * The one place a Connector is made and initialized, for the start and for a recheck (I05-R13).
 * A factory that throws is `unavailable` and logs its fixed code; the thrown text is dropped.
 */
async function openConnector(
  id: string,
  factory: ConnectorFactory,
  config: unknown,
): Promise<{ connector: Connector | undefined; outcome: InitializeOutcome }> {
  let connector: Connector;
  try {
    connector = factory();
  } catch {
    log("connector-factory-failed", { id });
    return { connector: undefined, outcome: { state: "unavailable", error: undefined } };
  }
  return { connector, outcome: await initializeConnector(connector, config) };
}

/** Whether a ready outcome's object also reports itself healthy (initialized is not enough). */
async function healthy(connector: Connector): Promise<boolean> {
  try {
    return (await connector.healthCheck()).state === "ok";
  } catch {
    return false;
  }
}

export async function createConnectorManager(
  db: SqlDriver,
  instances: readonly ConnectorInstanceConfig[],
  kinds: Readonly<Record<string, ConnectorFactory>>,
  options: Pick<SyncOptions, "runner" | "projections" | "clock" | "entries" | "scopes"> = {},
): Promise<ConnectorManager & ConnectorRecheck & ConnectorConfigs> {
  const summaryOf = (id: string, kind: string, outcome: InitializeOutcome): ConnectorSummary =>
    "reason" in outcome
      ? { id, kind, state: outcome.state, reason: outcome.reason }
      : { id, kind, state: outcome.state };
  const unavailable: InitializeOutcome = { state: "unavailable", error: undefined };
  // each instance alone: a late result of one that passed its limit is never read (I05-R10, R11)
  const entries: Entry[] = await Promise.all(
    instances.map(async ({ id, kind, config }): Promise<Entry> => {
      const factory = Object.hasOwn(kinds, kind) ? kinds[kind] : undefined;
      const entry = (outcome: InitializeOutcome, connector?: Connector): Entry => ({
        summary: summaryOf(id, kind, outcome),
        config,
        connector,
        factory,
        lateRechecks: 0,
        abandonedLogged: false,
      });
      if (!factory) {
        log("connector-kind-unknown", { id });
        return entry(unavailable);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), INITIALIZE_TIMEOUT_MS);
      });
      const opened = await Promise.race([openConnector(id, factory, config), limit]);
      clearTimeout(timer);
      if (opened === "timeout") {
        log("connector-initialize-timeout", { id });
        return entry(unavailable);
      }
      // the start only: a recheck runs every hour and would repeat it
      if (opened.connector && opened.outcome.state === "unavailable" && "error" in opened.outcome) {
        log("connector-initialize-failed", { id });
      }
      return entry(opened.outcome, opened.connector);
    }),
  );
  return {
    // the mark lives in the file, so a restart keeps it (I01-R17)
    list: () =>
      entries.map(({ summary }) =>
        readRescanState(db, summary.id).deletionsMayBeMissed
          ? { ...summary, deletionsMayBeMissed: true }
          : { ...summary },
      ),
    configOf: (id) => entries.find((e) => e.summary.id === id)?.config,
    async recheck(id, turn) {
      const entry = entries.find((e) => e.summary.id === id);
      if (!entry) return undefined;
      if (entry.summary.state === "ready") return "ready";
      const { id: instanceId, kind } = entry.summary;
      if (!entry.factory) return entry.summary.state; // no kind: nothing to make
      if (entry.lateRechecks >= RECHECK_LATE_LIMIT) {
        if (!entry.abandonedLogged) log("connector-recheck-abandoned", { id: instanceId });
        entry.abandonedLogged = true;
        return entry.summary.state;
      }
      const { connector, outcome } = await openConnector(instanceId, entry.factory, entry.config);
      const ready =
        outcome.state === "ready" && connector !== undefined && (await healthy(connector));
      if (turn && !turn.open) {
        entry.lateRechecks++; // its turn stopped waiting: the result is dropped, the object left open
        return undefined;
      }
      entry.lateRechecks = 0;
      if (ready) entry.connector = connector;
      // initialized but not healthy is unavailable, like an initialization that failed
      entry.summary = summaryOf(
        instanceId,
        kind,
        ready ? { state: "ready" } : outcome.state === "ready" ? unavailable : outcome,
      );
      return entry.summary.state;
    },
    async sync(id, syncOptions = {}) {
      const entry = entries.find((e) => e.summary.id === id);
      if (!entry) return { error: "not-found" };
      if (entry.summary.state !== "ready" || !entry.connector) {
        return { error: "connector-unavailable" };
      }
      return {
        connectorId: id,
        ...(await syncConnector(db, id, entry.summary.kind, entry.connector, {
          ...options,
          ...syncOptions,
        })),
      };
    },
  };
}
