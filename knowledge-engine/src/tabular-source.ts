// The table-reading port (S03-R4, R5): one place that turns a stored source version into
// tables. The implementation reads the version's body and blocks from the canonical store
// and nothing else: it opens no file and does not call `@pki/document-normalize` (I02 puts
// the version in the store). A version is a table source when its blocks carry a `csv` or
// `xlsx` locator. If I02 changes the block shape (the locator's fields, the separator
// between cells), this file is the one place to change.
import { BlockSchema, isDateText, isNumberText } from "@pki/contracts";
import type { SqlDriver } from "@pki/storage";
import { normalizeForLinking } from "./linking.ts";

/** The sheet's name in XLSX, "" for CSV (one table per file). */
export type TableKey = string;
export type NotTabular = "no-header" | "no-rows" | "too-large";

export interface TableColumn {
  /** The cell's column in the original: the field number of a CSV record, the column number of a sheet (both from 1). */
  index: number;
  /** The processed name (V02-R7: Unicode normalization, one case, white space collapsed). */
  name: string;
  /** The header cell's code points `[start, end)` in the body: the evidence for the column. */
  span: { start: number; end: number };
}

export interface Table {
  key: TableKey;
  columns: readonly TableColumn[];
  rowCount: number;
  /** Cells below the header outside its columns: not read, only counted. */
  cellsOutsideHeader: number;
  /** The data rows in the header's column order; an empty cell is `null`. */
  rows(): Iterable<readonly (string | null)[]>;
}

export type TableRead = { key: TableKey; table: Table } | { key: TableKey; reason: NotTabular };

export interface TabularRead {
  tables: readonly TableRead[];
  /** The version's limitation codes. They are the workbook's, not a sheet's (S03-R4). */
  limitations: readonly string[];
}

export interface TabularSource {
  /** `null` when the version is not a table source (no `csv` or `xlsx` block) or is not stored. */
  read(
    db: SqlDriver,
    ref: { sourceId: number; version: number },
    limits: { maxCells: number },
  ): TabularRead | null;
}

interface Cell {
  column: number;
  text: string;
  start: number;
  end: number;
}

/** UTF-16 offsets of the code points, so a block's range reads back from the body (I01-R7). */
function codePointReader(body: string): {
  length: number;
  text(start: number, end: number): string;
} {
  if (!/[\ud800-\udfff]/.test(body)) {
    return { length: body.length, text: (start, end) => body.slice(start, end) };
  }
  const offsets: number[] = [];
  for (let i = 0; i < body.length; i += (body.codePointAt(i) as number) > 0xffff ? 2 : 1) {
    offsets.push(i);
  }
  const length = offsets.length;
  offsets.push(body.length);
  return { length, text: (start, end) => body.slice(offsets[start], offsets[end]) };
}

const limitationCodes = (meta: string | null): string[] => {
  if (meta === null) return [];
  const found = (JSON.parse(meta) as { metadata?: { limitations?: unknown } } | null)?.metadata
    ?.limitations;
  return Array.isArray(found) ? found.filter((c): c is string => typeof c === "string") : [];
};

/** Rows of cells by sheet (CSV: one sheet, ""), from the blocks that carry a table position. */
function readGrids(
  body: string,
  blocks: readonly unknown[],
): Map<TableKey, Map<number, Cell[]>> | null {
  const reader = codePointReader(body);
  const grids = new Map<TableKey, Map<number, Cell[]>>();
  let format: "csv" | "xlsx" | undefined;
  for (const raw of blocks) {
    const parsed = BlockSchema.safeParse(raw);
    if (!parsed.success) continue;
    const { start, end, locator } = parsed.data;
    if (locator.format !== "csv" && locator.format !== "xlsx") continue;
    format ??= locator.format;
    if (locator.format !== format || start < 0 || start >= end || end > reader.length) continue;
    const key = locator.format === "csv" ? "" : locator.sheet;
    let rows = grids.get(key);
    if (!rows) grids.set(key, (rows = new Map()));
    // The sheet's own name is a block without a position: it only makes the sheet known.
    const [row, column] =
      locator.format === "csv" ? [locator.record, locator.field] : [locator.row, locator.column];
    if (row === undefined || column === undefined) continue;
    const cells = rows.get(row);
    const cell = { column, text: reader.text(start, end), start, end };
    if (cells) cells.push(cell);
    else rows.set(row, [cell]);
  }
  return format === undefined ? null : grids;
}

function tableOf(key: TableKey, rows: Map<number, Cell[]>, maxCells: number): TableRead {
  const ordered = [...rows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, cells]) => cells.sort((a, b) => a.column - b.column));
  const headerAt = ordered.findIndex((cells) => {
    if (cells.length < 2) return false;
    const seen = new Set(cells.map((c) => normalizeForLinking(c.text)));
    return (
      seen.size === cells.length && cells.every((c) => !isNumberText(c.text) && !isDateText(c.text))
    );
  });
  if (headerAt === -1) return { key, reason: "no-header" };
  const header = ordered[headerAt] as Cell[];
  const columns: TableColumn[] = header.map((c) => ({
    index: c.column,
    name: normalizeForLinking(c.text),
    span: { start: c.start, end: c.end },
  }));
  const position = new Map(header.map((c, i) => [c.column, i]));
  const data: Cell[][] = [];
  let outside = 0;
  for (const cells of ordered.slice(headerAt + 1)) {
    const inside = cells.filter((c) => position.has(c.column));
    outside += cells.length - inside.length;
    if (inside.length > 0) data.push(inside);
  }
  if (data.length === 0) return { key, reason: "no-rows" };
  // The grid counts the header row too.
  if (columns.length * (data.length + 1) > maxCells) return { key, reason: "too-large" };
  return {
    key,
    table: {
      key,
      columns,
      rowCount: data.length,
      cellsOutsideHeader: outside,
      *rows() {
        for (const cells of data) {
          const row: (string | null)[] = columns.map(() => null);
          for (const c of cells) row[position.get(c.column) as number] = c.text;
          yield row;
        }
      },
    },
  };
}

export const sqlTabularSource: TabularSource = {
  read(db, ref, limits) {
    const [stored] = db.all(
      "SELECT body, blocks, meta FROM source_versions WHERE source_id = ? AND version = ?",
      [ref.sourceId, ref.version],
    );
    if (!stored || typeof stored.blocks !== "string") return null;
    const blocks: unknown = JSON.parse(stored.blocks);
    if (!Array.isArray(blocks)) return null;
    const grids = readGrids(String(stored.body), blocks);
    if (grids === null) return null;
    return {
      tables: [...grids].map(([key, rows]) => tableOf(key, rows, limits.maxCells)),
      limitations: limitationCodes(typeof stored.meta === "string" ? stored.meta : null),
    };
  },
};
