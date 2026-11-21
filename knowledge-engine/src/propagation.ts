// A new source version's propagation (V02-R11). The evidence on the previous
// versions is not taken off: it becomes past evidence by itself (it points at a
// version that is no longer the latest). What it alone supported becomes
// superseded, and the rule is recomputed at once over the items of every row
// the source's versions cite (a row another source keeps valid holds past
// evidence too), so an Insight never waits in a "재계산 대기" (dirty) state
// (provisional). The new
// version is then extracted by its own job; an extraction that gives a superseded
// row current evidence again revives it (extraction.ts). The caller runs this in
// the transaction that stores the version, before the extraction is registered.
import { supersedeUnsupported, type InsightKey, type SqlDriver } from "@pki/storage";
import { recomputeDependencyDelay, type RuleOutcome } from "./dependency-delay.ts";

export interface Propagation {
  /** Facts and relations superseded, ascending. */
  facts: number[];
  relations: number[];
  /** The rule's judgment of each pair over the cited rows' items. */
  insights: { key: InsightKey; outcome: RuleOutcome }[];
}

export function propagateNewVersion(db: SqlDriver, sourceId: number): Propagation {
  return db.transaction(() => {
    const { facts, relations, itemIds } = supersedeUnsupported(db, sourceId);
    return { facts, relations, insights: recomputeDependencyDelay(db, itemIds) };
  });
}
