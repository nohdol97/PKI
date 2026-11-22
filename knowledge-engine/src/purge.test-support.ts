// Test support (a `*.test-support.ts` file: refused in product code by lint and the bundle). Applies a source's tombstone through the product entries, by the
// source's row id (V02's deleteSource, which took an id, is gone). Not exported
// from the package. A purged source's row holds only a hash, so a plain identity
// read before the first call is remembered for the calls after it.
import {
  canonicalTransaction,
  readTombstoneState,
  type SqlDriver,
  type TombstoneReason,
} from "@pki/storage";
import { applyTombstone } from "./tombstone-entry.ts";

interface Identity {
  connectorInstanceId: string;
  namespace: string;
  externalId: string;
}
/** Plain identities by database, then source id: ids repeat across the databases of one file. */
const known = new WeakMap<SqlDriver, Map<number, Identity>>();

export function purgeSource(
  db: SqlDriver,
  sourceId: number,
  { reason, at }: { reason: TombstoneReason; at: string },
): { outcome: "deleted" | "unchanged"; version: number } {
  const row = db.all(
    "SELECT connector_instance_id AS i, namespace AS n, external_id AS e, identity_hashed AS h FROM sources WHERE id = ?",
    [sourceId],
  )[0];
  const byId = known.get(db) ?? new Map<number, Identity>();
  known.set(db, byId);
  if (row && row.h === 0) {
    byId.set(sourceId, {
      connectorInstanceId: row.i as string,
      namespace: row.n as string,
      externalId: row.e as string,
    });
  }
  const identity = byId.get(sourceId);
  if (!identity) throw new Error(`source ${sourceId}: no plain identity to apply a tombstone by`);
  return canonicalTransaction(db, (tx) => {
    const result = applyTombstone(tx, { identity, reason, lastRevision: null, at });
    const version = readTombstoneState(tx, sourceId)?.coversVersion ?? 0;
    return {
      outcome: result.outcome === "unchanged" ? ("unchanged" as const) : ("deleted" as const),
      version,
    };
  });
}
