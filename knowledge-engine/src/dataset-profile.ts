// The Dataset profile (S03-R6): the `dataset-profile` job turns a table source's version into registry rows.
// One `Dataset` item per table (the name is the source's title, and `title:sheet` for a workbook, always), a
// `dataset.column` fact per header cell whose evidence is that cell's span, and one `dataset_tables` row that
// ties the item to the table. The job reads the stored version through the table-reading port and nothing
// else: it calls no Provider (it has no Broker), so the extraction's 20,000 code point limit does not apply.
// The rows are written through `commitDerived` (the runner closes the job with these items): the version is
// the fence, so a result for a version a newer one replaced is not written. A table of the next version of
// the same source and key writes into the same Dataset item, whatever the title is by then (the name does not
// move once the item exists). Before anything is planned the item type and the fact kind are fitted to the
// type definitions (S01-R21): not `verified`, nothing is written.
import {
  addEvidence,
  automatedLifecycle,
  findDatasetTable,
  findSourceVersionId,
  insertItem,
  listOntologyElements,
  readAnalyticalMaxCells,
  readAnalyticalProfile,
  readSourceVersion,
  saveDatasetTable,
  saveFact,
  valueFits,
  type DerivedItem,
  type KnowledgeAttributes,
  type SourceVersionRef as LineageRef,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { sqlTabularSource, type Table, type TabularSource } from "./tabular-source.ts";

/** What the handler hands the runner (a subset of backend job-outcomes.ts JobResult). */
export type DatasetProfileResult =
  | { status: "succeeded"; items: readonly DerivedItem[] }
  | { status: "fail"; code: string; retryable: false };

export const DATASET_ITEM_TYPE = "Dataset";
export const DATASET_COLUMN_KIND = "dataset.column";
/** The registered derivative kind of `dataset_tables` rows (canonical-kinds.ts). */
export const DATASET_TABLE_ITEM_KIND = "analytical-check";

export interface DatasetProfileOptions {
  db: SqlDriver;
  /** The port the tables are read through; default the one that reads the stored version. */
  source?: TabularSource;
  now?: () => Date;
}

/** The name of the Dataset item: the title for a CSV, always `title:sheet` for a workbook. */
const datasetName = (title: string, key: string): string =>
  key === "" ? title : `${title}:${key}`;

/** The code points `[start, end)` of `body`. */
const slice = (body: string, start: number, end: number): string =>
  Array.from(body).slice(start, end).join("");

export function createDatasetProfileHandler(options: DatasetProfileOptions) {
  const { db } = options;
  const source = options.source ?? sqlTabularSource;
  const now = options.now ?? (() => new Date());

  return async (job: StoredJob): Promise<DatasetProfileResult> => {
    const { sourceId, fenceVersion } = job; // a profile job has both (schema v10 CHECK)
    const versionId =
      sourceId === null || fenceVersion === null
        ? undefined
        : findSourceVersionId(db, sourceId, fenceVersion);
    const stored = versionId === undefined ? undefined : readSourceVersion(db, versionId);
    if (versionId === undefined || !stored) {
      return { status: "fail", code: "missing-version", retryable: false };
    }
    // The switch is read now, not when the job was queued: a job left over from before the switch went OFF
    // (or a retry) writes nothing (dark launch, S03-R6)
    if (!readAnalyticalProfile(db)) return { status: "succeeded", items: [] };
    const own: LineageRef = { sourceId: sourceId as number, version: fenceVersion as number };
    const read = source.read(db, own, { maxCells: readAnalyticalMaxCells(db) });
    if (read === null) return { status: "succeeded", items: [] };

    // S01-R21: only verified definitions are written with
    const verified = listOntologyElements(db).filter((e) => e.status === "verified");
    const columnRule = verified.find(
      (e) => e.elementKind === "fact-kind" && e.name === DATASET_COLUMN_KIND,
    )?.rule;
    if (
      !verified.some((e) => e.elementKind === "item-type" && e.name === DATASET_ITEM_TYPE) ||
      columnRule?.elementKind !== "fact-kind" ||
      !columnRule.itemTypes.includes(DATASET_ITEM_TYPE)
    ) {
      return { status: "succeeded", items: [] };
    }

    const valueType = columnRule.valueType;
    const attributes = (): KnowledgeAttributes => ({
      epistemic: "explicit",
      status: "candidate",
      validAt: null,
      observedAt: now().toISOString(),
    });

    /** The items of one table: a fact per header cell, then the table's row. */
    const tableItems = (table: Table): DerivedItem[] => {
      // The Dataset item of this table: the one its source and key already stand for, else a new one. It
      // is made when the first row is written, once per commit (a closure lives for one commit).
      let datasetId: number | undefined;
      const datasetItem = (tx: SqlDriver): number => {
        if (datasetId !== undefined) return datasetId;
        const known = findDatasetTable(tx, own.sourceId, table.key);
        if (known) return (datasetId = known.itemId);
        const id = insertItem(tx, {
          type: DATASET_ITEM_TYPE,
          name: datasetName(stored.title, table.key),
          ...attributes(),
        });
        automatedLifecycle.created(
          tx,
          { kind: "item", id },
          "extraction",
          own,
          now().toISOString(),
        );
        return (datasetId = id);
      };
      const columns: DerivedItem[] = table.columns
        .filter((column) => valueFits(valueType, column.name))
        .map((column) => ({
          kind: "fact",
          itemKey: JSON.stringify(["dataset-column", own.sourceId, table.key, column.name]),
          lineage: [own],
          write: (tx) => {
            const at = now().toISOString();
            const saved = saveFact(tx, {
              itemId: datasetItem(tx),
              kind: DATASET_COLUMN_KIND,
              value: column.name,
              ...attributes(),
            });
            const row = { kind: "fact", id: saved.id } as const;
            if (saved.created) automatedLifecycle.created(tx, row, "extraction", own, at);
            addEvidence(tx, {
              target: { factId: saved.id },
              sourceVersionId: versionId,
              start: column.span.start,
              end: column.span.end,
              quote: slice(stored.body, column.span.start, column.span.end),
            });
            // the evidence just added is current (the fence held): a column propagation superseded returns
            automatedLifecycle.evidenceReturned(tx, row, own, at);
          },
        }));
      const tableRow: DerivedItem = {
        kind: DATASET_TABLE_ITEM_KIND,
        itemKey: JSON.stringify(["dataset-table", own.sourceId, table.key]),
        lineage: [own],
        write: (tx) =>
          saveDatasetTable(tx, {
            itemId: datasetItem(tx),
            sourceId: own.sourceId,
            key: table.key,
            rowCount: table.rowCount,
          }),
      };
      return [...columns, tableRow];
    };

    const written: DerivedItem[] = [];
    for (const entry of read.tables) {
      if (!("table" in entry)) continue; // no-header, no-rows, too-large: not a table (S03-R5)
      written.push(...tableItems(entry.table));
    }
    return { status: "succeeded", items: written };
  };
}
