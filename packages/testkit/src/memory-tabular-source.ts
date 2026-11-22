// Test double of the table-reading port: versions held in a map, no store, no SQL.
// It applies S03-R5 to the same stored shape (body, blocks, limitation codes) the real
// source reads, written on its own (a flat list of cells, not the real source's grid), so
// the contract suite can tell the two apart if one drifts.
import { isDateText, isNumberText } from "@pki/contracts";
import type {
  ContractColumn,
  ContractTabularRead,
  ContractTabularSource,
  ContractVersionRef,
  StoredTableVersion,
} from "./tabular.contract.ts";

interface FlatCell {
  sheet: string;
  row: number;
  column: number;
  text: string;
  start: number;
  end: number;
}

/** V02-R7: Unicode normalization, one case, collapsed white space. */
const processed = (text: string): string =>
  text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();

interface Locator {
  format?: string;
  sheet?: string;
  record?: number;
  field?: number;
  row?: number;
  column?: number;
}

export class MemoryTabularSource implements ContractTabularSource<unknown> {
  readonly #versions = new Map<string, StoredTableVersion>();
  #sourceId = 0;

  /** Holds a version as the next source's first version and returns the ref to read it by. */
  put(version: StoredTableVersion): ContractVersionRef {
    const ref = { sourceId: ++this.#sourceId, version: 1 };
    this.#versions.set(`${ref.sourceId}/${ref.version}`, version);
    return ref;
  }

  read(
    _db: unknown,
    ref: ContractVersionRef,
    limits: { maxCells: number },
  ): ContractTabularRead | null {
    const stored = this.#versions.get(`${ref.sourceId}/${ref.version}`);
    if (!stored?.blocks) return null;
    const points = Array.from(stored.body);
    const sheets: string[] = [];
    const cells: FlatCell[] = [];
    let format: string | undefined;
    for (const block of stored.blocks as { start: number; end: number; locator: Locator }[]) {
      const { locator } = block;
      if (locator.format !== "csv" && locator.format !== "xlsx") continue;
      format ??= locator.format;
      if (locator.format !== format) continue;
      const sheet = format === "csv" ? "" : (locator.sheet as string);
      if (!sheets.includes(sheet)) sheets.push(sheet);
      const row = format === "csv" ? locator.record : locator.row;
      const column = format === "csv" ? locator.field : locator.column;
      if (row === undefined || column === undefined) continue;
      cells.push({
        sheet,
        row,
        column,
        text: points.slice(block.start, block.end).join(""),
        start: block.start,
        end: block.end,
      });
    }
    if (format === undefined) return null;
    return {
      tables: sheets.map((sheet) =>
        this.#table(
          sheet,
          cells.filter((c) => c.sheet === sheet),
          limits,
        ),
      ),
      limitations: [...stored.limitations],
    };
  }

  #table(sheet: string, cells: readonly FlatCell[], limits: { maxCells: number }) {
    const rowNumbers = [...new Set(cells.map((c) => c.row))].sort((a, b) => a - b);
    const inRow = (row: number) =>
      cells.filter((c) => c.row === row).sort((a, b) => a.column - b.column);
    // The first row with two values is the only header candidate; if it fails, no header.
    const headerRow = rowNumbers.find((row) => inRow(row).length >= 2);
    const candidate = headerRow === undefined ? [] : inRow(headerRow);
    const isHeader =
      new Set(candidate.map((c) => processed(c.text))).size === candidate.length &&
      candidate.every((c) => !isNumberText(c.text) && !isDateText(c.text));
    if (headerRow === undefined || !isHeader) return { key: sheet, reason: "no-header" };
    const header = inRow(headerRow);
    const columns: ContractColumn[] = header.map((c) => ({
      index: c.column,
      name: processed(c.text),
      span: { start: c.start, end: c.end },
    }));
    const headerColumns = header.map((c) => c.column);
    const below = cells.filter((c) => c.row > headerRow);
    const dataRows = rowNumbers.filter(
      (row) =>
        row > headerRow && below.some((c) => c.row === row && headerColumns.includes(c.column)),
    );
    if (dataRows.length === 0) return { key: sheet, reason: "no-rows" };
    if (columns.length * (dataRows.length + 1) > limits.maxCells) {
      return { key: sheet, reason: "too-large" };
    }
    return {
      key: sheet,
      table: {
        key: sheet,
        columns,
        rowCount: dataRows.length,
        cellsOutsideHeader: below.filter((c) => !headerColumns.includes(c.column)).length,
        rows: () =>
          dataRows.map((row) =>
            headerColumns.map(
              (column) => cells.find((c) => c.row === row && c.column === column)?.text ?? null,
            ),
          ),
      },
    };
  }
}
