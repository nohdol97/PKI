// The analytical semantic's storage (S03-R1, R6): the two settings, the test of a table version, the one place
// the `dataset-profile` job is registered, and the rows of `dataset_tables`. A Dataset is a registry item and
// its columns are facts (the registry's tables hold them); this file holds only what ties an item to a stored
// table. No cell of a table is read or kept here.
import { DATASET_PROFILE_KIND } from "./job-kinds.ts";
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
    return false;
  }
  return registerJob(db, {
    kind: DATASET_PROFILE_KIND,
    sourceId: version.sourceId,
    fenceVersion: version.version,
    at: version.at,
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
