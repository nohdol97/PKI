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
  HEALTH_REASON_CREDENTIAL_REJECTED,
  isConnectorCredentialError,
  type Connector,
  type ConnectorContext,
  type ConnectorSummary,
  type CredentialReason,
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
  CREDENTIAL_RETRY_MIN_MS,
  createCredentialAccess,
  declareCredentials,
  reasonOfPresence,
  REFUSING_CREDENTIALS,
  type CredentialAccess,
  type CredentialStore,
} from "./connector-credentials.ts";
import { RECHECK_TIMEOUT_MS } from "./connector-sync-job.ts";
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
  /** The credential slots this instance needs (I06-R2): names, never values. */
  credentials?: readonly string[];
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
      } else if (isConnectorCredentialError(error)) {
        return { stop: "credential-unusable" }; // the same call is not tried again (I06-R10)
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

/**
 * The sync answers whose stop came from an object the instance had already replaced (I06-R10). A side
 * table, not a field: the answer is the API's body and carries nothing about the manager's objects.
 */
const replacedStops = new WeakSet<object>();
export const isReplacedStop = (answer: object): boolean => replacedStops.has(answer);
export const markReplacedStop = (answer: object): void => void replacedStops.add(answer);

/** What initializing one Connector came to, as the Connector list shows it. */
export type InitializeOutcome =
  | { state: "ready" }
  | { state: "unavailable"; reason: "unsupported-sdk-version" | CredentialReason }
  | { state: "not-implemented" | "unavailable"; error: unknown };

/**
 * Initializes a Connector unless it implements another SDK version (I01-R1): that
 * one is never initialized and is unavailable for `unsupported-sdk-version`. So
 * is one whose manifest cannot be read (missing, or a getter that throws): only
 * that instance fails, and the thrown text is dropped. `context` is what the
 * manager hands `initialize` beside the config (I06-R5).
 */
export async function initializeConnector(
  connector: Connector,
  config: unknown,
  context: ConnectorContext,
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
    await connector.initialize(config, context);
    return { state: "ready" };
  } catch (error) {
    const state = error instanceof ConnectorNotImplementedError ? "not-implemented" : "unavailable";
    return { state, error };
  }
}

/**
 * `site-check <kind>` (V01-R18, I01-R1, I06-R8): one line naming the kind and its outcome,
 * the version reason or the initialization error's message, and whether it is ok. The Connector gets an
 * accessor that refuses every read; one that ends with the credential refusal is implemented and needs
 * a value, which is `ok (credential-required)` and never the error's text.
 */
export async function siteCheck(
  kind: string,
  create: ConnectorFactory,
): Promise<{ ok: boolean; line: string }> {
  const outcome = await initializeConnector(create(), {}, { credentials: REFUSING_CREDENTIALS });
  if (outcome.state === "ready") return { ok: true, line: `${kind}: ok` };
  if ("reason" in outcome) return { ok: false, line: `${kind}: ${outcome.reason}` };
  const { error } = outcome;
  if (isConnectorCredentialError(error))
    return { ok: true, line: `${kind}: ok (credential-required)` };
  return { ok: false, line: `${kind}: ${error instanceof Error ? error.message : String(error)}` };
}

/** What one instance is: its state, the object that initialized (only a ready one is used), and how to make another. */
interface Entry {
  summary: ConnectorSummary;
  config: unknown;
  connector: Connector | undefined;
  /** The accessor of `connector`; cut when that object is given up (I06-R7). */
  access: CredentialAccess | undefined;
  /** Undefined for a kind this build does not have. */
  factory: ConnectorFactory | undefined;
  /** The declared slots with their stored names; undefined for a declaration that cannot be used. */
  slots: readonly { slot: string; name: string }[] | undefined;
  /** The last presence answer of each slot (I06-R13). */
  states: readonly ("present" | "missing" | "unavailable")[];
  /** Rechecks in a row that ended after their turn closed (I05-R13). */
  lateRechecks: number;
  abandonedLogged: boolean;
  /** The one recheck or rebuild under way (I06-R12): settles when it ended, whatever its turn did. */
  slot: Promise<void> | undefined;
  /** A change notice that came while the slot was taken or the gap had not passed: one rebuild owed. */
  pending: boolean;
  /** When the last notice-driven rebuild that ended `credential-rejected` began (the gap's start). */
  rejectedRebuildAt: number | undefined;
  gapTimer: ReturnType<typeof setTimeout> | undefined;
}

/** What a change notice answers (I06-R12): the instance's summary and what became of the rebuild. */
export interface RebuildAnswer {
  summary: ConnectorSummary;
  rebuild: "done" | "queued" | "skipped";
}

/** What a change notice needs of the manager (I06-R12); undefined for an unknown id. */
export interface ConnectorRebuild {
  rebuild(id: string): Promise<RebuildAnswer | undefined>;
}

/**
 * The one place a Connector is made and initialized: the start, a recheck and a rebuild all pass here
 * (I05-R13, I06-R6). The declared slots are asked for first, all at once; a missing or unusable one
 * leaves the instance unavailable for its reason and no object is made. Else the factory makes the object
 * and `initialize` gets `access`'s accessor. A refusal is judged by the store's answers (I06-R9), never by
 * what the Connector said. A factory that throws is `unavailable` and logs its fixed code.
 */
async function openConnector(
  id: string,
  factory: ConnectorFactory,
  config: unknown,
  access: CredentialAccess,
): Promise<{ connector: Connector | undefined; outcome: InitializeOutcome }> {
  if (access.declared) {
    const reason = reasonOfPresence(await access.check());
    if (reason) return { connector: undefined, outcome: { state: "unavailable", reason } };
  }
  let connector: Connector;
  try {
    connector = factory();
  } catch {
    log("connector-factory-failed", { id });
    return { connector: undefined, outcome: { state: "unavailable", error: undefined } };
  }
  const outcome = await initializeConnector(connector, config, { credentials: access.credentials });
  if (
    outcome.state === "unavailable" &&
    "error" in outcome &&
    isConnectorCredentialError(outcome.error)
  ) {
    const reason = await access.judge();
    return {
      connector,
      outcome: reason
        ? { state: "unavailable", reason }
        : { state: "unavailable", error: undefined },
    };
  }
  return { connector, outcome };
}

/** What a ready object's health says: only the one fixed reason is read, and it says the origin refused (I06-R5). */
async function healthOf(connector: Connector): Promise<"ok" | "rejected" | "down"> {
  try {
    const health = await connector.healthCheck();
    if (health.state === "ok") return "ok";
    return health.reason === HEALTH_REASON_CREDENTIAL_REJECTED ? "rejected" : "down";
  } catch {
    return "down";
  }
}

export async function createConnectorManager(
  db: SqlDriver,
  instances: readonly ConnectorInstanceConfig[],
  kinds: Readonly<Record<string, ConnectorFactory>>,
  options: Pick<SyncOptions, "runner" | "projections" | "clock" | "entries" | "scopes"> & {
    /** Where credentials come from (I06-R6); none: every declared slot is `unavailable` (I06-R18). */
    secrets?: CredentialStore | undefined;
    /**
     * Called when a new object turned an instance `ready` (a rebuild, owed or immediate, or a recheck):
     * the held collector jobs of the instance go back (I06-R12). Never throws into the manager.
     */
    onReady?: (id: string) => void;
  } = {},
): Promise<ConnectorManager & ConnectorRecheck & ConnectorConfigs & ConnectorRebuild> {
  const { secrets } = options;
  const clock = options.clock ?? systemClock;
  const summaryOf = (id: string, kind: string, outcome: InitializeOutcome): ConnectorSummary =>
    "reason" in outcome
      ? { id, kind, state: outcome.state, reason: outcome.reason }
      : { id, kind, state: outcome.state };
  const unavailable: InitializeOutcome = { state: "unavailable", error: undefined };
  // each instance alone: a late result of one that passed its limit is never read (I05-R10, R11)
  const entries: Entry[] = await Promise.all(
    instances.map(async ({ id, kind, config, credentials }): Promise<Entry> => {
      const factory = Object.hasOwn(kinds, kind) ? kinds[kind] : undefined;
      const declared = declareCredentials(kind, id, credentials);
      const slots = declared === "invalid" ? undefined : declared;
      const access = createCredentialAccess(slots ?? [], secrets);
      const entry = (outcome: InitializeOutcome, connector?: Connector): Entry => {
        const ready = outcome.state === "ready" && connector !== undefined;
        if (!ready) access.revoke(); // an object given up reads nothing more (I06-R7)
        return {
          summary: summaryOf(id, kind, outcome),
          config,
          connector,
          access: ready ? access : undefined,
          factory,
          slots,
          states: access.states(),
          lateRechecks: 0,
          abandonedLogged: false,
          slot: undefined,
          pending: false,
          rejectedRebuildAt: undefined,
          gapTimer: undefined,
        };
      };
      if (!factory) {
        log("connector-kind-unknown", { id });
        return entry(unavailable);
      }
      if (!slots) {
        log("connector-credentials-invalid", { id });
        return entry(unavailable);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), INITIALIZE_TIMEOUT_MS);
      });
      const opened = await Promise.race([openConnector(id, factory, config, access), limit]);
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

  const find = (id: string): Entry | undefined => entries.find((e) => e.summary.id === id);

  /** The instance takes the result of a new object, and the object it had is given up (I05-R13, I06-R7). */
  function adopt(
    entry: Entry,
    result: {
      connector: Connector | undefined;
      access: CredentialAccess;
      outcome: InitializeOutcome;
    },
  ): void {
    const { id, kind } = entry.summary;
    const ready = result.outcome.state === "ready" && result.connector !== undefined;
    if (entry.access && entry.access !== result.access) entry.access.revoke();
    if (!ready) result.access.revoke();
    entry.connector = ready ? result.connector : undefined;
    entry.access = ready ? result.access : undefined;
    entry.states = result.access.states();
    entry.summary = summaryOf(id, kind, result.outcome);
  }

  /**
   * A new object for an instance: presence, make, initialize and, for a ready one, health (I05-R13).
   * Its result is kept only while `turn` still waits (the slot's work is not cut when it does not);
   * a late one counts toward giving the instance up and its accessor is cut.
   */
  async function renew(
    entry: Entry,
    turn: RecheckTurn,
    rebuiltAt?: number,
  ): Promise<"kept" | "late"> {
    const { id } = entry.summary;
    // an object whose turn closed before the instance took it reads nothing, even while its initialize hangs (I06-R7)
    let adopted = false;
    const access = createCredentialAccess(entry.slots ?? [], secrets, () => adopted || turn.open);
    const { connector, outcome: opened } = await openConnector(
      id,
      entry.factory as ConnectorFactory,
      entry.config,
      access,
    );
    let outcome: InitializeOutcome = opened;
    if (opened.state === "ready" && connector !== undefined) {
      const health = await healthOf(connector);
      if (health === "rejected") {
        const reason = await access.judge();
        outcome = reason ? { state: "unavailable", reason } : unavailable;
      } else if (health === "down") {
        outcome = unavailable; // initialized but not healthy is unavailable, like a failed initialization
      }
    }
    if (!turn.open) {
      access.revoke(); // its turn stopped waiting: the result is dropped, the object left open
      entry.lateRechecks++;
      return "late";
    }
    entry.lateRechecks = 0;
    adopted = true;
    adopt(entry, { connector, access, outcome });
    if (entry.summary.state === "ready") {
      try {
        options.onReady?.(id);
      } catch {
        // the release is best effort; the hourly pass puts back what it missed
      }
    }
    // the gap of a rejected instance runs from the start of the rebuild that ended so; set before the slot frees
    entry.rejectedRebuildAt =
      rebuiltAt !== undefined && entry.summary.reason === "credential-rejected"
        ? rebuiltAt
        : undefined;
    return "kept";
  }

  /**
   * Puts `work` in the instance's one slot; the slot frees, and the owed rebuild runs, when it settles.
   * The slot frees before whoever awaits `work` goes on (this is the first to wait on it), so a caller's
   * next call finds it free.
   */
  function occupy(entry: Entry, work: Promise<unknown>): void {
    const mine: { done?: Promise<void> } = {};
    mine.done = (async () => {
      try {
        await work;
      } catch {
        // a bug in the work is not the slot's to report; the slot frees all the same
      } finally {
        if (entry.slot === mine.done) {
          entry.slot = undefined;
          runOwed(entry);
        }
      }
    })();
    entry.slot = mine.done;
  }

  const gapLeftMs = (entry: Entry): number =>
    entry.summary.reason === "credential-rejected" && entry.rejectedRebuildAt !== undefined
      ? Math.max(0, entry.rejectedRebuildAt + CREDENTIAL_RETRY_MIN_MS - clock.now())
      : 0;

  /** The rebuild a notice owes, once the slot is free and (for a rejected instance) the gap has passed. */
  function runOwed(entry: Entry): void {
    if (!entry.pending || entry.slot) return;
    if (entry.lateRechecks >= RECHECK_LATE_LIMIT) {
      entry.pending = false; // given up: a notice does not bring the instance back (I06-R12)
      return;
    }
    const left = gapLeftMs(entry);
    if (left > 0) {
      if (entry.gapTimer === undefined) {
        entry.gapTimer = setTimeout(() => {
          entry.gapTimer = undefined;
          runOwed(entry);
        }, left);
        entry.gapTimer.unref();
      }
      return;
    }
    entry.pending = false;
    void startRebuild(entry);
  }

  /** Makes a new object of an instance of any state and waits for it at most RECHECK_TIMEOUT_MS (I06-R12). */
  async function startRebuild(entry: Entry): Promise<void> {
    const turn: RecheckTurn = { open: true };
    const before = entry.connector;
    const work = renew(entry, turn, clock.now());
    occupy(entry, work);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      work.then(() => "settled" as const),
      new Promise<"timeout">(
        (resolve) => (timer = setTimeout(() => resolve("timeout"), RECHECK_TIMEOUT_MS)),
      ),
    ]);
    clearTimeout(timer);
    if (outcome === "timeout") {
      turn.open = false;
      entry.rejectedRebuildAt = undefined;
      // decided by the state now, not at the start: an old object that a stop already judged is not undone (I06-R12)
      if (before !== undefined && entry.connector === before && entry.summary.state === "ready") {
        // the old object's access would read a value never shown to work: it is not left ready (I06-R12)
        entry.access?.revoke();
        entry.connector = undefined;
        entry.access = undefined;
        entry.summary = summaryOf(entry.summary.id, entry.summary.kind, unavailable);
      }
      return;
    }
  }

  /** A refused `getChanges` of the instance's current object: its state is re-judged (I06-R9, R10). */
  async function judgeStop(entry: Entry, used: Connector): Promise<"judged" | "replaced"> {
    const access = entry.access;
    if (!access || entry.connector !== used) return "replaced";
    const reason = await access.judge();
    // another object took the instance while the store was asked: this stop is the old one's (I06-R10)
    if (entry.connector !== used) return "replaced";
    access.revoke();
    entry.states = access.states();
    entry.connector = undefined;
    entry.access = undefined;
    entry.rejectedRebuildAt = undefined;
    entry.summary = summaryOf(
      entry.summary.id,
      entry.summary.kind,
      reason ? { state: "unavailable", reason } : unavailable,
    );
    return "judged";
  }

  /** An instance as the list shows it, and as a change notice answers it (I06-R12, R13): the marks and the slots, never a value. */
  const listed = (entry: Entry): ConnectorSummary => {
    const { summary, slots, states } = entry;
    const shown = readRescanState(db, summary.id).deletionsMayBeMissed
      ? { ...summary, deletionsMayBeMissed: true }
      : { ...summary };
    return slots && slots.length > 0
      ? {
          ...shown,
          credentials: slots.map(({ slot, name }, i) => ({
            slot,
            name,
            state: states[i] ?? "unavailable",
          })),
        }
      : shown;
  };

  return {
    // the mark lives in the file, so a restart keeps it (I01-R17)
    list: () => entries.map(listed),
    configOf: (id) => find(id)?.config,
    async recheck(id, turn) {
      const entry = find(id);
      if (!entry) return undefined;
      if (entry.summary.state === "ready") return "ready";
      if (!entry.factory || !entry.slots) return entry.summary.state; // nothing to make, or a declaration that cannot be used
      // a refused value is not offered to the origin again by the clock (I06-R11), nor while the slot is taken
      if (entry.summary.reason === "credential-rejected" || entry.slot) return entry.summary.state;
      if (entry.lateRechecks >= RECHECK_LATE_LIMIT) {
        const { id: instanceId } = entry.summary;
        if (!entry.abandonedLogged) log("connector-recheck-abandoned", { id: instanceId });
        entry.abandonedLogged = true;
        return entry.summary.state;
      }
      const work = renew(entry, turn ?? { open: true });
      occupy(entry, work);
      return (await work) === "late" ? undefined : entry.summary.state;
    },
    async rebuild(id) {
      const entry = find(id);
      if (!entry) return undefined;
      const answer = (rebuild: RebuildAnswer["rebuild"]): RebuildAnswer => ({
        summary: listed(entry),
        rebuild,
      });
      if (!entry.factory || !entry.slots) return answer("skipped"); // nothing to make, or a declaration that cannot be used
      if (entry.lateRechecks >= RECHECK_LATE_LIMIT) {
        if (!entry.abandonedLogged) log("connector-recheck-abandoned", { id });
        entry.abandonedLogged = true;
        return answer("skipped"); // only a restart brings it back (I06-R12)
      }
      if (entry.slot || gapLeftMs(entry) > 0) {
        entry.pending = true;
        runOwed(entry); // sets the gap's timer when only the gap holds it
        return answer("queued");
      }
      await startRebuild(entry);
      return answer("done");
    },
    async sync(id, syncOptions = {}) {
      const entry = find(id);
      if (!entry) return { error: "not-found" };
      if (entry.summary.state !== "ready" || !entry.connector) {
        return { error: "connector-unavailable" };
      }
      const used = entry.connector;
      // the instance's lock is held through the judgement, so no second sync reaches the origin with the
      // refused value while the store is asked (I06-R10)
      const release = tryLockInstance(db, id);
      if (!release) return { connectorId: id, ...emptyResult(), stopped: "instance-busy" };
      let result: SyncResult;
      let replaced = false;
      try {
        result = await syncConnector(db, id, entry.summary.kind, used, {
          ...options,
          ...syncOptions,
          lockHeld: true,
        });
        // the state is judged before the answer returns, so the job that closes on it reads the new state (I06-R10)
        if (result.stopped === "credential-unusable") {
          replaced = (await judgeStop(entry, used)) === "replaced";
        }
      } finally {
        release();
      }
      const answer = { connectorId: id, ...result };
      if (replaced) markReplacedStop(answer);
      return answer;
    },
  };
}
