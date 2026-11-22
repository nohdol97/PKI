// S03-T04 `profile.dataset` (the storage part, S03-R6): the settings `analytical.profile` (OFF by default,
// root 13-5) and `analytical.maxCells`, the test of a table version, the one place the `dataset-profile` job
// is registered (a new version while the setting is ON; the switch from OFF to ON for every table source's
// current version), and the rows of `dataset_tables`.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import {
  DEFAULT_MAX_CELLS,
  findDatasetTable,
  isTabularVersion,
  readAnalyticalMaxCells,
  readAnalyticalProfile,
  registerDatasetProfileJob,
  saveDatasetTable,
  setAnalyticalProfile,
} from "./analytical.ts";
import { DATASET_PROFILE_KIND } from "./job-kinds.ts";
import { insertItem } from "./knowledge.ts";
import { migrate } from "./migrations.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import { writeSetting } from "./settings.ts";
import type { SqlDriver } from "./sql-driver.ts";

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

const AT = new Date("2026-11-23T00:00:00.000Z");
const csvBlocks = [
  { start: 0, end: 1, locator: { format: "csv", record: 1, line: 1, field: 1 } },
  { start: 2, end: 3, locator: { format: "csv", record: 1, line: 1, field: 2 } },
];
const xlsxBlocks = [
  { start: 0, end: 1, locator: { format: "xlsx", sheet: "S", row: 1, column: 1 } },
];
const proseBlocks = [{ start: 0, end: 3, locator: { format: "markdown", line: 1, node: "p" } }];

function store(
  id: string,
  body: string,
  blocks?: unknown[],
): { sourceId: number; version: number } {
  const saved = saveSourceRecord(db, "c1", {
    namespace: "",
    externalId: id,
    title: id,
    body,
    ...(blocks ? { blocks } : {}),
  } as Parameters<typeof saveSourceRecord>[2]);
  if (saved.status !== "created") throw new Error(`not stored: ${saved.status}`);
  return { sourceId: saved.sourceId, version: saved.version };
}
const jobs = () =>
  db.all("SELECT kind, source_id, fence_version, status FROM jobs WHERE kind = ? ORDER BY id", [
    DATASET_PROFILE_KIND,
  ]);

describe("settings", () => {
  it("analytical.profile is OFF unless it says 'on'; analytical.maxCells defaults to 200,000", () => {
    expect(readAnalyticalProfile(db)).toBe(false);
    expect(readAnalyticalMaxCells(db)).toBe(DEFAULT_MAX_CELLS);
    expect(DEFAULT_MAX_CELLS).toBe(200_000);
    writeSetting(db, "analytical.profile", "on");
    expect(readAnalyticalProfile(db)).toBe(true);
    for (const other of ["off", "ON", "true", "1", ""]) {
      writeSetting(db, "analytical.profile", other);
      expect(readAnalyticalProfile(db), other).toBe(false);
    }
  });

  it("takes a whole number of cells of at least one, and the default for anything else", () => {
    writeSetting(db, "analytical.maxCells", "5000");
    expect(readAnalyticalMaxCells(db)).toBe(5000);
    for (const bad of ["0", "-3", "1.5", "abc", "", "1e3", "NaN"]) {
      writeSetting(db, "analytical.maxCells", bad);
      expect(readAnalyticalMaxCells(db), bad).toBe(DEFAULT_MAX_CELLS);
    }
  });
});

describe("isTabularVersion", () => {
  it("is true for a csv or xlsx block and false for prose, no blocks and a version that is not stored", () => {
    const csv = store("a", "a\tb", csvBlocks);
    const xlsx = store("b", "a", xlsxBlocks);
    const prose = store("c", "abc", proseBlocks);
    const none = store("d", "abc");
    expect(isTabularVersion(db, csv.sourceId, csv.version)).toBe(true);
    expect(isTabularVersion(db, xlsx.sourceId, xlsx.version)).toBe(true);
    expect(isTabularVersion(db, prose.sourceId, prose.version)).toBe(false);
    expect(isTabularVersion(db, none.sourceId, none.version)).toBe(false);
    expect(isTabularVersion(db, csv.sourceId, 99)).toBe(false);
  });
});

describe("registerDatasetProfileJob: a new version", () => {
  it("registers nothing while the setting is OFF (the default), for a table version too", () => {
    const ref = store("a", "a\tb", csvBlocks);
    expect(registerDatasetProfileJob(db, { ...ref, at: AT })).toBe(false);
    expect(jobs()).toEqual([]);
  });

  it("registers one job for a table version while ON, fenced to that version, and none for prose", () => {
    writeSetting(db, "analytical.profile", "on");
    const csv = store("a", "a\tb", csvBlocks);
    const prose = store("c", "abc", proseBlocks);
    expect(registerDatasetProfileJob(db, { ...csv, at: AT })).toBe(true);
    expect(registerDatasetProfileJob(db, { ...prose, at: AT })).toBe(false);
    expect(jobs()).toEqual([
      {
        kind: DATASET_PROFILE_KIND,
        source_id: csv.sourceId,
        fence_version: csv.version,
        status: "queued",
      },
    ]);
    // the same version again is no second job and no error
    expect(registerDatasetProfileJob(db, { ...csv, at: AT })).toBe(false);
    expect(jobs()).toHaveLength(1);
  });
});

describe("setAnalyticalProfile: the switch", () => {
  const seedAll = () => {
    const a = store("a", "a\tb", csvBlocks);
    const b = store("b", "a", xlsxBlocks);
    const prose = store("c", "abc", proseBlocks);
    // a table source with two versions: only the current one is queued
    store("d", "a\tb", csvBlocks);
    const d2 = store("d", "a\tb ", csvBlocks);
    return { a, b, prose, d2 };
  };

  it("OFF to ON queues one job on the current version of each table source and none otherwise", () => {
    const { a, b, d2 } = seedAll();
    expect(setAnalyticalProfile(db, true, AT)).toEqual({ profile: true, queued: 3 });
    expect(jobs().map((j) => [j.source_id, j.fence_version])).toEqual([
      [a.sourceId, a.version],
      [b.sourceId, b.version],
      [d2.sourceId, d2.version],
    ]);
    expect(readAnalyticalProfile(db)).toBe(true);
  });

  it("ON to ON queues nothing, and OFF stores the setting and queues nothing", () => {
    seedAll();
    setAnalyticalProfile(db, true, AT);
    const before = jobs();
    expect(setAnalyticalProfile(db, true, AT)).toEqual({ profile: true, queued: 0 });
    expect(jobs()).toEqual(before);
    // jobs the retention purged are no reason to queue again: a switch already ON is no switch
    db.run("DELETE FROM jobs");
    expect(setAnalyticalProfile(db, true, AT)).toEqual({ profile: true, queued: 0 });
    expect(jobs()).toEqual([]);
    expect(setAnalyticalProfile(db, false, AT)).toEqual({ profile: false, queued: 0 });
    expect(readAnalyticalProfile(db)).toBe(false);
    expect(jobs()).toEqual([]);
  });

  it("turning it ON again after a new version arrived while OFF queues that version only", () => {
    const a = store("a", "a\tb", csvBlocks);
    setAnalyticalProfile(db, true, AT);
    setAnalyticalProfile(db, false, AT);
    const next = store("a", "a\tc", csvBlocks);
    expect(registerDatasetProfileJob(db, { ...next, at: AT })).toBe(false); // OFF
    expect(setAnalyticalProfile(db, true, AT)).toEqual({ profile: true, queued: 1 });
    expect(jobs().map((j) => [j.source_id, j.fence_version])).toEqual([
      [a.sourceId, a.version],
      [next.sourceId, next.version],
    ]);
  });

  it("does not queue a source a tombstone covers", () => {
    const a = store("a", "a\tb", csvBlocks);
    db.run(
      "INSERT INTO tombstones (source_id, covers_version, at, reason) VALUES (?, ?, 't', 'user-deleted')",
      [a.sourceId, a.version],
    );
    expect(setAnalyticalProfile(db, true, AT)).toEqual({ profile: true, queued: 0 });
    expect(jobs()).toEqual([]);
  });
});

describe("dataset_tables rows", () => {
  const attrs = {
    epistemic: "explicit",
    status: "candidate",
    validAt: null,
    observedAt: "t",
  } as const;

  it("saves one row per (source, key) and reads it back; a second save updates the row count", () => {
    const ref = store("a", "a\tb", csvBlocks);
    const item = insertItem(db, { type: "Dataset", name: "a", ...attrs });
    saveDatasetTable(db, { itemId: item, sourceId: ref.sourceId, key: "", rowCount: 3 });
    expect(findDatasetTable(db, ref.sourceId, "")).toEqual({ itemId: item, rowCount: 3 });
    saveDatasetTable(db, { itemId: item, sourceId: ref.sourceId, key: "", rowCount: 5 });
    expect(findDatasetTable(db, ref.sourceId, "")).toEqual({ itemId: item, rowCount: 5 });
    expect(db.all("SELECT count(*) AS n FROM dataset_tables")[0]?.n).toBe(1);
    expect(findDatasetTable(db, ref.sourceId, "Sheet2")).toBeUndefined();
  });
});
