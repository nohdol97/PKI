// The analytical read and check-request handlers (S03-R19, T08), written for the server to mount (the wiring
// list is in the T08 report): `list` is `GET /api/analytical`, `check` is `POST /api/analytical/check`. Both take
// the visibility as a predicate over the registry's `visible` (read-gate.ts), so a hidden row, check line or table
// is absent and a hidden item is `not-found`, the one answer for an item that is absent, deleted or hidden. An
// error answer is a closed code with no name, value or quote (S01-R23). Nothing here computes or returns a
// metric value (S03-R18). The storage reads arrive as `views` so this file does not wait for the storage entry.
import {
  ANALYTICAL_CHECK_JOB_KIND,
  registerAnalyticalCheckJob,
  type SqlDriver,
} from "@pki/storage";

export interface AnalyticalVisibility {
  shown(kind: string, id: string): boolean;
}

export interface AnalyticalApiDeps<List> {
  db: SqlDriver;
  /** The registry's `visible` for the purpose `display`, one ref at a time. */
  shown: AnalyticalVisibility["shown"];
  /** `listAnalytical` of storage. */
  views: { listAnalytical(db: SqlDriver, vis: AnalyticalVisibility): List };
  now?: () => Date;
}

export type AnalyticalCheckAnswer = { jobIds: number[] } | { error: "not-found" };

export interface AnalyticalApi<List> {
  list(): List;
  /** Queues the check job of every table source the item reaches (S03-R12 (5)); the job ids by source id. */
  check(input: { itemId: number }): AnalyticalCheckAnswer;
}

/** The open or latest job of a source's current version, after `registerAnalyticalCheckJob` made or reused one. */
function jobOf(db: SqlDriver, sourceId: number): number | undefined {
  const row = db.all(
    `SELECT j.id FROM jobs j
      WHERE j.kind = ? AND j.source_id = ?
        AND j.fence_version = (SELECT max(version) FROM source_versions WHERE source_id = ?)
      ORDER BY j.id DESC LIMIT 1`,
    [ANALYTICAL_CHECK_JOB_KIND, sourceId, sourceId],
  )[0];
  return row?.id as number | undefined;
}

const LIVE = "status NOT IN ('superseded', 'rejected')";

/**
 * The table sources an item reaches over the relations the caller sees: its own tables, and those of the
 * Datasets on its `MEASURED_ON`/`JOIN_*` relations and of the Joins on its `USES_JOIN` (the two written paths
 * of S03-R12), a hidden relation being no path.
 */
function visibleTableSources(db: SqlDriver, shown: AnalyticalVisibility["shown"], itemId: number) {
  const objects = (subject: number, types: string[]) =>
    db
      .all(
        `SELECT id, object_id FROM relations WHERE subject_id = ? AND type IN (SELECT value FROM json_each(?)) AND ${LIVE}`,
        [subject, JSON.stringify(types)],
      )
      .filter((r) => shown("relation", String(r.id)))
      .map((r) => r.object_id as number);
  const datasets = new Set<number>([
    itemId,
    ...objects(itemId, ["MEASURED_ON", "JOIN_LEFT", "JOIN_RIGHT"]),
  ]);
  for (const join of objects(itemId, ["USES_JOIN"])) {
    for (const d of objects(join, ["JOIN_LEFT", "JOIN_RIGHT"])) datasets.add(d);
  }
  return db
    .all(
      "SELECT DISTINCT source_id FROM dataset_tables WHERE item_id IN (SELECT value FROM json_each(?)) ORDER BY source_id",
      [JSON.stringify([...datasets])],
    )
    .map((r) => r.source_id as number);
}

export function createAnalyticalApi<List>(deps: AnalyticalApiDeps<List>): AnalyticalApi<List> {
  const { db } = deps;
  return {
    list: () => deps.views.listAnalytical(db, { shown: deps.shown }),
    check({ itemId }) {
      if (!deps.shown("item", String(itemId))) return { error: "not-found" };
      if (db.all("SELECT 1 FROM items WHERE id = ?", [itemId]).length === 0) {
        return { error: "not-found" };
      }
      return db.transaction(() => {
        const jobIds: number[] = [];
        for (const sourceId of visibleTableSources(db, deps.shown, itemId)) {
          // a source the caller may not see is not queued: its table is hidden from this caller whole
          if (!deps.shown("source", String(sourceId))) continue;
          registerAnalyticalCheckJob(db, sourceId, deps.now?.());
          const id = jobOf(db, sourceId);
          if (id !== undefined) jobIds.push(id);
        }
        return { jobIds };
      });
    },
  };
}
