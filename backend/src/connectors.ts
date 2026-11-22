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
// most once at a time (I01-R21). Each stored version and each deletion becomes a notice
// to the KnowledgeEngine and VectorIndex, built in the page's transaction with the change
// sequence it reached and delivered after the commit, before the runner is woken
// (V02-R13). A Connector of another SDK version than CONNECTOR_SDK_VERSION is never
// initialized (I01-R1).
import {
  blocksValid,
  ChangeSchema,
  ChangeSetEnvelopeSchema,
  CONNECTOR_SDK_VERSION,
  ConnectorError,
  ConnectorNotImplementedError,
  ConnectorRateLimitError,
  rejectedPositionValid,
  type Change,
  type Connector,
  type ConnectorCapabilities,
  type ConnectorSummary,
  type ErrorResponse,
  type RejectCode,
  type SyncResponse,
  type SyncStopCode,
} from "@pki/contracts";
import {
  acceptChange,
  propagateNewVersion,
  versionNotice,
  type ProjectionNotice,
  type Projections,
} from "@pki/knowledge-engine";
import {
  beginRescan,
  canonicalTransaction,
  finishRescan,
  readCursor,
  readRescanState,
  registerConnectorInstance,
  registerJob,
  writeCursor,
  type CanonicalTx,
  type SqlDriver,
} from "@pki/storage";
import { systemClock, type Clock } from "./clock.ts";
import type { JobRunner } from "./job-runner.ts";

const PAGE_LIMIT = 100;

/** Provisional (I01-R18), one place: tries per page, the longest wait, the first retry wait. */
export const SYNC_BACKOFF = { attempts: 3, maxWaitMs: 30_000, firstWaitMs: 1000 } as const;

/** Provisional: refused records listed in a result; `rejectedCount` counts them all. */
export const REJECTED_LIST_LIMIT = 100;

/** The job each new source version gets; its handler is V02-T05's. */
export const EXTRACT_JOB_KIND = "extract";

/**
 * A change the store would not take; nothing of it is written. `revision-not-newer`
 * is the same revision with other content (I01-R10 step 2); `tombstoned` is the
 * door of a tombstone (step 0).
 */
export type RefusalReason = "revision-not-newer" | "tombstoned";

/**
 * What a change did: a new version, a new scope, its source tombstoned, or nothing
 * new (`unchanged`; `stale` for an older revision, `stale-tombstone` for a delete
 * below the revision the store holds: neither is an error, I01-R10, R11).
 */
export type StoredOutcome =
  "created" | "unchanged" | "deleted" | "scope-updated" | "stale" | "stale-tombstone";

/** What one sync did; the API adds the instance's id (SyncResponse). */
export type SyncResult = Omit<SyncResponse, "connectorId">;

export interface SyncOptions {
  signal?: AbortSignal;
  /**
   * Read from the start, not from the stored cursor (an import reads its whole text).
   * Not the rescan of I01-R17, which a sync starts itself on an expired cursor: no mark is kept.
   */
  rescan?: boolean;
  /** Takes each change refused at a tombstone's door or for revision conflict, once its page is committed. */
  onRefused?: (change: Change, reason: RefusalReason) => void;
  /** Takes each stored, unchanged or deleting change once its page is committed. */
  onStored?: (change: Change, outcome: StoredOutcome) => void;
  /** Takes the error that failed a page's storage; its text may carry file text: log its class only. */
  onError?: (error: unknown) => void;
  /** Woken after a page that registered jobs commits (V02-T05 binds the runner). */
  runner?: Pick<JobRunner, "wake">;
  /** Notified after each page commits, of its stored versions and deletions (V02-R13). */
  projections?: Pick<Projections, "notify">;
  /** Gives a registered job its time and waits between tries, the runner's clock (I03-T04); default systemClock. */
  clock?: Pick<Clock, "now" | "sleep">;
}

export interface ConnectorInstanceConfig {
  id: string;
  kind: string;
  config: unknown;
}

export type ConnectorFactory = () => Connector;

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
   * Initializes an instance that was not ready again and asks its health: ready only when
   * both succeed. Returns the instance's state now; undefined for an unknown id.
   */
  recheck(id: string): Promise<ConnectorSummary["state"] | undefined>;
}

const locks = new WeakMap<SqlDriver, Set<string>>();

/**
 * Takes an instance's lock, or returns undefined when it is held (I01-R21): one sync or
 * import per instance at a time. Call the returned function once, in a `finally`, on
 * every path. Locks are kept per database handle, so every taker must hold the same one.
 */
export function tryLockInstance(db: SqlDriver, instanceId: string): (() => void) | undefined {
  let held = locks.get(db);
  if (!held) locks.set(db, (held = new Set()));
  if (held.has(instanceId)) return undefined;
  held.add(instanceId);
  const set = held;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    set.delete(instanceId);
  };
}

/** The ways a change may be refused before it reaches the store (I01-R3). */
function violatesCapabilities(change: Change, capabilities: ConnectorCapabilities): boolean {
  if (change.kind === "upsert") {
    const scoped = change.record.accessScope !== undefined;
    return capabilities.accessScope ? !scoped : scoped;
  }
  if (change.kind === "scope-change") return !capabilities.accessScope;
  return !capabilities.deletes; // delete, access-revoked
}

type Judged =
  | StoredOutcome
  /** the door of a tombstone */
  | "blocked"
  /** the same revision, other content */
  | "revision-conflict";

/**
 * Stores one change; a version is stored together with its extraction job. A
 * source is the instance's (namespace, external id) (I01-R8). The judgment is
 * acceptChange's; a deletion takes the product's clock (`at` is not stored: no
 * Connector text reaches the tombstone).
 */
function storeChange(
  tx: CanonicalTx,
  instanceId: string,
  change: Change,
  notices: ProjectionNotice[],
  clock: Pick<Clock, "now">,
): Judged {
  const saved = acceptChange(tx, instanceId, change, new Date(clock.now()).toISOString());
  if (saved.outcome === "blocked") return "blocked";
  if (saved.outcome === "rejected") return "revision-conflict";
  if (saved.outcome === "tombstoned") {
    if (saved.notice) notices.push(saved.notice);
    return "deleted";
  }
  if (saved.outcome !== "created") return saved.outcome;
  propagateNewVersion(tx, saved.sourceId);
  notices.push(versionNotice(tx, saved.sourceId, saved.version));
  const job = registerJob(tx, {
    kind: EXTRACT_JOB_KIND,
    sourceId: saved.sourceId,
    fenceVersion: saved.version,
    at: new Date(clock.now()), // the clock the runner claims by
  });
  // A conflict is not a registration (V02 spec "T02가 넘기는 것" 3): the page fails.
  if (!job.registered) {
    throw new Error(
      `${instanceId}: an ${EXTRACT_JOB_KIND} job for source ${saved.sourceId} version ${saved.version} exists already (${job.existing.status})`,
    );
  }
  return "created";
}

const emptyResult = (): SyncResult => ({
  received: 0,
  created: 0,
  unchanged: 0,
  scopeUpdated: 0,
  stale: 0,
  staleTombstone: 0,
  blocked: 0,
  tombstoned: 0,
  rejected: [],
  rejectedCount: 0,
  rescanned: false,
  deletionsMayBeMissed: false,
});

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
  db.transaction(() => registerConnectorInstance(db, instanceId, kind));
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

    const refused: [Change, RefusalReason][] = [];
    const stored: [Change, StoredOutcome][] = [];
    const rejected: { at: string; code: RejectCode }[] = [];
    const counts = emptyResult();
    const notices: ProjectionNotice[] = [];
    // what the Connector refused itself: its position is kept only in the short shape
    page.rejected.forEach(({ at, code }, i) => {
      rejected.push({ at: rejectedPositionValid(at) ? at : `change:${i}`, code });
    });
    const judged: [number, Change][] = [];
    page.changes.forEach((raw, i) => {
      const parsed = ChangeSchema.safeParse(raw);
      const refuse = (code: RejectCode) => rejected.push({ at: `change:${i}`, code });
      if (!parsed.success) return refuse("schema");
      const change = parsed.data;
      if (violatesCapabilities(change, capabilities)) return refuse("capability-violation");
      if (
        change.kind === "upsert" &&
        !blocksValid(change.record.body, change.record.blocks ?? [])
      ) {
        return refuse("invalid-blocks");
      }
      judged.push([i, change]);
    });

    let pageCreated: number;
    try {
      pageCreated = canonicalTransaction(db, (tx) => {
        let created = 0;
        for (const [i, change] of judged) {
          const outcome = storeChange(tx, instanceId, change, notices, clock);
          if (outcome === "blocked") {
            counts.blocked++;
            refused.push([change, "tombstoned"]);
          } else if (outcome === "revision-conflict") {
            rejected.push({ at: `change:${i}`, code: "revision-conflict" });
            refused.push([change, "revision-not-newer"]);
          } else {
            stored.push([change, outcome]);
            if (outcome === "created") created++;
            else if (outcome === "unchanged") counts.unchanged++;
            else if (outcome === "scope-updated") counts.scopeUpdated++;
            else if (outcome === "stale") counts.stale++;
            else if (outcome === "stale-tombstone") counts.staleTombstone++;
            else counts.tombstoned++;
          }
        }
        writeCursor(tx, instanceId, page.nextCursor);
        // the page that ends a rescan ends it in the same transaction
        if (rescanning && !page.hasMore) {
          finishRescan(tx, instanceId, !capabilities.deletionsOnRescan);
        }
        return created;
      });
    } catch (error) {
      // nothing of this page was stored, and none of its text reaches the result (I01-R4)
      options.onError?.(error);
      return stop("storage-failed");
    }
    for (const [change, reason] of refused) options.onRefused?.(change, reason);
    for (const [change, outcome] of stored) options.onStored?.(change, outcome);
    // The runner is woken once the engine has the page's versions, so a proposing
    // engine knows what is extracted.
    const delivered = notices.length > 0 ? options.projections?.notify(notices) : undefined;
    if (pageCreated > 0) {
      const runner = options.runner;
      if (delivered) void delivered.then(() => runner?.wake());
      else void runner?.wake();
    }
    result.received += page.changes.length;
    result.created += pageCreated;
    for (const key of [
      "unchanged",
      "scopeUpdated",
      "stale",
      "staleTombstone",
      "blocked",
      "tombstoned",
    ] as const) {
      result[key] += counts[key];
    }
    result.rejectedCount += rejected.length;
    for (const entry of rejected) {
      if (result.rejected.length < REJECTED_LIST_LIMIT) result.rejected.push(entry);
    }
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

export async function createConnectorManager(
  db: SqlDriver,
  instances: readonly ConnectorInstanceConfig[],
  kinds: Readonly<Record<string, ConnectorFactory>>,
  options: Pick<SyncOptions, "runner" | "projections" | "clock"> = {},
): Promise<ConnectorManager & ConnectorRecheck> {
  const summaryOf = (id: string, kind: string, outcome: InitializeOutcome): ConnectorSummary =>
    "reason" in outcome
      ? { id, kind, state: outcome.state, reason: outcome.reason }
      : { id, kind, state: outcome.state };
  const entries = await Promise.all(
    instances.map(async ({ id, kind, config }) => {
      const factory = Object.hasOwn(kinds, kind) ? kinds[kind] : undefined;
      if (!factory) throw new Error(`unknown connector kind: ${kind}`);
      const connector = factory();
      const outcome = await initializeConnector(connector, config);
      return { summary: summaryOf(id, kind, outcome), connector, config };
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
    async recheck(id) {
      const entry = entries.find((e) => e.summary.id === id);
      if (!entry) return undefined;
      if (entry.summary.state === "ready") return "ready";
      const { id: instanceId, kind } = entry.summary;
      const outcome = await initializeConnector(entry.connector, entry.config);
      let ready = outcome.state === "ready";
      if (ready) {
        // initialized is not enough: the origin must also say it is fine
        try {
          ready = (await entry.connector.healthCheck()).state === "ok";
        } catch {
          ready = false;
        }
      }
      // initialized but not healthy is unavailable, like an initialization that failed
      const now: InitializeOutcome = ready
        ? { state: "ready" }
        : outcome.state === "ready"
          ? { state: "unavailable", error: undefined }
          : outcome;
      entry.summary = summaryOf(instanceId, kind, now);
      return entry.summary.state;
    },
    async sync(id, syncOptions = {}) {
      const entry = entries.find((e) => e.summary.id === id);
      if (!entry) return { error: "not-found" };
      if (entry.summary.state !== "ready") return { error: "connector-unavailable" };
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
