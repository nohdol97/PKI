// The fence of a derivative's write and the one function that writes it (I04-R11).
// The caller (I03's result-writing transaction, I03-R6 ③) opens the transaction;
// everything here runs inside it, so the checks and the writes see one state.
//
// assertFresh: the version the job took is stored, the source's latest and covered
// by no tombstone. assertLineage: every other source version an item came from
// (a candidate item's evidence, say) is stored and covered by no tombstone; it need
// not be the latest. A failure of either discards the WHOLE result: it is stale,
// and the job closes superseded. A scope the policy refuses (`combinable`, I04-R14; a policy that
// errs refuses) is not stale: it leaves out that item only and the rest is written.
import {
  scopesOfVersions,
  versionIsLive,
  type CommitDerived,
  type SourceVersionRef,
  type StaleCause,
} from "./derivatives.ts";
import { mayCombine } from "./scope-policy.ts";
import type { SqlDriver } from "./sql-driver.ts";

/** A result that no longer holds; `cause` is what commitDerived reports. */
export class StaleDerivativeError extends Error {
  override name = "StaleDerivativeError";
  override readonly cause: StaleCause;
  constructor(cause: StaleCause) {
    super(`stale derivative: ${cause}`);
    this.cause = cause;
  }
}

/**
 * Why the version is not fresh, or null when it is. A tombstone that covers the
 * version decides first (a lifted cover still covers what it covered, and a cover
 * below the version, lifted or not, is not why a newer version is refused), then
 * a version that is not stored, then one a newer version replaced.
 */
function staleCauseOf(
  db: SqlDriver,
  sourceId: number,
  version: number,
): "covered" | "missing" | "not-latest" | null {
  const row = db.all(
    `SELECT EXISTS (SELECT 1 FROM tombstones WHERE source_id = ? AND covers_version >= ?) AS covered,
            EXISTS (SELECT 1 FROM source_versions WHERE source_id = ? AND version = ?) AS stored,
            (SELECT max(version) FROM source_versions WHERE source_id = ?) AS latest`,
    [sourceId, version, sourceId, version, sourceId],
  )[0];
  if (row?.covered === 1) return "covered";
  if (row?.stored !== 1) return "missing";
  return row.latest === version ? null : "not-latest";
}

/** Throws StaleDerivativeError unless `version` is the source's latest, stored and uncovered. */
export function assertFresh(db: SqlDriver, sourceId: number, version: number): void {
  const cause = staleCauseOf(db, sourceId, version);
  if (cause) throw new StaleDerivativeError(cause);
}

/** The same test as a boolean, for a caller that only wants to know before it spends a call. */
export function isFenceCurrent(
  db: SqlDriver,
  job: { sourceId: number; fenceVersion: number },
): boolean {
  return staleCauseOf(db, job.sourceId, job.fenceVersion) === null;
}

/** Throws StaleDerivativeError (`lineage-covered`) when a version of the lineage is gone or covered. */
export function assertLineage(db: SqlDriver, lineage: readonly SourceVersionRef[]): void {
  const seen = new Set<string>();
  for (const v of lineage) {
    const key = `${v.sourceId}:${v.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!versionIsLive(db, v)) throw new StaleDerivativeError("lineage-covered");
  }
}

/**
 * The only write of a derivative (I04-R11). Stale source or lineage: nothing is
 * written, `stale` with the cause (the source's own cause first). Otherwise each
 * item is written in order, except one the scope policy refuses, which is recorded
 * and left out. The caller opens the transaction; a throwing `write` propagates and
 * rolls it back.
 */
export const commitDerived: CommitDerived = (tx, input) => {
  try {
    if (input.source) assertFresh(tx, input.source.sourceId, input.source.version);
    assertLineage(
      tx,
      input.items.flatMap((item) => item.lineage),
    );
  } catch (error) {
    if (error instanceof StaleDerivativeError) return { status: "stale", cause: error.cause };
    throw error;
  }
  const { scope } = input;
  const dropped = [];
  let written = 0;
  for (const item of input.items) {
    // An item with no lineage (a sourceless job's write) or marked `unjudged` has no source content to
    // judge: the policy is not asked, so it cannot hold such a job `running` (I04-T09).
    const judged = item.unjudged !== true && item.lineage.length > 0;
    if (scope && judged && !mayCombine(scope.policy, scopesOfVersions(tx, item.lineage))) {
      // the version the record names: the job's input, else where the item's lineage begins
      const anchor = input.source ?? (item.lineage[0] as SourceVersionRef);
      dropped.push(scope.recordDrop(tx, item, anchor));
      continue;
    }
    item.write(tx);
    written++;
  }
  return { status: "committed", written, dropped };
};
