// The pipeline's notifications to the KnowledgeEngine and the VectorIndex
// (V02-R13, ARCHITECTURE 5.3 and 5.4, ADR 0013). Both are projections of the
// canonical store: a notice is built inside the transaction that changed a
// source (versionNotice, userDeleteWithNotice, acceptChange) with the change sequence that
// change reached, and delivered only after that transaction committed, one notice
// at a time in the order notified. A stored version is upserted into the engine
// (its text read from the store at delivery, so a version purged meanwhile is
// never handed over) and the versions it replaced are removed from both; a
// deletion removes every purged version from both. The vector index holds no
// vectors in Phase 1 (nothing upserts), so its removals keep its applied change
// sequence in step with the store.
// Missed notices are found at start (reconcile): a projection whose applied
// sequence differs from the store's, null included, is rebuilt, whatever its
// kind; an equal one is left alone. A delivery that fails marks the projection
// stale (in the process and in a setting) and it gets no more notices until a
// rebuild, so a later notice cannot advance its applied sequence past the one it
// missed. AdapterUnavailableError (the empty vector index) marks it stale the
// same way but is no error; its rebuild being unavailable too, it is skipped at
// no cost.
import {
  AdapterUnavailableError,
  type EmbeddingSpace,
  type EngineSourceInput,
  type IndexedRef,
  type KnowledgeEngine,
  type VectorIndex,
} from "@pki/contracts";
import {
  canonicalTransaction,
  findSourceId,
  readChangeSeq,
  readSetting,
  readSourceVersion,
  writeSetting,
  type SqlDriver,
} from "@pki/storage";
import { applyTombstone } from "./tombstone-entry.ts";

/** What one committed change tells the projections. */
export type ProjectionNotice =
  | {
      kind: "version";
      sourceId: number;
      /** The stored version: the source's latest when the notice was built. */
      version: number;
      versionId: number;
      /** The source's lower versions' row IDs, past evidence now. */
      replacedVersionIds: number[];
      changeSeq: number;
    }
  | {
      kind: "removed";
      sourceId: number;
      /** The tombstone's version, covering every version. */
      version: number;
      /** Every purged version's row ID, collected before the purge. */
      versionIds: number[];
      changeSeq: number;
    };

export type ProjectionName = "engine" | "vectorIndex";

/** A projection's stale mark: "1" from a failed delivery until a rebuild writes "0". */
export const PROJECTION_STALE_SETTINGS: Readonly<Record<ProjectionName, string>> = Object.freeze({
  engine: "projections.engine-stale",
  vectorIndex: "projections.vector-index-stale",
});

/**
 * Provisional (X01 decides when vectors are written): a vector's canonical ID is
 * its source version row's. Version row IDs are never reused (AUTOINCREMENT,
 * V02 "T02가 넘기는 것" 1), unlike item, fact and relation IDs after a purge.
 */
export const vectorRefOf = (versionId: number): IndexedRef => `source-version:${versionId}`;

const idsOf = (rows: Record<string, unknown>[]) => rows.map((r) => r.id as number);

/** Call inside the transaction that stored `version` of the source, right after storing it. */
export function versionNotice(db: SqlDriver, sourceId: number, version: number): ProjectionNotice {
  const versionId = db.all("SELECT id FROM source_versions WHERE source_id = ? AND version = ?", [
    sourceId,
    version,
  ])[0]?.id as number;
  return {
    kind: "version",
    sourceId,
    version,
    versionId,
    replacedVersionIds: idsOf(
      db.all(
        "SELECT id FROM source_versions WHERE source_id = ? AND version < ? ORDER BY version",
        [sourceId, version],
      ),
    ),
    changeSeq: readChangeSeq(db),
  };
}

/**
 * The user's deletion (V02-R12, I04-R9): applyTombstone with reason `user-deleted`
 * and no revision, in one canonical transaction. `deleted` is any outcome that
 * changed the tombstone (a purged source can be re-marked by the user over a
 * source's reason or after a lift); the notice is there only when versions were
 * purged, so a delete of nothing stored does not wake the engine.
 */
export function userDeleteWithNotice(
  db: SqlDriver,
  identity: { connectorInstanceId: string; namespace: string; externalId: string },
  at: string,
): { outcome: "deleted" | "unchanged"; notice?: ProjectionNotice } {
  return canonicalTransaction(db, (tx) => {
    const { connectorInstanceId, namespace, externalId } = identity;
    const sourceId = findSourceId(tx, connectorInstanceId, namespace, externalId);
    const versionIds =
      sourceId === undefined
        ? []
        : idsOf(
            tx.all("SELECT id FROM source_versions WHERE source_id = ? ORDER BY version", [
              sourceId,
            ]),
          );
    const result = applyTombstone(tx, {
      identity,
      reason: "user-deleted",
      lastRevision: null,
      at,
    });
    if (result.outcome === "unchanged") return { outcome: "unchanged" };
    if (versionIds.length === 0) return { outcome: "deleted" };
    return {
      outcome: "deleted",
      notice: {
        kind: "removed",
        sourceId: result.sourceId,
        version: result.coversVersion,
        versionIds,
        changeSeq: readChangeSeq(tx),
      },
    };
  });
}

export type ReconcileOutcome = "current" | "rebuilt" | "skipped" | "failed";

export interface ProjectionsOptions {
  db: SqlDriver;
  engine: KnowledgeEngine;
  vectorIndex: VectorIndex;
  /** The space a vector index rebuild resets to (the embedder's model); null skips it. */
  embeddingSpace: () => EmbeddingSpace | null;
  /** A failed delivery or rebuild; the error may carry engine text, so log its class only. */
  onError?: (projection: ProjectionName, error: unknown) => void;
}

export interface Projections {
  /** Delivers after everything notified before; resolves once delivered (failures are reported, not thrown). */
  notify(notices: readonly ProjectionNotice[]): Promise<void>;
  /** The start-up comparison and rebuild, queued like a notice. */
  reconcile(): Promise<Record<ProjectionName, ReconcileOutcome>>;
  /** Resolves once everything queued so far is delivered. */
  drain(): Promise<void>;
  /** True from a missed notice (failed or unavailable) until a rebuild: it may hold purged content. */
  isStale(name: ProjectionName): boolean;
}

/** The latest version of every source with one (a purged source has none). */
async function* latestSources(db: SqlDriver): AsyncGenerator<EngineSourceInput> {
  const rows = db.all(
    `SELECT v.id, v.source_id, v.version FROM source_versions v
      WHERE v.version = (SELECT max(version) FROM source_versions WHERE source_id = v.source_id)
      ORDER BY v.source_id`,
  );
  for (const row of rows) {
    const stored = readSourceVersion(db, row.id as number);
    if (!stored) continue; // purged since the list was read
    yield {
      ref: { sourceId: String(row.source_id), version: row.version as number },
      title: stored.title,
      body: stored.body,
    };
  }
}

export function createProjections(options: ProjectionsOptions): Projections {
  const { db, engine, vectorIndex } = options;
  const stale: Record<ProjectionName, boolean> = { engine: false, vectorIndex: false };
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  };

  /**
   * Stops notifying the projection until a rebuild and records it for the next
   * start. An unavailable projection is stale too, without an error: a later
   * notice it did take would move its applied sequence past the one it missed.
   */
  const markStale = (name: ProjectionName, error: unknown) => {
    stale[name] = true;
    if (!(error instanceof AdapterUnavailableError)) options.onError?.(name, error);
    try {
      writeSetting(db, PROJECTION_STALE_SETTINGS[name], "1");
    } catch (writeError) {
      options.onError?.(name, writeError);
    }
  };

  /** Runs one projection's calls unless it is stale; a failure or unavailability marks it stale. */
  async function deliver(name: ProjectionName, calls: () => Promise<void>) {
    if (stale[name]) return;
    try {
      await calls();
    } catch (error) {
      markStale(name, error);
    }
  }

  async function deliverOne(notice: ProjectionNotice) {
    const sourceId = String(notice.sourceId);
    const fence = { version: notice.version };
    const seq = notice.changeSeq;
    if (notice.kind === "version") {
      await deliver("engine", async () => {
        const stored = readSourceVersion(db, notice.versionId);
        // purged after the commit: its removal notice follows, nothing to hand over
        if (stored) {
          const ref = { sourceId, version: notice.version };
          await engine.upsertSource({ ref, title: stored.title, body: stored.body }, fence, seq);
        }
        if (notice.version > 1) {
          await engine.removeSource({ sourceId, version: notice.version - 1 }, fence, seq);
        }
      });
      await deliver("vectorIndex", () =>
        vectorIndex.remove(notice.replacedVersionIds.map(vectorRefOf), seq),
      );
    } else {
      await deliver("engine", () =>
        engine.removeSource({ sourceId, version: notice.version }, fence, seq),
      );
      await deliver("vectorIndex", () =>
        vectorIndex.remove(notice.versionIds.map(vectorRefOf), seq),
      );
    }
  }

  async function reconcileOne(
    name: ProjectionName,
    applied: () => Promise<number | null>,
    rebuild: (seq: number) => Promise<void>,
  ): Promise<ReconcileOutcome> {
    try {
      const seq = readChangeSeq(db);
      const marked = stale[name] || readSetting(db, PROJECTION_STALE_SETTINGS[name]) === "1";
      if (!marked && (await applied()) === seq) return "current";
      await rebuild(seq);
      stale[name] = false;
      if (marked) writeSetting(db, PROJECTION_STALE_SETTINGS[name], "0");
      return "rebuilt";
    } catch (error) {
      markStale(name, error);
      return error instanceof AdapterUnavailableError ? "skipped" : "failed";
    }
  }

  return {
    notify: (notices) =>
      enqueue(async () => {
        for (const notice of notices) await deliverOne(notice);
      }),
    reconcile: () =>
      enqueue(async () => ({
        engine: await reconcileOne(
          "engine",
          () => engine.appliedChangeSeq(),
          (seq) => engine.rebuild(latestSources(db), seq),
        ),
        vectorIndex: await reconcileOne(
          "vectorIndex",
          () => vectorIndex.appliedChangeSeq(),
          async (seq) => {
            const space = options.embeddingSpace();
            if (!space) throw new AdapterUnavailableError("no embedding space bound");
            // Phase 1 writes no vectors (X01), so the rebuilt index is empty; an
            // empty removal records the sequence it was rebuilt at.
            await vectorIndex.reset(space);
            await vectorIndex.remove([], seq);
          },
        ),
      })),
    drain: () => enqueue(async () => undefined),
    isStale: (name) => stale[name],
  };
}
