// A source's deletion or access revocation (V02-R12, I04-R5, R12), one
// transaction: a tombstone (identifier, the version reached, the time, the
// reason; no content) covering every product version of the source, which raises
// the change sequence; the source's open jobs closed (I03's supersedeOpenJobs:
// a running job's holder loses its lease, projection jobs stay); then the
// registry's propagation of the tombstone change through every canonical kind
// (canonical-kinds.ts): all its versions with their evidence and keyword index
// rows, what they alone supported, the knowledge left judged again and the rule
// over the collected items that remain. The `dirty` Insight state is not used:
// the rule runs here, in the same transaction. I04-T05's tombstone entry takes
// this place.
import {
  supersedeOpenJobs,
  writeTombstone,
  type InsightKey,
  type SqlDriver,
  type TombstoneReason,
} from "@pki/storage";
import { propagateCanonical, type CanonicalReport } from "./canonical-kinds.ts";
import type { RuleOutcome } from "./dependency-delay.ts";

/** What the canonical kinds deleted and kept, by id, ascending. */
export type PurgeResult = Omit<CanonicalReport, "insights">;

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
    // one clock for the whole deletion: the tombstone's, the jobs' and the record's
    const when = new Date(at);
    if (Number.isNaN(when.getTime())) throw new RangeError(`deletion time is not a date: ${at}`);
    // A stored version is always above the source's tombstone (storage trigger),
    // so the latest version covers every version, past tombstones included.
    if (writeTombstone(db, { sourceId, version: latest, at, reason }) !== "written") {
      throw new Error(`source ${sourceId}: tombstone not moved to version ${latest}`);
    }
    supersedeOpenJobs(db, sourceId, when);
    const { insights, ...purge } = propagateCanonical(
      db,
      // the tombstone keeps no revision before I04-T05
      { kind: reason, sourceId, coversVersion: latest, lastRevision: null },
      at,
    ).report;
    return { outcome: "deleted", version: latest, purge, insights };
  });
}
