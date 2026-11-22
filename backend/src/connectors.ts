// Connector management (ARCHITECTURE 5.5): initializes the configured instances
// once, and syncs one by calling getChanges until it has no more pages. Each page,
// the extraction job of each new version (V02-R4) and the cursor after it are
// written in one transaction, so the stored cursor never runs ahead of the stored
// records (ADR 0013 decision 1) and no version is stored without its job. The
// change sequence rises in the same transaction (storage trigger), and so does a
// new version's propagation to the knowledge its previous versions supported (V02-R11).
// Each change is judged and stored by the knowledge-engine's acceptChange
// (I01-R8 to R12): an upsert by revision order, a delete or access-revoked change
// through the tombstone entry in the page's canonical transaction, a scope change
// on the source row. Each stored version becomes a notice to the KnowledgeEngine and VectorIndex,
// built in the page's transaction with the change sequence it reached and
// delivered after the commit, before the runner is woken (V02-R13). A deletion is no notice: the
// tombstone's transaction registers the projections' removal jobs (I04-R12) and the runner is woken. A Connector
// of another SDK version than CONNECTOR_SDK_VERSION is never initialized (I01-R1).
import {
  ChangeSetSchema,
  CONNECTOR_SDK_VERSION,
  ConnectorNotImplementedError,
  type Change,
  type Connector,
  type ConnectorSummary,
  type ErrorResponse,
  type SyncResponse,
} from "@pki/contracts";
import {
  defaultEntries,
  versionNotice,
  type CanonicalEntries,
  type ProjectionNotice,
  type Projections,
} from "@pki/knowledge-engine";
import {
  canonicalTransaction,
  readCursor,
  registerConnectorInstance,
  registerJob,
  writeCursor,
  type CanonicalTx,
  type SqlDriver,
} from "@pki/storage";
import { systemClock, type Clock } from "./clock.ts";
import type { JobRunner } from "./job-runner.ts";

const PAGE_LIMIT = 100;

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

export interface SyncOptions {
  signal?: AbortSignal;
  /** Read from the start, not from the stored cursor (an import reads its whole text). */
  rescan?: boolean;
  /**
   * Takes each refused change once its page is committed, and the page goes on.
   * Without it a refusal fails the page, of which nothing is stored, except a
   * `tombstoned` one: that change is skipped and the page commits either way.
   */
  onRefused?: (change: Change, reason: RefusalReason) => void;
  /** Takes each stored, unchanged or deleting change once its page is committed. */
  onStored?: (change: Change, outcome: StoredOutcome) => void;
  /** Woken after a page that registered jobs commits (V02-T05 binds the runner). */
  runner?: Pick<JobRunner, "wake">;
  /** Notified after each page commits, of its stored versions and deletions (V02-R13). */
  projections?: Pick<Projections, "notify">;
  /** Gives a registered job its time, the runner's clock (I03-T04); default systemClock. */
  clock?: Pick<Clock, "now">;
  /**
   * The entries that run the derivative registry (composition.ts `productEntries`); default the
   * entries over the registry with no composition (knowledge-engine entries.ts).
   */
  entries?: Pick<CanonicalEntries, "acceptChange" | "propagateNewVersion">;
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
  ): Promise<
    SyncResponse | { error: Extract<ErrorResponse["error"], "not-found" | "connector-unavailable"> }
  >;
}

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
  entries: Pick<CanonicalEntries, "acceptChange" | "propagateNewVersion">,
): StoredOutcome | { refused: RefusalReason } {
  const saved = entries.acceptChange(tx, instanceId, change, new Date(clock.now()).toISOString());
  if (saved.outcome === "blocked") return { refused: "tombstoned" };
  if (saved.outcome === "rejected") return { refused: "revision-not-newer" };
  if (saved.outcome === "tombstoned") return "deleted";
  if (saved.outcome !== "created") return saved.outcome;
  entries.propagateNewVersion(tx, saved.sourceId);
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

export async function syncConnector(
  db: SqlDriver,
  instanceId: string,
  kind: string,
  connector: Connector,
  options: SyncOptions = {},
): Promise<{ received: number; created: number }> {
  const signal = options.signal ?? new AbortController().signal;
  const entries = options.entries ?? defaultEntries;
  db.transaction(() => registerConnectorInstance(db, instanceId, kind));
  let cursor = options.rescan ? null : readCursor(db, instanceId);
  let received = 0;
  let created = 0;
  // One full rescan per sync: a second expiry, or a page that promises more without
  // moving, would otherwise loop forever.
  let rescanned = false;
  for (;;) {
    const page = ChangeSetSchema.parse(
      await connector.getChanges(cursor, { limit: PAGE_LIMIT, signal }),
    );
    if (page.cursorExpired) {
      if (rescanned || cursor === null) {
        throw new Error(`${instanceId}: cursor expired on a full rescan`);
      }
      rescanned = true;
      cursor = null;
      continue;
    }
    if (page.hasMore && page.nextCursor === cursor) {
      throw new Error(`${instanceId}: page reports more changes without progress`);
    }
    const refused: [Change, RefusalReason][] = [];
    const stored: [Change, StoredOutcome][] = [];
    const notices: ProjectionNotice[] = [];
    const pageCreated = canonicalTransaction(db, (tx) => {
      let n = 0;
      for (const change of page.changes) {
        const outcome = storeChange(
          tx,
          instanceId,
          change,
          notices,
          options.clock ?? systemClock,
          entries,
        );
        if (typeof outcome === "object") {
          // A deleted source's upsert is skipped, never a page failure: the
          // tombstone refuses it every time, so failing would stall the cursor and
          // lose the page's other changes for good (V02-R12, review A-M1).
          if (!options.onRefused && outcome.refused !== "tombstoned") {
            throw new Error(`${instanceId}: ${change.kind} change refused (${outcome.refused})`);
          }
          refused.push([change, outcome.refused]);
        } else {
          if (outcome === "created") n++;
          stored.push([change, outcome]);
        }
      }
      writeCursor(tx, instanceId, page.nextCursor);
      return n;
    });
    for (const [change, reason] of refused) options.onRefused?.(change, reason);
    for (const [change, outcome] of stored) options.onStored?.(change, outcome);
    // A failed page threw above: the notices its changes built are never delivered. The runner is woken once the
    // engine has the page's versions, so a proposing engine knows what is extracted.
    const delivered = notices.length > 0 ? options.projections?.notify(notices) : undefined;
    // a deletion registered the projections' removal jobs: the runner takes them too, after the notices
    const deleted = stored.some(([, outcome]) => outcome === "deleted");
    if (pageCreated > 0 || deleted) {
      const runner = options.runner;
      if (delivered) void delivered.then(() => runner?.wake());
      else void runner?.wake();
    }
    created += pageCreated;
    received += page.changes.length;
    cursor = page.nextCursor;
    if (!page.hasMore) return { received, created };
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
  options: Pick<SyncOptions, "runner" | "projections" | "clock" | "entries"> = {},
): Promise<ConnectorManager> {
  const entries = await Promise.all(
    instances.map(async ({ id, kind, config }) => {
      const factory = Object.hasOwn(kinds, kind) ? kinds[kind] : undefined;
      if (!factory) throw new Error(`unknown connector kind: ${kind}`);
      const connector = factory();
      const outcome = await initializeConnector(connector, config);
      const summary: ConnectorSummary =
        "reason" in outcome
          ? { id, kind, state: outcome.state, reason: outcome.reason }
          : { id, kind, state: outcome.state };
      return { summary, connector };
    }),
  );
  return {
    list: () => entries.map(({ summary }) => ({ ...summary })),
    async sync(id) {
      const entry = entries.find((e) => e.summary.id === id);
      if (!entry) return { error: "not-found" };
      if (entry.summary.state !== "ready") return { error: "connector-unavailable" };
      return {
        connectorId: id,
        ...(await syncConnector(db, id, entry.summary.kind, entry.connector, options)),
      };
    },
  };
}
