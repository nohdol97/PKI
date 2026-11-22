// Test seed: a tombstone as a build from before I04-T05 wrote it, a cover and a
// reason and no revision (`last_revision` empty). The product writes tombstones
// only through applyTombstone; tests that need a legacy row (the door of I01-R10
// without a revision) or a cover with no purge behind it use this raw write.
// It moves the cover only upward, as the old write did.
import type { ContractSqlDriver } from "./sql-driver.contract.ts";

export function seedLegacyTombstone(
  db: Pick<ContractSqlDriver, "run">,
  t: {
    sourceId: number;
    version: number;
    at: string;
    reason: "user-deleted" | "source-deleted" | "access-revoked";
  },
): void {
  db.run(
    `INSERT INTO tombstones (source_id, covers_version, at, reason) VALUES (?, ?, ?, ?)
     ON CONFLICT (source_id) DO UPDATE SET covers_version = excluded.covers_version,
       at = excluded.at, reason = excluded.reason, last_revision = NULL, lifted_at = NULL
     WHERE excluded.covers_version > tombstones.covers_version`,
    [t.sourceId, t.version, t.at, t.reason],
  );
}
