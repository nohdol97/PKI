// What the scope policy left out of an extraction (I04-R4, R11, R15; schema v18).
// commitDerived asks the policy about each item's lineage; an item it refuses is not
// written and one content-free row is kept: the source and version of the extraction's
// input, the kind, the keyed hash of the item's key (the key is names and values, so it
// is never stored, I04-R7) and when. The rows live apart from the jobs, which the
// retention clean-up deletes. A scope change queues the re-extraction of every source
// with a row (I04-R15, knowledge-engine canonical-kinds.ts); its commit clears them.
import type { CommitScope, ScopePolicy, ScopePolicyDrop } from "./derivatives.ts";
import { keyedTextHash } from "./identity.ts";
import type { SqlDriver } from "./sql-driver.ts";

/** The hash domain of an item key in `scope_policy_drops`. */
const DROP_DOMAIN = "scope-policy-drop";

/** The commit's scope: `policy` judges, `recordDrop` stores the refusal in the commit's transaction. */
export function createCommitScope(options: {
  policy: Pick<ScopePolicy, "combinable">;
  /** The record's time (ISO 8601). */
  now?: () => string;
}): CommitScope {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    policy: options.policy,
    recordDrop(tx, item, source) {
      const drop: ScopePolicyDrop = {
        sourceId: source.sourceId,
        version: source.version,
        kind: item.kind,
        itemKeyHash: keyedTextHash(tx, DROP_DOMAIN, item.itemKey),
        reason: "scope-policy",
        at: now(),
      };
      // the same refusal is kept once: an extraction run again does not double the count
      tx.run(
        `INSERT INTO scope_policy_drops (source_id, version, kind, item_key_hash, reason, at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        [drop.sourceId, drop.version, drop.kind, drop.itemKeyHash, drop.reason, drop.at],
      );
      return drop;
    },
  };
}

/**
 * Records that a candidate item was not offered to the Broker because the policy would not let its
 * sources be put together with the extracted version (I04-R14, R15): the same content-free row as a
 * refused item (kind `candidate`, the keyed hash of the item's id), so a later widening extracts the
 * version again and offers it.
 */
export function recordWithheldCandidate(
  tx: SqlDriver,
  source: { sourceId: number; version: number },
  candidateId: string,
  at: string,
): void {
  tx.run(
    `INSERT INTO scope_policy_drops (source_id, version, kind, item_key_hash, reason, at)
     VALUES (?, ?, 'candidate', ?, 'scope-policy', ?) ON CONFLICT DO NOTHING`,
    [source.sourceId, source.version, keyedTextHash(tx, DROP_DOMAIN, candidateId), at],
  );
}

/** How many items the policy has left out and whose source has not been extracted again (the status API's `scopePolicyDrops`). */
export function countScopePolicyDrops(db: SqlDriver): number {
  return db.all("SELECT count(*) AS n FROM scope_policy_drops")[0]?.n as number;
}

/** The sources that have a record, ascending. */
export function scopePolicyDropSources(db: SqlDriver): number[] {
  return db
    .all("SELECT DISTINCT source_id FROM scope_policy_drops ORDER BY source_id")
    .map((r) => r.source_id as number);
}

/** Clears one source's records; how many rows went. */
export function clearScopePolicyDrops(db: SqlDriver, sourceId: number): number {
  return db.run("DELETE FROM scope_policy_drops WHERE source_id = ?", [sourceId]).changes;
}
