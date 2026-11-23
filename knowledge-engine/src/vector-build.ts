// The vector index's write path (H01C3-R4, ARCHITECTURE 5.4): a rebuild fills a generation beside the
// active one from the canonical store and switches only when its ref set is the target set, so the active
// generation answers until the switch and again after any failure. The embedding function is the
// composition point's (it passes the transmission policy, R6); this package does not know providers.
import {
  AdapterUnavailableError,
  StaleFenceError,
  type EmbeddingSpace,
  type IndexedRef,
  type VectorIndex,
  type VectorRebuild,
} from "@pki/contracts";
import { readSourceVersion, type SqlDriver } from "@pki/storage";

/**
 * A vector's canonical ID names its source version, `source-version:<sourceId>:<version>`. Neither number is
 * ever reused (versions only count up, past a tombstone's cover), and a removal after a deletion can name
 * the versions up to the cover without the version rows, which the purge took.
 */
export const vectorRefOf = (sourceId: number, version: number): IndexedRef =>
  `source-version:${sourceId}:${version}`;

/** What reaches the embedder: one source version's text (D7). */
export const vectorTextOf = (stored: { title: string; body: string }) =>
  `${stored.title}\n${stored.body}`;

/** The latest version row of every source with one (a purged source has none), by source. */
export function latestVersionRows(
  db: SqlDriver,
): { id: number; sourceId: number; version: number }[] {
  return db
    .all(
      `SELECT v.id, v.source_id, v.version FROM source_versions v
        WHERE v.version = (SELECT max(version) FROM source_versions WHERE source_id = v.source_id)
        ORDER BY v.source_id`,
    )
    .map((row) => ({
      id: row.id as number,
      sourceId: row.source_id as number,
      version: row.version as number,
    }));
}

export const sameSpace = (a: EmbeddingSpace, b: EmbeddingSpace) =>
  a.modelId === b.modelId && a.revision === b.revision && a.dimension === b.dimension;

/** What the composition point lends the write path. */
export interface VectorWrites {
  /** Embeds document texts through the transmission policy; one vector per text. */
  embed: (texts: readonly string[], signal?: AbortSignal) => Promise<Float32Array[]>;
  /** Registers a `projection-rebuild` job for the projection (the start does not embed itself, R10). */
  requestRebuild: (name: "vectorIndex") => void;
  /** Texts per embed call and per check of the stop signal; default 16. */
  batchSize?: number;
}

const DEFAULT_BATCH = 16;
/** Passes over the store before a build that keeps finding differences gives up. */
const MAX_PASSES = 5;

export interface VectorBuildDeps {
  db: SqlDriver;
  vectorIndex: VectorIndex;
  space: EmbeddingSpace;
  writes: VectorWrites;
}

/** Writes a batch; a ref an removal got ahead of is dropped (it is gone from the store or replaced). */
async function upsertTolerant(
  target: Pick<VectorRebuild, "upsert">,
  items: { ref: IndexedRef; vector: Float32Array }[],
  seq: number,
) {
  try {
    await target.upsert(items, seq);
  } catch (error) {
    if (!(error instanceof StaleFenceError)) throw error;
    for (const item of items) {
      try {
        await target.upsert([item], seq);
      } catch (single) {
        if (!(single instanceof StaleFenceError)) throw single;
      }
    }
  }
}

/**
 * H01C3-R4: builds the generation for the target set (the latest version of every source) and activates it
 * at `seq`. Any failure, the stop signal included, discards the build and is thrown for the job to classify.
 */
export async function rebuildVectors(
  deps: VectorBuildDeps,
  seq: number,
  signal?: AbortSignal,
): Promise<void> {
  const { db, vectorIndex, space, writes } = deps;
  const batchSize = writes.batchSize ?? DEFAULT_BATCH;
  const build = await vectorIndex.beginRebuild(space);
  try {
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const target = new Map(
        latestVersionRows(db).map((row) => [vectorRefOf(row.sourceId, row.version), row.id]),
      );
      const held = new Set(await build.refs());
      const missing = [...target.keys()].filter((ref) => !held.has(ref));
      for (let at = 0; at < missing.length; at += batchSize) {
        signal?.throwIfAborted();
        const items = missing.slice(at, at + batchSize).flatMap((ref) => {
          const stored = readSourceVersion(db, target.get(ref) as number);
          return stored ? [{ ref, text: vectorTextOf(stored) }] : []; // purged since the list was read
        });
        if (items.length === 0) continue;
        const vectors = await writes.embed(
          items.map((item) => item.text),
          signal,
        );
        await upsertTolerant(
          build,
          items.map((item, i) => ({ ref: item.ref, vector: vectors[i] as Float32Array })),
          seq,
        );
      }
      if (missing.length > 0) continue; // the store may have moved while embedding: look again
      // what the building generation holds beyond the target (a source deleted or replaced meanwhile)
      for (const ref of [...held].filter((held) => !target.has(held))) {
        try {
          await vectorIndex.remove([ref], seq);
        } catch (error) {
          if (!(error instanceof StaleFenceError)) throw error;
        }
      }
      await build.activate([...target.keys()], seq);
      return;
    }
    throw new Error("the vector build did not settle on the store's latest versions");
  } catch (error) {
    await build.discard().catch(() => undefined);
    throw error;
  }
}

/**
 * H01C3-R5: one stored version into the active generation. A generation of another space than the embedder's
 * is not written to (the caller marks the index stale: it is not the one this embedder searches).
 */
export async function embedVersion(
  deps: Pick<VectorBuildDeps, "vectorIndex" | "writes"> & { space: EmbeddingSpace },
  version: { ref: IndexedRef; text: string },
  seq: number,
): Promise<void> {
  const active = await deps.vectorIndex.embeddingSpace();
  if (!active) throw new AdapterUnavailableError("no active vector generation");
  if (!sameSpace(active, deps.space)) {
    throw new AdapterUnavailableError("the active vector generation is in another embedding space");
  }
  const [vector] = await deps.writes.embed([version.text]);
  await deps.vectorIndex.upsert([{ ref: version.ref, vector: vector as Float32Array }], seq);
}
