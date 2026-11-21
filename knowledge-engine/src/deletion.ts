// A source's deletion or access revocation (V02-R12), one transaction: a tombstone
// (identifier, the version reached, the time, the reason; no content) covering
// every product version of the source, which raises the change sequence; the
// purge of all its versions with their evidence and keyword index rows, and of
// what they alone supported (storage purge.ts); then the rule over the collected
// items that remain. Not propagateNewVersion ("T07이 넘기는 것" 6): nothing is
// superseded, what lost all evidence is deleted. The `dirty` Insight state is not
// used either: the rule runs here, in the same transaction.
// Open jobs of the source stay; the tombstone covers their fence version, so the
// runner closes them superseded and a late result is discarded (V02-R5).
import {
  purgeSourceContent,
  writeTombstone,
  type InsightKey,
  type PurgeResult,
  type SqlDriver,
  type TombstoneReason,
} from "@pki/storage";
import { recomputeDependencyDelay, type RuleOutcome } from "./dependency-delay.ts";

export type SourceDeletion =
  | {
      outcome: "deleted";
      /** The tombstone's version: the source's latest product version. */
      version: number;
      purge: PurgeResult;
      insights: { key: InsightKey; outcome: RuleOutcome }[];
    }
  /** No version was stored (already purged, or never stored): nothing written. */
  | { outcome: "unchanged" };

export interface DeletionRequest {
  reason: TombstoneReason;
  /** When the product applied it (ISO 8601); never a Connector's text. */
  at: string;
}

export function deleteSource(
  db: SqlDriver,
  sourceId: number,
  { reason, at }: DeletionRequest,
): SourceDeletion {
  return db.transaction(() => {
    const latest = db.all("SELECT max(version) AS v FROM source_versions WHERE source_id = ?", [
      sourceId,
    ])[0]?.v as number | null;
    if (latest === null) return { outcome: "unchanged" };
    // A stored version is always above the source's tombstone (storage trigger),
    // so the latest version covers every version, past tombstones included.
    if (writeTombstone(db, { sourceId, version: latest, at, reason }) !== "written") {
      throw new Error(`source ${sourceId}: tombstone not moved to version ${latest}`);
    }
    const purge = purgeSourceContent(db, sourceId);
    return {
      outcome: "deleted",
      version: latest,
      purge,
      insights: recomputeDependencyDelay(db, purge.remainingItemIds),
    };
  });
}
