// Test support: applies a source's tombstone through the product entries, by the
// source's row id (V02's deleteSource, which took an id, is gone). Not exported
// from the package. A purged source's row holds only a hash, so a plain identity
// read before the first call is remembered for the calls after it.
import {
  canonicalTransaction,
  readChangeSeq,
  readTombstoneState,
  type SqlDriver,
  type TombstoneReason,
} from "@pki/storage";
import type { ProjectionNotice } from "./projections.ts";
import { applyTombstone } from "./tombstone-entry.ts";

interface Identity {
  connectorInstanceId: string;
  namespace: string;
  externalId: string;
}
const known = new Map<number, Identity>();

export function purgeSource(
  db: SqlDriver,
  sourceId: number,
  { reason, at }: { reason: TombstoneReason; at: string },
): { outcome: "deleted" | "unchanged"; version: number; notice?: ProjectionNotice } {
  const row = db.all(
    "SELECT connector_instance_id AS i, namespace AS n, external_id AS e, identity_hashed AS h FROM sources WHERE id = ?",
    [sourceId],
  )[0];
  if (row && row.h === 0) {
    known.set(sourceId, {
      connectorInstanceId: row.i as string,
      namespace: row.n as string,
      externalId: row.e as string,
    });
  }
  const identity = known.get(sourceId);
  if (!identity) throw new Error(`source ${sourceId}: no plain identity to apply a tombstone by`);
  const versionIds = db
    .all("SELECT id FROM source_versions WHERE source_id = ? ORDER BY version", [sourceId])
    .map((r) => r.id as number);
  return canonicalTransaction(db, (tx) => {
    const result = applyTombstone(tx, { identity, reason, lastRevision: null, at });
    const version = readTombstoneState(tx, sourceId)?.coversVersion ?? 0;
    if (result.outcome === "unchanged") return { outcome: "unchanged" as const, version };
    return {
      outcome: "deleted" as const,
      version,
      ...(versionIds.length === 0
        ? {}
        : {
            notice: {
              kind: "removed" as const,
              sourceId,
              version,
              versionIds,
              changeSeq: readChangeSeq(tx),
            },
          }),
    };
  });
}
