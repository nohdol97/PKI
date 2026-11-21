// Job records (V01-R6, V02-R3). The Broker reads a job to treat a call as
// background (V01-R8). A job names its source and the version it was registered
// for, its fence (V02-R5), so it outlives the deletion of that version; the lease
// is when its claim runs out (V02-R4). V02-T03 adds the runner.
import type { SqlDriver } from "./sql-driver.ts";

export interface StoredJob {
  id: number;
  kind: string;
  sourceId: number;
  fenceVersion: number;
  status: string;
  leaseUntil: string | null;
}

export function readJob(db: SqlDriver, id: number): StoredJob | undefined {
  const row = db.all(
    "SELECT kind, source_id, fence_version, status, lease_until FROM jobs WHERE id = ?",
    [id],
  )[0];
  if (!row) return undefined;
  return {
    id,
    kind: row.kind as string,
    sourceId: row.source_id as number,
    fenceVersion: row.fence_version as number,
    status: row.status as string,
    leaseUntil: row.lease_until as string | null,
  };
}
