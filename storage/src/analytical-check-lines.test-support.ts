// Test support (a `*.test-support.ts` file: refused in product code by lint and the bundle). Seeds the rows
// the analytical check lines and their staleness tests stand on: table sources, Dataset / Metric / Join items,
// their facts and path relations, and check lines. Rows are INSERTed at the given status with no history
// (an INSERT is not gated); a state change in a test goes through the lifecycle gate.
import { saveDatasetTable } from "./analytical.ts";
import { saveCheckLine, type CheckName } from "./analytical-check-lines.ts";
import {
  insertItem,
  saveFact,
  saveRelation,
  type KnowledgeAttributes,
  type KnowledgeStatus,
} from "./knowledge.ts";
import { findSourceVersionId, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";

export const csvBlocks = [
  { start: 0, end: 1, locator: { format: "csv", record: 1, line: 1, field: 1 } },
  { start: 2, end: 3, locator: { format: "csv", record: 1, line: 1, field: 2 } },
];

export const attrs = (status: KnowledgeStatus = "candidate"): KnowledgeAttributes => ({
  epistemic: "explicit",
  status,
  validAt: null,
  observedAt: "2026-11-23T00:00:00Z",
});

let counter = 0;

export interface Stored {
  sourceId: number;
  version: number;
  versionId: number;
}

/** A source (the connector instance `c1` must exist) with its next version; `tabular` gives csv blocks. */
export function storeVersion(db: SqlDriver, externalId: string, tabular = true): Stored {
  counter++;
  const saved = saveSourceRecord(db, "c1", {
    namespace: "",
    externalId,
    title: externalId,
    body: `a\tb ${counter}`,
    ...(tabular ? { blocks: csvBlocks } : {}),
  } as Parameters<typeof saveSourceRecord>[2]);
  if (saved.status !== "created") throw new Error(`not stored: ${saved.status}`);
  return {
    sourceId: saved.sourceId,
    version: saved.version,
    versionId: findSourceVersionId(db, saved.sourceId, saved.version) as number,
  };
}

export const item = (db: SqlDriver, type: string, name: string): number =>
  insertItem(db, { type, name, ...attrs() });

/** A Dataset item bound to the source by a `dataset_tables` row. */
export function dataset(db: SqlDriver, name: string, sourceId: number, key = ""): number {
  const id = item(db, "Dataset", name);
  saveDatasetTable(db, { itemId: id, sourceId, key, rowCount: 1 });
  return id;
}

export const fact = (
  db: SqlDriver,
  itemId: number,
  kind: string,
  value: string,
  status: KnowledgeStatus = "candidate",
): number => saveFact(db, { itemId, kind, value, ...attrs(status) }).id;

export const relation = (
  db: SqlDriver,
  subjectId: number,
  type: string,
  objectId: number,
  status: KnowledgeStatus = "candidate",
): number => saveRelation(db, { subjectId, type, objectId, ...attrs(status) }).id;

/** A passing check line of the fact, read from `versionId` (and `otherVersionId`). */
export function line(
  db: SqlDriver,
  factId: number,
  check: CheckName,
  versionId: number,
  otherVersionId: number | null = null,
): void {
  saveCheckLine(db, {
    factId,
    check,
    passed: true,
    failure: null,
    examined: 1,
    violations: 0,
    skipped: 0,
    versionId,
    otherVersionId,
    at: "2026-11-23T00:00:00.000Z",
  });
}

export const lineIds = (db: SqlDriver): string[] =>
  db
    .all("SELECT fact_id, check_name FROM analytical_checks ORDER BY fact_id, check_name")
    .map((r) => `${r.fact_id as number}:${r.check_name as string}`);
