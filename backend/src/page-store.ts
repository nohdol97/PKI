// The page store (I01-R14, R16, R24): what both ways of getting changes into the product share, the sync
// of a Connector (connectors.ts) and the local import API (imports.ts). Each change of a page is judged
// apart (I01-R14): a record that fails its schema, its capability declaration or its block rules, or
// arrives at a tombstone's door, with the same revision and other content, or as a revoke whose
// content is not the stored one, is refused alone and the page goes on. What is stored is judged by
// the knowledge-engine's acceptChange (I01-R8 to R12). The page, the extraction job of each new
// version (V02-R4) and the cursor after it are written in one transaction. Each stored version
// becomes a notice to the KnowledgeEngine and VectorIndex, built in the page's transaction with the
// change sequence it reached and delivered after the commit, before the runner is woken (V02-R13).
// A deletion is no notice: the tombstone's transaction registers the projections' removal jobs
// (I04-R12) and the runner is woken after the page's notices.
import {
  blocksValid,
  ChangeSchema,
  rejectedPositionValid,
  type Change,
  type ConnectorCapabilities,
  type RejectCode,
  type SyncResponse,
} from "@pki/contracts";
import { expectedContent, JSONL_IMPORT_KIND, placeOf } from "@pki/connector-sdk";
import {
  defaultEntries,
  versionNotice,
  type CanonicalEntries,
  type ProjectionNotice,
  type Projections,
} from "@pki/knowledge-engine";
import {
  canonicalTransaction,
  contentHash,
  finishRescan,
  findSourceId,
  readConnectorKind,
  readLatestContentHash,
  registerJob,
  writeCursor,
  type CanonicalTx,
  type SqlDriver,
} from "@pki/storage";
import { systemClock, type Clock } from "./clock.ts";
import { tryLockInstance } from "./instance-lock.ts";
import type { JobRunner } from "./job-runner.ts";

/** Provisional: refused records listed in a result; `rejectedCount` counts them all. */
export const REJECTED_LIST_LIMIT = 100;

/** The job each new source version gets; its handler is V02-T05's. */
export const EXTRACT_JOB_KIND = "extract";

/**
 * A change the store would not take; nothing of it is written. `revision-not-newer`
 * is the same revision with other content (I01-R10 step 2); `tombstoned` is the
 * door of a tombstone (step 0); `scope-change-content-mismatch` is a JSONL `revoke`
 * line whose content is not the stored latest version's (I01-R22).
 */
export type RefusalReason = "revision-not-newer" | "tombstoned" | "scope-change-content-mismatch";

/**
 * What a change did: a new version, a new scope, its source tombstoned, or nothing
 * new (`unchanged`; `stale` for an older revision, `stale-tombstone` for a delete
 * below the revision the store holds: neither is an error, I01-R10, R11).
 */
export type StoredOutcome =
  "created" | "unchanged" | "deleted" | "scope-updated" | "stale" | "stale-tombstone";

/** What one sync did; the API adds the instance's id (SyncResponse). */
export type SyncResult = Omit<SyncResponse, "connectorId">;

/** What a page store reports to and asks of its caller; a sync's options are these and more. */
export interface PageOptions {
  /** Takes each change refused at a tombstone's door or for revision conflict, once its page is committed. */
  onRefused?: (change: Change, reason: RefusalReason) => void;
  /** Takes each stored, unchanged or deleting change once its page is committed. */
  onStored?: (change: Change, outcome: StoredOutcome) => void;
  /** Takes the error that failed a page's storage; its text may carry file text: log its class only. */
  onError?: (error: unknown) => void;
  /** Woken after a page that registered jobs commits (V02-T05 binds the runner). */
  runner?: Pick<JobRunner, "wake">;
  /**
   * Notified after each page commits, of its stored versions only (V02-R13). A deletion is no
   * notice: its tombstone's transaction registers `projection-remove` jobs (I04-R12).
   */
  projections?: Pick<Projections, "notify">;
  /** Gives a registered job its time and waits between tries, the runner's clock (I03-T04); default systemClock. */
  clock?: Pick<Clock, "now" | "sleep">;
  /**
   * The entries that run the derivative registry (composition.ts `productEntries`); default the
   * entries over the registry with no composition (knowledge-engine entries.ts).
   */
  entries?: Pick<CanonicalEntries, "acceptChange" | "propagateNewVersion">;
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
  | "revision-conflict"
  /** a scope change that saw other content than the stored latest version's */
  | "content-mismatch";

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
  scopeClaimed: boolean,
): Judged {
  const at = new Date(clock.now()).toISOString();
  // the scope of an imported source is the user's own claim (I01-R15)
  const saved = scopeClaimed
    ? entries.acceptChange(tx, instanceId, change, at, { scopeClaimed })
    : entries.acceptChange(tx, instanceId, change, at);
  if (saved.outcome === "blocked") return "blocked";
  if (saved.outcome === "rejected") return "revision-conflict";
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

/** A result with nothing in it, for a caller that adds pages to it (`addPage`). */
export const emptyResult = (): SyncResult => ({
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

/** What one stored page came to; `addPage` adds it to a running result. */
export type PageResult = Pick<
  SyncResult,
  | "received"
  | "created"
  | "unchanged"
  | "scopeUpdated"
  | "stale"
  | "staleTombstone"
  | "blocked"
  | "tombstoned"
> & { rejected: { at: string; code: RejectCode }[] };

/** A page of changes to judge and store: from a Connector's read, or from an import's text. */
export interface PageInput {
  /** As read: each is judged apart (I01-R14), so a bad one refuses itself. */
  changes: readonly unknown[];
  /** What the source of the page refused itself, by place and code. */
  rejected: readonly { at: string; code: RejectCode }[];
  /** Written with the page; null writes none (an import has no cursor). */
  nextCursor: string | null;
  /** The page ends a rescan in progress: the rescan's end is written with it (I01-R17). */
  endsRescan: boolean;
}

export interface PageTarget {
  db: SqlDriver;
  instanceId: string;
  kind: string;
  capabilities: ConnectorCapabilities;
  options: PageOptions;
}

/**
 * The one page store (I01-R14, R16, R24): the sync of a Connector and the import API both
 * judge each change apart (schema, capabilities, block ranges, then the store's own rules)
 * and store the page, its extraction jobs and its cursor in one transaction, then report
 * what became of each change, notify the projections of the new versions and wake the
 * runner. The caller holds the instance's lock. A failing transaction stores nothing of
 * the page, wakes nothing and answers `storage-failed` (its error goes to `onError`).
 */
export function storePage(
  target: PageTarget,
  page: PageInput,
): PageResult | { stopped: "storage-failed" | "instance-busy" } {
  const { db, instanceId, kind, capabilities, options } = target;
  const entries = options.entries ?? defaultEntries;
  const clock = options.clock ?? systemClock;
  const scopeClaimed = kind === JSONL_IMPORT_KIND;
  const refused: [Change, RefusalReason][] = [];
  const stored: [Change, StoredOutcome][] = [];
  const rejected: { at: string; code: RejectCode }[] = [];
  const counts = emptyResult();
  const notices: ProjectionNotice[] = [];
  // what the source refused itself: its position is kept only in the short shape
  page.rejected.forEach(({ at, code }, i) => {
    rejected.push({ at: rejectedPositionValid(at) ? at : `change:${i}`, code });
  });
  const judged: { i: number; change: Change; seen: ReturnType<typeof expectedContent> }[] = [];
  // a refusal is placed by the line a change came from, else by its place in the page
  const place = (i: number) => placeOf(page.changes[i] as object) ?? `change:${i}`;
  page.changes.forEach((raw, i) => {
    const parsed = ChangeSchema.safeParse(raw);
    const refuse = (code: RejectCode) => rejected.push({ at: place(i), code });
    if (!parsed.success) return refuse("schema");
    const change = parsed.data;
    if (violatesCapabilities(change, capabilities)) return refuse("capability-violation");
    if (change.kind === "upsert" && !blocksValid(change.record.body, change.record.blocks ?? [])) {
      return refuse("invalid-blocks");
    }
    judged.push({ i, change, seen: expectedContent(raw as object) });
  });

  // the locks of other instances this page writes into (an import's old identity), held until the
  // page is committed or has failed; a lock that is taken fails the page whole and stores nothing
  const extraLocks: (() => void)[] = [];
  const lockedHere = new Set<string>(); // the lock is not re-entrant: each instance once per page
  const lockLegacy = (other: string) => {
    if (lockedHere.has(other)) return;
    lockedHere.add(other);
    const release = tryLockInstance(db, other);
    if (!release) throw new InstanceBusyAcrossError();
    extraLocks.push(release);
  };
  let pageCreated: number;
  try {
    pageCreated = canonicalTransaction(db, (tx) => {
      let created = 0;
      for (const { i, change, seen } of judged) {
        if (scopeClaimed && change.kind === "scope-change" && !seen) {
          // an import's scope change that lost its note cannot be checked: refused, never stored unchecked
          rejected.push({ at: place(i), code: "schema" });
          continue;
        }
        const at = scopeClaimed
          ? resolveImported(tx, instanceId, change, lockLegacy)
          : { instanceId, change };
        const outcome =
          seen &&
          at.change.kind === "scope-change" &&
          contentMismatch(tx, at.instanceId, at.change, seen)
            ? "content-mismatch"
            : storeChange(tx, at.instanceId, at.change, notices, clock, entries, scopeClaimed);
        if (outcome === "blocked") {
          counts.blocked++;
          refused.push([change, "tombstoned"]);
        } else if (outcome === "revision-conflict") {
          rejected.push({ at: place(i), code: "revision-conflict" });
          refused.push([change, "revision-not-newer"]);
        } else if (outcome === "content-mismatch") {
          rejected.push({ at: place(i), code: "scope-change-content-mismatch" });
          refused.push([change, "scope-change-content-mismatch"]);
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
      if (page.nextCursor !== null) writeCursor(tx, instanceId, page.nextCursor);
      // the page that ends a rescan ends it in the same transaction
      if (page.endsRescan) finishRescan(tx, instanceId, !capabilities.deletionsOnRescan);
      return created;
    });
  } catch (error) {
    for (const release of extraLocks) release();
    if (error instanceof InstanceBusyAcrossError) return { stopped: "instance-busy" };
    // nothing of this page was stored, and none of its text reaches the result (I01-R4)
    options.onError?.(error);
    return { stopped: "storage-failed" };
  }
  for (const release of extraLocks) release();
  for (const [change, reason] of refused) options.onRefused?.(change, reason);
  for (const [change, outcome] of stored) options.onStored?.(change, outcome);
  // The runner is woken once the engine has the page's versions, so a proposing
  // engine knows what is extracted.
  const delivered = notices.length > 0 ? options.projections?.notify(notices) : undefined;
  // a deletion registered the projections' removal jobs: the runner takes them too, after the notices
  const deleted = stored.some(([, outcome]) => outcome === "deleted");
  if (pageCreated > 0 || deleted) {
    const runner = options.runner;
    if (delivered) void delivered.then(() => runner?.wake());
    else void runner?.wake();
  }
  return { ...counts, received: page.changes.length, created: pageCreated, rejected };
}

/** Adds a stored page to a running result; its `rejected` list is capped, its count is not. */
export function addPage(result: SyncResult, page: PageResult): void {
  result.received += page.received;
  result.created += page.created;
  for (const key of [
    "unchanged",
    "scopeUpdated",
    "stale",
    "staleTombstone",
    "blocked",
    "tombstoned",
  ] as const) {
    result[key] += page[key];
  }
  result.rejectedCount += page.rejected.length;
  for (const entry of page.rejected) {
    if (result.rejected.length < REJECTED_LIST_LIMIT) result.rejected.push(entry);
  }
}

/** An import's old identity is in an instance that is busy: the page is not stored (I01-R21). */
class InstanceBusyAcrossError extends Error {}

/**
 * The V02 screen route once stored imported sources under another identity: the line's
 * `connector_instance_id` as the instance and namespace "". Now every route resolves a line as
 * (instance, namespace = the line's `connector_instance_id`, external id) (I01-R22), and a source or
 * a tombstone under the old identity, found by the line's `connector_instance_id` whichever instance
 * the import names, is the same source: the change is judged against it, so a deleted source stays
 * fenced and a stored one is updated in place, not duplicated. No data is moved. The lookup runs for
 * imported sources only and only in this direction: no route writes namespace "" any more. When the
 * line's own identity already exists it is the one judged.
 */
function resolveImported(
  tx: CanonicalTx,
  instanceId: string,
  change: Change,
  lockLegacy: (instanceId: string) => void,
): { instanceId: string; change: Change } {
  const namespace = change.kind === "upsert" ? change.record.namespace : change.namespace;
  const externalId = change.kind === "upsert" ? change.record.externalId : change.externalId;
  if (namespace === "") return { instanceId, change };
  if (findSourceId(tx, instanceId, namespace, externalId) !== undefined) {
    return { instanceId, change };
  }
  // Invariant: an import never reads, writes, tombstones or purges a source whose instance is not
  // `jsonl-import`. The text names the instance (untrusted), and a site Connector's sources are in
  // namespace "" too, so the old identity is taken only from an instance of the import kind.
  if (readConnectorKind(tx, namespace) !== JSONL_IMPORT_KIND) return { instanceId, change };
  // the old identity is the line's `connector_instance_id`, which the namespace carries
  if (findSourceId(tx, namespace, "", externalId) === undefined) return { instanceId, change };
  // the write goes into that instance, so its lock is held for the page (I01-R21)
  if (namespace !== instanceId) lockLegacy(namespace);
  return {
    instanceId: namespace,
    change:
      change.kind === "upsert"
        ? { ...change, record: { ...change.record, namespace: "" } }
        : { ...change, namespace: "" },
  };
}

/**
 * A JSONL `revoke` line says "the content is as before, the scope narrows" (I01-R22): true
 * only while it is the stored latest version's content. A source without a version is
 * left to the store (`stale`).
 */
function contentMismatch(
  tx: CanonicalTx,
  instanceId: string,
  change: Extract<Change, { kind: "scope-change" }>,
  seen: { title: string; body: string },
): boolean {
  const sourceId = findSourceId(tx, instanceId, change.namespace, change.externalId);
  const latest = sourceId === undefined ? undefined : readLatestContentHash(tx, sourceId);
  return latest !== undefined && latest !== contentHash(seen.title, seen.body);
}
