// Connector management (ARCHITECTURE 5.5): initializes the configured instances
// once, and syncs one by calling getChanges until it has no more pages. Each page,
// the extraction job of each new version (V02-R4) and the cursor after it are
// written in one transaction, so the stored cursor never runs ahead of the stored
// records (ADR 0013 decision 1) and no version is stored without its job. The
// change sequence rises in the same transaction (storage trigger), and so does a
// new version's propagation to the knowledge its previous versions supported (V02-R11).
// A delete or access-revoked change tombstones and purges its source in the
// page's transaction (V02-R12, knowledge-engine deletion.ts). Each stored version
// and each deletion becomes a notice to the KnowledgeEngine and VectorIndex,
// built in the page's transaction with the change sequence it reached and
// delivered after the commit, before the runner is woken (V02-R13).
import {
  ChangeSetSchema,
  ConnectorNotImplementedError,
  type Change,
  type Connector,
  type ConnectorSummary,
  type ErrorResponse,
  type SyncResponse,
} from "@pki/contracts";
import {
  deleteSourceWithNotice,
  propagateNewVersion,
  versionNotice,
  type ProjectionNotice,
  type Projections,
} from "@pki/knowledge-engine";
import {
  findSourceId,
  readCursor,
  registerConnectorInstance,
  registerJob,
  saveSourceRecord,
  writeCursor,
  type SqlDriver,
} from "@pki/storage";
import type { JobRunner } from "./job-runner.ts";

const PAGE_LIMIT = 100;

/** The job each new source version gets; its handler is V02-T05's. */
export const EXTRACT_JOB_KIND = "extract";

/** A change the store would not take; nothing of it is written. */
export type RefusalReason = "revision-not-newer" | "tombstoned";

/** What a change did: a new version, nothing new, or its source tombstoned and purged. */
export type StoredOutcome = "created" | "unchanged" | "deleted";

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
 * delete or access-revoked change tombstones every product version of its source
 * and purges them (V02-R12); its `version` is the record's revision and orders
 * nothing yet (provisional until I01's revision rule), and its `at` is not stored:
 * the tombstone takes the product's clock, so no Connector text reaches it. A
 * source never stored, or purged already, is left as it is ("unchanged").
 */
function storeChange(
  db: SqlDriver,
  instanceId: string,
  change: Change,
  notices: ProjectionNotice[],
): StoredOutcome | { refused: RefusalReason } {
  if (change.kind !== "upsert") {
    const sourceId = findSourceId(db, instanceId, change.externalId);
    if (sourceId === undefined) return "unchanged";
    const reason = change.kind === "delete" ? "source-deleted" : "access-revoked";
    const { notice } = deleteSourceWithNotice(db, sourceId, {
      reason,
      at: new Date().toISOString(),
    });
    if (!notice) return "unchanged";
    notices.push(notice);
    return "deleted";
  }
  const saved = saveSourceRecord(db, instanceId, change.record);
  if (saved.status === "refused") return { refused: saved.reason };
  if (saved.status === "unchanged") return "unchanged";
  propagateNewVersion(db, saved.sourceId);
  notices.push(versionNotice(db, saved.sourceId, saved.version));
  const job = registerJob(db, {
    kind: EXTRACT_JOB_KIND,
    sourceId: saved.sourceId,
    fenceVersion: saved.version,
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
    const pageCreated = db.transaction(() => {
      let n = 0;
      for (const change of page.changes) {
        const outcome = storeChange(db, instanceId, change, notices);
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
      writeCursor(db, instanceId, page.nextCursor);
      return n;
    });
    for (const [change, reason] of refused) options.onRefused?.(change, reason);
    for (const [change, outcome] of stored) options.onStored?.(change, outcome);
    // A failed page threw above: the notices its changes built are never delivered. The runner is woken once the
    // engine has the page's versions, so a proposing engine knows what is extracted.
    const delivered = notices.length > 0 ? options.projections?.notify(notices) : undefined;
    if (pageCreated > 0) {
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

export async function createConnectorManager(
  db: SqlDriver,
  instances: readonly ConnectorInstanceConfig[],
  kinds: Readonly<Record<string, ConnectorFactory>>,
  options: Pick<SyncOptions, "runner" | "projections"> = {},
): Promise<ConnectorManager> {
  const entries = await Promise.all(
    instances.map(async ({ id, kind, config }) => {
      const factory = Object.hasOwn(kinds, kind) ? kinds[kind] : undefined;
      if (!factory) throw new Error(`unknown connector kind: ${kind}`);
      const connector = factory();
      try {
        await connector.initialize(config);
        return { id, kind, state: "ready" as const, connector };
      } catch (error) {
        const state: ConnectorSummary["state"] =
          error instanceof ConnectorNotImplementedError ? "not-implemented" : "unavailable";
        return { id, kind, state, connector };
      }
    }),
  );
  return {
    list: () => entries.map(({ id, kind, state }) => ({ id, kind, state })),
    async sync(id) {
      const entry = entries.find((e) => e.id === id);
      if (!entry) return { error: "not-found" };
      if (entry.state !== "ready") return { error: "connector-unavailable" };
      return {
        connectorId: id,
        ...(await syncConnector(db, id, entry.kind, entry.connector, options)),
      };
    },
  };
}
