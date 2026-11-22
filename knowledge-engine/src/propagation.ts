// A new source version's propagation (V02-R11), through the registry's canonical
// kinds (canonical-kinds.ts). The evidence on the previous versions is not taken
// off: it becomes past evidence by itself (it points at a version that is no
// longer the latest). What it alone supported becomes superseded, and the rule is
// recomputed at once over the items of every row the source's versions cite (a
// row another source keeps valid holds past evidence too), so an Insight never
// waits in a "재계산 대기" (dirty) state (provisional). The new version is then
// extracted by its own job; an extraction that gives a superseded row current
// evidence again revives it (extraction.ts). The caller runs this in the
// transaction that stores the version, right after storing it and before the
// extraction is registered.
import type { DerivativeRegistry, InsightKey, SqlDriver } from "@pki/storage";
import { derivativeRegistry, propagateCanonical } from "./canonical-kinds.ts";
import type { RuleOutcome } from "./dependency-delay.ts";

export interface Propagation {
  /** Facts and relations superseded, ascending. */
  facts: number[];
  relations: number[];
  /** The rule's judgment of each pair over the cited rows' items. */
  insights: { key: InsightKey; outcome: RuleOutcome }[];
}

export type PropagateNewVersion = (db: SqlDriver, sourceId: number) => Propagation;

/** `propagateNewVersion` over a registry: the one the composition root builds (entries.ts). */
export function createPropagateNewVersion(registry: DerivativeRegistry): PropagateNewVersion {
  return (db, sourceId) =>
    db.transaction(() => {
      const version = db.all("SELECT max(version) AS v FROM source_versions WHERE source_id = ?", [
        sourceId,
      ])[0]?.v as number | null;
      if (version === null) throw new Error(`source ${sourceId} has no version to propagate`);
      const { report } = propagateCanonical(
        db,
        { kind: "new-version", sourceId, version },
        undefined,
        registry,
      );
      return { ...report.superseded, insights: report.insights };
    });
}

export const propagateNewVersion: PropagateNewVersion =
  createPropagateNewVersion(derivativeRegistry);
