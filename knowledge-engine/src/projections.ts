// The pipeline's notifications to the KnowledgeEngine and the VectorIndex
// (V02-R13, ARCHITECTURE 5.3 and 5.4, ADR 0013). Both are projections of the
// canonical store: a notice is built inside the transaction that stored a
// version (versionNotice) with the change sequence that change reached, and
// delivered only after that transaction committed, one notice at a time in the
// order notified. A stored version is upserted into the engine (its text read
// from the store at delivery, so a version purged meanwhile is never handed
// over) and the versions it replaced are removed from both. A deletion is no
// notice: the tombstone's transaction registers a `projection-remove` job per
// projection (projection-kinds.ts, I04-R12), which the job runner executes.
// With the vector write path bound (`vectors`, vector-build.ts) a new version is
// embedded into the active generation and a rebuild fills a generation beside it;
// without it the index holds no vectors and its removals keep its applied change
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
  type KnowledgeEngine,
  type VectorIndex,
} from "@pki/contracts";
import {
  canonicalTransaction,
  readChangeSeq,
  readSetting,
  readSourceVersion,
  writeSetting,
  type DerivativeRegistry,
  type SqlDriver,
} from "@pki/storage";
import { derivativeRegistry } from "./canonical-kinds.ts";
import { tombstoneEntries } from "./tombstone-entry.ts";
import {
  embedVersion,
  latestVersionRows,
  rebuildVectors,
  sameSpace,
  vectorRefOf,
  vectorTextOf,
  type VectorWrites,
} from "./vector-build.ts";

export { vectorRefOf };

/** What one committed version tells the projections. */
export interface ProjectionNotice {
  kind: "version";
  sourceId: number;
  /** The stored version: the source's latest when the notice was built. */
  version: number;
  /** The source's lower versions, past evidence now. */
  replacedVersions: number[];
  /** The version's row ID: its text is read from the store at delivery. */
  versionId: number;
  changeSeq: number;
}

export type ProjectionName = "engine" | "vectorIndex";

/** A projection's stale mark: "1" from a failed delivery until a rebuild writes "0". */
export const PROJECTION_STALE_SETTINGS: Readonly<Record<ProjectionName, string>> = Object.freeze({
  engine: "projections.engine-stale",
  vectorIndex: "projections.vector-index-stale",
});

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
    replacedVersions: db
      .all(
        "SELECT version FROM source_versions WHERE source_id = ? AND version < ? ORDER BY version",
        [sourceId, version],
      )
      .map((r) => r.version as number),
    changeSeq: readChangeSeq(db),
  };
}

/** The user's deletion's outcome: `deleted` is any outcome that changed the tombstone. */
export type UserDelete = (
  db: SqlDriver,
  identity: { connectorInstanceId: string; namespace: string; externalId: string },
  at: string,
) => { outcome: "deleted" | "unchanged"; sourceId: number; coversVersion: number };

/**
 * The user's deletion (V02-R12, I04-R9): applyTombstone with reason `user-deleted` and no revision, in
 * one canonical transaction over a registry. A purged source can be re-marked by the user over a
 * source's reason or after a lift. The removal from the projections is the jobs that transaction
 * registered; the caller wakes the runner.
 */
export function createUserDelete(registry: DerivativeRegistry): UserDelete {
  const { applyTombstone } = tombstoneEntries(registry);
  return (db, identity, at) =>
    canonicalTransaction(db, (tx) => {
      const result = applyTombstone(tx, {
        identity,
        reason: "user-deleted",
        lastRevision: null,
        at,
      });
      return {
        outcome: result.outcome === "unchanged" ? "unchanged" : "deleted",
        sourceId: result.sourceId,
        coversVersion: result.coversVersion,
      };
    });
}

export const userDelete: UserDelete = createUserDelete(derivativeRegistry);

/** `requested`: behind, and a rebuild job was asked for instead of rebuilding in place (H01C3-R10). */
export type ReconcileOutcome = "current" | "rebuilt" | "requested" | "skipped" | "failed";

export interface ProjectionsOptions {
  db: SqlDriver;
  engine: KnowledgeEngine;
  vectorIndex: VectorIndex;
  /** The space a vector index rebuild builds in (the embedder's model); null skips it. */
  embeddingSpace: () => EmbeddingSpace | null;
  /** The vector write path (H01C3): embedding, and the rebuild job the start asks for. Absent: no vectors are written. */
  vectors?: VectorWrites;
  /** A failed delivery or rebuild; the error may carry engine text, so log its class only. */
  onError?: (projection: ProjectionName, error: unknown) => void;
}

export interface Projections {
  /** Delivers after everything notified before; resolves once delivered (failures are reported, not thrown). */
  notify(notices: readonly ProjectionNotice[]): Promise<void>;
  /** The start-up comparison and rebuild, queued like a notice. */
  reconcile(): Promise<Record<ProjectionName, ReconcileOutcome>>;
  /**
   * Rebuilds one projection from the canonical store and reports `seq` as applied (a `projection-rebuild`
   * job: the sequence it read before reading the store). Queued like a notice, so it never overlaps a
   * delivery; clears the projection's stale mark. A failure is thrown for the job to classify, never marked.
   */
  rebuild(name: ProjectionName, seq: number, signal?: AbortSignal): Promise<void>;
  /** Resolves once everything queued so far is delivered. */
  drain(): Promise<void>;
  /** True from a missed notice (failed or unavailable) until a rebuild: it may hold purged content. */
  isStale(name: ProjectionName): boolean;
}

/** The latest version of every source with one (a purged source has none). */
async function* latestSources(db: SqlDriver): AsyncGenerator<EngineSourceInput> {
  for (const row of latestVersionRows(db)) {
    const stored = readSourceVersion(db, row.id);
    if (!stored) continue; // purged since the list was read
    yield {
      ref: { sourceId: String(row.sourceId), version: row.version },
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
    await deliver("engine", async () => {
      const stored = readSourceVersion(db, notice.versionId);
      // purged after the commit: its removal job follows, nothing to hand over
      if (stored) {
        const ref = { sourceId, version: notice.version };
        await engine.upsertSource({ ref, title: stored.title, body: stored.body }, fence, seq);
      }
      if (notice.version > 1) {
        await engine.removeSource({ sourceId, version: notice.version - 1 }, fence, seq);
      }
    });
    await deliver("vectorIndex", async () => {
      if (options.vectors) {
        const space = options.embeddingSpace();
        if (!space) throw new AdapterUnavailableError("no embedding space bound");
        const stored = readSourceVersion(db, notice.versionId);
        // purged after the commit: its removal job follows, nothing to embed
        if (stored) {
          const ref = vectorRefOf(notice.sourceId, notice.version);
          await embedVersion(
            { vectorIndex, writes: options.vectors, space },
            { ref, text: vectorTextOf(stored) },
            seq,
          );
        }
      }
      await vectorIndex.remove(
        notice.replacedVersions.map((version) => vectorRefOf(notice.sourceId, version)),
        seq,
      );
    });
  }

  const rebuilders: Record<ProjectionName, (seq: number, signal?: AbortSignal) => Promise<void>> = {
    engine: (seq) => engine.rebuild(latestSources(db), seq),
    vectorIndex: async (seq, signal) => {
      const space = options.embeddingSpace();
      if (!space) throw new AdapterUnavailableError("no embedding space bound");
      if (options.vectors) {
        return rebuildVectors({ db, vectorIndex, space, writes: options.vectors }, seq, signal);
      }
      // no write path bound: the rebuilt index is an empty generation at the sequence it was rebuilt at
      await (await vectorIndex.beginRebuild(space)).activate([], seq);
    },
  };

  /** H01C3-R10 ②–④ besides the sequence: another embedding space than the bound embedder's. */
  async function vectorSpaceDiffers() {
    const space = options.embeddingSpace();
    const active = await vectorIndex.embeddingSpace();
    return options.vectors !== undefined && space !== null && !(active && sameSpace(active, space));
  }

  async function reconcileOne(
    name: ProjectionName,
    behind: (seq: number) => Promise<boolean>,
    rebuild: (seq: number) => Promise<void>,
  ): Promise<ReconcileOutcome> {
    try {
      const seq = readChangeSeq(db);
      const marked = stale[name] || readSetting(db, PROJECTION_STALE_SETTINGS[name]) === "1";
      if (!marked && !(await behind(seq))) return "current";
      if (name === "vectorIndex" && options.vectors) {
        // embedding a corpus is a job's work, not the start's: mark it behind and ask for the job
        stale[name] = true;
        writeSetting(db, PROJECTION_STALE_SETTINGS[name], "1");
        options.vectors.requestRebuild(name);
        return "requested";
      }
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
          async (seq) => (await engine.appliedChangeSeq()) !== seq,
          rebuilders.engine,
        ),
        vectorIndex: await reconcileOne(
          "vectorIndex",
          async (seq) =>
            (await vectorIndex.appliedChangeSeq()) !== seq || (await vectorSpaceDiffers()),
          rebuilders.vectorIndex,
        ),
      })),
    rebuild: (name, seq, signal) =>
      enqueue(async () => {
        await rebuilders[name](seq, signal);
        stale[name] = false;
        if (readSetting(db, PROJECTION_STALE_SETTINGS[name]) === "1") {
          writeSetting(db, PROJECTION_STALE_SETTINGS[name], "0");
        }
      }),
    drain: () => enqueue(async () => undefined),
    isStale: (name) => stale[name],
  };
}
