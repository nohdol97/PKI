// The user's pruning of one source's earlier versions (I04-R10 optional part, I04-T12): every
// version below the latest is deleted, with the evidence on it and what only that evidence
// supported, through the registry's `old-versions-pruned` propagation, in one canonical transaction.
// No tombstone is written: the source stays, its latest version stays and its numbering goes on
// above the pruned versions (versions are never renumbered). The projections' removal is the jobs
// that transaction registered; the caller wakes the runner.
import {
  canonicalTransaction,
  findSourceId,
  raiseChangeSeq,
  type DerivativeRegistry,
  type SqlDriver,
} from "@pki/storage";
import { propagateCanonical } from "./canonical-kinds.ts";

export type PruneVersions = (
  db: SqlDriver,
  identity: { connectorInstanceId: string; namespace: string; externalId: string },
  at: string,
) =>
  | {
      outcome: "pruned" | "unchanged";
      sourceId: number;
      keptVersion: number;
      prunedVersions: number;
    }
  | { outcome: "not-found" };

export function createPruneVersions(registry: DerivativeRegistry): PruneVersions {
  return (db, identity, at) =>
    canonicalTransaction(db, (tx) => {
      const sourceId = findSourceId(
        tx,
        identity.connectorInstanceId,
        identity.namespace,
        identity.externalId,
      );
      const { latest, count } = tx.all(
        "SELECT max(version) AS latest, count(*) AS count FROM source_versions WHERE source_id = ?",
        [sourceId ?? -1],
      )[0] as { latest: number | null; count: number };
      // a purged (tombstoned) source holds no version: nothing to prune, and no tombstone changes
      if (sourceId === undefined || latest === null) return { outcome: "not-found" as const };
      const keptVersion = latest;
      const prunedVersions = count - 1;
      if (prunedVersions === 0) {
        return { outcome: "unchanged" as const, sourceId, keptVersion, prunedVersions };
      }
      // before the removals are registered, so a rebuild that read the store earlier cannot close them
      raiseChangeSeq(tx);
      propagateCanonical(
        tx,
        { kind: "old-versions-pruned", sourceId, version: keptVersion },
        at,
        registry,
      );
      return { outcome: "pruned" as const, sourceId, keptVersion, prunedVersions };
    });
}
