// The engine and the vector index as registered derivative kinds (I04-R1, I04-T04). Both are
// projections of the canonical store: a row of either is one source version's, named
// `<sourceId>:<version>`, and its lineage is that version. A new version and a scope change reach them
// as notices (projections.ts); a deletion reaches them here, in the tombstone's transaction, as one
// `projection-remove` job per kind, registered after the tombstone raised the change sequence (I04-R12,
// the rebuild of I03-T10 closes by that order) and run after the commit. The job carries the tombstone's
// cover and no version fence of the source's own: what it removes is the versions up to the cover, never
// a newer version's item taken after a lift (backend projection-jobs.ts, projection-ports.ts).
import {
  PROJECTION_REMOVE_KIND,
  registerJob,
  type Affected,
  type DerivativeKind,
  type DerivedRef,
  type SourceChange,
  type SourceVersionRef,
  type SqlDriver,
} from "@pki/storage";

/** The kind names are the projections' names in a job row (`jobs.target`) and in the stale marks. */
export const ENGINE_KIND = "engine";
export const VECTOR_KIND = "vectorIndex";

/** Whether the implementation bound to a kind is one that never holds anything (the null engine, the empty index). */
export type PermanentlyAbsent = Partial<Record<typeof ENGINE_KIND | typeof VECTOR_KIND, true>>;

/** `<sourceId>:<version>`: a projection row is one source version's. */
export const projectionRowId = (v: SourceVersionRef): string => `${v.sourceId}:${v.version}`;

function versionOfRow(ref: DerivedRef): SourceVersionRef {
  const match = /^(\d+):(\d+)$/.exec(ref.id);
  if (!match) throw new Error(`a ${ref.kind} row is named <sourceId>:<version>, not ${ref.id}`);
  return { sourceId: Number(match[1]), version: Number(match[2]) };
}

/**
 * The version a removal covers: a tombstone's cover, or for a prune the one below the version it
 * keeps (I04-T12). Other changes reach a projection as notices.
 */
const coversVersion = (change: SourceChange): number | undefined =>
  change.kind === "old-versions-pruned"
    ? change.version - 1
    : "coversVersion" in change
      ? change.coversVersion
      : undefined;

function projectionKind(kind: string, absent: boolean, at: () => string): DerivativeKind {
  return {
    kind,
    layer: "projection",
    references: [],
    storage: "projection",
    dataPaths: [],
    ...(absent ? { permanentlyAbsent: true as const } : {}),
    // every stored version of the source the change takes, before it: what the projection may still hold
    affected: (tx: SqlDriver, change): Affected =>
      coversVersion(change) === undefined
        ? []
        : tx
            .all(
              "SELECT version FROM source_versions WHERE source_id = ? AND version <= ? ORDER BY version",
              [
                change.sourceId,
                change.kind === "old-versions-pruned"
                  ? change.version - 1
                  : Number.MAX_SAFE_INTEGER,
              ],
            )
            .map((r) => {
              const version = { sourceId: change.sourceId, version: r.version as number };
              return { ref: { kind, id: projectionRowId(version) }, lineage: [version] };
            }),
    lineage: (_db, ref) => [versionOfRow(ref)],
    invalidate: (ctx, snapshot, change) => {
      const covers = coversVersion(change);
      if (covers === undefined || snapshot.length === 0) return { removed: 0, recomputed: 0 };
      // the job is one per source: it covers every version up to the tombstone's (R12)
      const registered = registerJob(ctx.tx, {
        kind: PROJECTION_REMOVE_KIND,
        target: kind,
        sourceId: change.sourceId,
        fenceVersion: covers,
        priority: "user",
        at: new Date(at()),
      });
      return { removed: registered.registered ? 1 : 0, recomputed: 0 };
    },
  };
}

/**
 * The two projection kinds. `at` is the request's time (the registry's record time), so the job and the
 * record of one deletion carry one time.
 */
export function projectionKinds(options: {
  at: () => string;
  permanentlyAbsent?: PermanentlyAbsent;
}): readonly DerivativeKind[] {
  const absent = options.permanentlyAbsent ?? {};
  return [ENGINE_KIND, VECTOR_KIND].map((kind) =>
    projectionKind(kind, absent[kind as keyof PermanentlyAbsent] === true, options.at),
  );
}
