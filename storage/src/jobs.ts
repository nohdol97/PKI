// Job records (V01-R6). V01 only reads them: the Broker treats a call that names
// a job as background (V01-R8). V02 adds the runner, lease and fence.
import type { SqlDriver } from "./sql-driver.ts";

export interface StoredJob {
  id: number;
  kind: string;
  sourceVersionId: number;
  status: string;
}

export function readJob(db: SqlDriver, id: number): StoredJob | undefined {
  const row = db.all("SELECT id, kind, source_version_id, status FROM jobs WHERE id = ?", [id])[0];
  if (!row) return undefined;
  return {
    id: row.id as number,
    kind: row.kind as string,
    sourceVersionId: row.source_version_id as number,
    status: row.status as string,
  };
}
