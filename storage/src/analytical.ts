// The analytical semantic's storage (S03-R1, R6): the two settings, the test of a table version, the one place
// the `dataset-profile` job is registered, and the rows of `dataset_tables`. A Dataset is a registry item and
// its columns are facts (the registry's tables hold them); this file holds only what ties an item to a stored
// table. No cell of a table is read or kept here.
import { ANALYTICAL_CHECK_JOB_KIND, DATASET_PROFILE_KIND } from "./job-kinds.ts";
import { registerJob } from "./jobs.ts";
import { readSetting, writeSetting } from "./settings.ts";
import type { SqlDriver } from "./sql-driver.ts";

/** The user's switch for the Dataset profile (S03-R6); anything but `on` is OFF. */
export const ANALYTICAL_PROFILE_SETTING = "analytical.profile";
/** The most cells a table may have to be read by the profile and the checks (S03-R5). */
export const ANALYTICAL_MAX_CELLS_SETTING = "analytical.maxCells";
/** Provisional (S03-R5): 200,000 cells. */
export const DEFAULT_MAX_CELLS = 200_000;

export const readAnalyticalProfile = (db: SqlDriver): boolean =>
  readSetting(db, ANALYTICAL_PROFILE_SETTING) === "on";

/** The stored limit when it is a whole number of at least one, else the default. */
export function readAnalyticalMaxCells(db: SqlDriver): number {
  const text = readSetting(db, ANALYTICAL_MAX_CELLS_SETTING);
  return text !== undefined && /^[1-9][0-9]*$/.test(text) && Number.isSafeInteger(Number(text))
    ? Number(text)
    : DEFAULT_MAX_CELLS;
}

/**
 * Whether a stored version is a table source: one of its blocks carries a `csv` or `xlsx` locator
 * (S03-R4). The blocks are read as JSON by SQLite, so no body is loaded.
 */
export function isTabularVersion(db: SqlDriver, sourceId: number, version: number): boolean {
  return (
    db.all(
      `SELECT 1 FROM source_versions v
        WHERE v.source_id = ? AND v.version = ? AND v.blocks IS NOT NULL
          AND EXISTS (SELECT 1 FROM json_each(v.blocks) b
                       WHERE json_extract(b.value, '$.locator.format') IN ('csv', 'xlsx'))`,
      [sourceId, version],
    ).length > 0
  );
}

/**
 * Registers the profile job of one version when the setting is ON and the version is a table source
 * (S03-R6); the version is the job's fence. True when a job was made; a job that exists already is no
 * conflict. The caller's transaction holds it, as the extraction job's registration is.
 */
export function registerDatasetProfileJob(
  db: SqlDriver,
  version: { sourceId: number; version: number; at: Date },
): boolean {
  if (!readAnalyticalProfile(db) || !isTabularVersion(db, version.sourceId, version.version)) {
    // no profile for this version: a table the source already holds still needs its checks again
    registerAnalyticalCheckJob(db, version.sourceId, version.at);
    return false;
  }
  return registerJob(db, {
    kind: DATASET_PROFILE_KIND,
    sourceId: version.sourceId,
    fenceVersion: version.version,
    at: version.at,
  }).registered;
}

const OPEN_BEFORE_RUN = "('queued', 'retry', 'held')";

/**
 * Queues the check job of one table source (S03-R12), fenced to the source's current version. None when the
 * source has no version, its current version is covered by a tombstone, or no `dataset_tables` row is bound
 * to it. A job of the same source and version that has not started yet is reused (it reads the state when it
 * runs); a running one is not, because it may have read the old state. A job the unique key refuses a second
 * time (kind, target, source, fence) is told apart by `target`: `run:<n>`, the next number. True when a job
 * was made. The caller's transaction holds it.
 */
export function registerAnalyticalCheckJob(db: SqlDriver, sourceId: number, at?: Date): boolean {
  const latest = db.all(`SELECT max(version) AS version FROM source_versions WHERE source_id = ?`, [
    sourceId,
  ])[0]?.version as number | null | undefined;
  if (latest === null || latest === undefined) return false;
  const covered = db.all("SELECT 1 FROM tombstones WHERE source_id = ? AND covers_version >= ?", [
    sourceId,
    latest,
  ]);
  if (covered.length > 0) return false;
  if (db.all("SELECT 1 FROM dataset_tables WHERE source_id = ? LIMIT 1", [sourceId]).length === 0) {
    return false;
  }
  const same = `kind = ? AND source_id = ? AND fence_version = ?`;
  const params = [ANALYTICAL_CHECK_JOB_KIND, sourceId, latest];
  if (
    db.all(`SELECT 1 FROM jobs WHERE ${same} AND status IN ${OPEN_BEFORE_RUN} LIMIT 1`, params)
      .length > 0
  ) {
    return false;
  }
  const next =
    (db.all(
      `SELECT max(CAST(substr(target, 5) AS INTEGER)) AS n FROM jobs WHERE ${same} AND target LIKE 'run:%'`,
      params,
    )[0]?.n as number | null) ?? 0;
  return registerJob(db, {
    kind: ANALYTICAL_CHECK_JOB_KIND,
    target: `run:${next + 1}`,
    sourceId,
    fenceVersion: latest,
    priority: "scheduled",
    ...(at ? { at } : {}),
  }).registered;
}

/**
 * Stores the switch. From OFF to ON it queues a profile job on the current version of every table source
 * that no tombstone covers (S03-R6): a table imported before the switch is not left out until its file
 * changes. ON to ON and OFF queue nothing. Runs in one transaction.
 */
export function setAnalyticalProfile(
  db: SqlDriver,
  on: boolean,
  at: Date,
): { profile: boolean; queued: number } {
  return db.transaction(() => {
    const was = readAnalyticalProfile(db);
    writeSetting(db, ANALYTICAL_PROFILE_SETTING, on ? "on" : "off");
    if (!on || was) return { profile: on, queued: 0 };
    let queued = 0;
    const current = db.all(
      `SELECT source_id, version FROM (
         SELECT source_id, max(version) AS version FROM source_versions GROUP BY source_id) c
        WHERE NOT EXISTS (SELECT 1 FROM tombstones t
                           WHERE t.source_id = c.source_id AND t.covers_version >= c.version)
        ORDER BY source_id`,
    );
    for (const row of current) {
      if (
        registerDatasetProfileJob(db, {
          sourceId: row.source_id as number,
          version: row.version as number,
          at,
        })
      ) {
        queued++;
      }
    }
    return { profile: true, queued };
  });
}

export interface DatasetTableRow {
  itemId: number;
  rowCount: number;
}

/** The Dataset item a table of a source stands for, or undefined (`key` is the sheet's name, "" for CSV). */
export function findDatasetTable(
  db: SqlDriver,
  sourceId: number,
  key: string,
): DatasetTableRow | undefined {
  const row = db.all(
    "SELECT item_id, row_count FROM dataset_tables WHERE source_id = ? AND table_key = ?",
    [sourceId, key],
  )[0];
  return row ? { itemId: row.item_id as number, rowCount: row.row_count as number } : undefined;
}

/** Ties a table to its Dataset item; a table that has a row keeps its item and takes the new row count. */
export function saveDatasetTable(
  db: SqlDriver,
  table: { itemId: number; sourceId: number; key: string; rowCount: number },
): void {
  db.run(
    `INSERT INTO dataset_tables (item_id, source_id, table_key, row_count) VALUES (?, ?, ?, ?)
     ON CONFLICT (source_id, table_key) DO UPDATE SET row_count = excluded.row_count`,
    [table.itemId, table.sourceId, table.key, table.rowCount],
  );
}
