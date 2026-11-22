// S03-C1 `tabular.contract` (S03-R4, R5): what every TabularSource must answer for the
// same stored version. The real source reads a stored version's body and blocks; the
// memory double (memory-tabular-source.ts) holds the versions in a map. Both run this
// suite, so they cannot drift apart. testkit does not depend on knowledge-engine or
// storage, so the port's shape the suite reads is declared here; a source that no
// longer fits it fails to typecheck at the call site.
// The inputs are versions a caller built from the fixtures in fixtures/documents/ with
// `@pki/document-normalize` (testkit does not depend on it either); the suite names
// the ones it needs in TABULAR_CONTRACT_FIXTURES and checks that each is given.
import { describe, expect, it } from "vitest";

export interface ContractVersionRef {
  sourceId: number;
  version: number;
}

/** What a version holds that the port reads: the body, the blocks and the limitation codes. */
export interface StoredTableVersion {
  body: string;
  blocks: readonly unknown[] | null;
  limitations: readonly string[];
}

export interface ContractColumn {
  index: number;
  name: string;
  span: { start: number; end: number };
}

export interface ContractTable {
  key: string;
  columns: readonly ContractColumn[];
  rowCount: number;
  cellsOutsideHeader: number;
  rows(): Iterable<readonly (string | null)[]>;
}

export type ContractTableRead =
  { key: string; table: ContractTable } | { key: string; reason: string };

export interface ContractTabularRead {
  tables: readonly ContractTableRead[];
  limitations: readonly string[];
}

/** What the suite reads of a TabularSource (the real port's `Db` is the SQL driver). */
export interface ContractTabularSource<Db> {
  read(db: Db, ref: ContractVersionRef, limits: { maxCells: number }): ContractTabularRead | null;
}

export interface TabularContractHarness<Db> {
  db: Db;
  source: ContractTabularSource<Db>;
  /** Puts a version where the source finds it; the ref it is read by. */
  store(version: StoredTableVersion): ContractVersionRef;
  close(): void;
}

/** The fixtures (fixtures/documents/) the suite reads, normalized, by file name. */
export const TABULAR_CONTRACT_FIXTURES = [
  "table-csv-blank-cells.csv",
  "table-csv-title-above.csv",
  "table-csv-number-first-row.csv",
  "table-csv-padded-number-first-row.csv",
  "table-csv-date-first-row.csv",
  "table-csv-duplicate-header.csv",
  "table-csv-no-rows.csv",
  "table-xlsx-two-sheets.xlsx",
  "table-xlsx-hidden-sheet.xlsx",
  "normal-pdf.pdf",
  "normal-markdown.md",
] as const;
export type TabularContractFixture = (typeof TABULAR_CONTRACT_FIXTURES)[number];

const LIMITS = { maxCells: 200_000 };

/** The text of the code point range `[start, end)`. */
function slice(body: string, start: number, end: number): string {
  return Array.from(body).slice(start, end).join("");
}

/** A CSV version built by hand: `rows[r][f]` is record r+1, field f+1; "" makes no block. */
export function csvVersion(rows: readonly (readonly string[])[]): StoredTableVersion {
  let body = "";
  let length = 0;
  const blocks: unknown[] = [];
  rows.forEach((record, r) => {
    let first = true;
    record.forEach((field, f) => {
      if (field.trim() === "") return;
      if (blocks.length > 0) {
        body += first ? "\n" : "\t";
        length += 1;
      }
      first = false;
      const start = length;
      body += field;
      length += Array.from(field).length;
      blocks.push({
        start,
        end: length,
        locator: { format: "csv", record: r + 1, line: r + 1, field: f + 1 },
      });
    });
  });
  return { body, blocks, limitations: [] };
}

function tableOf(read: ContractTabularRead | null, key: string): ContractTable {
  const found = read?.tables.find((t) => t.key === key);
  if (!found || !("table" in found)) throw new Error(`no table "${key}": ${JSON.stringify(found)}`);
  return found.table;
}

const reasonOf = (read: ContractTabularRead | null, key: string): string | undefined => {
  const found = read?.tables.find((t) => t.key === key);
  return found && "reason" in found ? found.reason : undefined;
};

const names = (table: ContractTable) => table.columns.map((c) => c.name);
const rowsOf = (table: ContractTable) => [...table.rows()].map((row) => [...row]);

export function tabularContract<Db>(
  label: string,
  open: () => TabularContractHarness<Db>,
  fixtures: Readonly<Record<TabularContractFixture, StoredTableVersion>>,
): void {
  describe(`tabular.contract: ${label}`, () => {
    const run = (
      input: StoredTableVersion,
      limits: { maxCells: number } = LIMITS,
    ): ContractTabularRead | null => {
      const h = open();
      try {
        return h.source.read(h.db, h.store(input), limits);
      } finally {
        h.close();
      }
    };

    it("is given every fixture the suite names", () => {
      expect(Object.keys(fixtures).sort()).toEqual([...TABULAR_CONTRACT_FIXTURES].sort());
    });

    it("reads a CSV's header, blank cells in place, and counts the cells outside the header", () => {
      const read = run(fixtures["table-csv-blank-cells.csv"]);
      expect(read?.tables.map((t) => t.key)).toEqual([""]);
      const table = tableOf(read, "");
      expect(names(table)).toEqual(["이름", "수량", "비고"]);
      expect(table.columns.map((c) => c.index)).toEqual([1, 2, 3]);
      expect(table.rowCount).toBe(4);
      expect(table.cellsOutsideHeader).toBe(1);
      expect(rowsOf(table)).toEqual([
        ["사과", "3", "😀"],
        ["배", null, "메모"],
        ["귤", "7", null],
        ["감", "2", null],
      ]);
      expect(rowsOf(table)).toEqual(rowsOf(table));
      // the fixture's last record is wider than the first: I02-A's note travels with the read
      expect(read?.limitations).toEqual(["csv.ragged-rows"]);
    });

    it("gives each header cell's span, which is that text in the body", () => {
      const version = fixtures["table-csv-blank-cells.csv"];
      const table = tableOf(run(version), "");
      expect(table.columns.map((c) => slice(version.body, c.span.start, c.span.end))).toEqual([
        "이름",
        "수량",
        "비고",
      ]);
    });

    it("drops the one-cell title row above the header", () => {
      const table = tableOf(run(fixtures["table-csv-title-above.csv"]), "");
      expect(names(table)).toEqual(["이름", "수량"]);
      expect(table.rowCount).toBe(2);
      expect(rowsOf(table)).toEqual([
        ["사과", "3"],
        ["배", "5"],
      ]);
    });

    it("makes one table per sheet, spans counted in code points after a title with an emoji", () => {
      const version = fixtures["table-xlsx-two-sheets.xlsx"];
      const read = run(version);
      expect(read?.tables.map((t) => t.key)).toEqual(["매출", "재고"]);
      const sales = tableOf(read, "매출");
      expect(names(sales)).toEqual(["월", "금액", "메모"]);
      expect(sales.columns.map((c) => slice(version.body, c.span.start, c.span.end))).toEqual([
        "월",
        "금액",
        "메모",
      ]);
      expect(rowsOf(sales)).toEqual([
        ["1월", "1000", null],
        ["2월", "2000.5", "한글 😀 뒤"],
      ]);
      const stock = tableOf(read, "재고");
      expect(names(stock)).toEqual(["품목", "수량"]);
      expect(rowsOf(stock)).toEqual([["사과", "3"]]);
    });

    it("carries the workbook's limitation codes and reads a hidden sheet as a table too", () => {
      const read = run(fixtures["table-xlsx-hidden-sheet.xlsx"]);
      expect(read?.limitations).toEqual(["xlsx.hidden-sheet"]);
      expect(read?.tables.map((t) => t.key)).toEqual(["공개", "숨김"]);
      expect(names(tableOf(read, "숨김"))).toEqual(["코드", "설명"]);
      expect(rowsOf(tableOf(read, "숨김"))).toEqual([["x", "y"]]);
    });

    it.each([
      ["a first row of numbers", "table-csv-number-first-row.csv"],
      ["a CSV number with padding (` 42`)", "table-csv-padded-number-first-row.csv"],
      ["a CSV date in the first row", "table-csv-date-first-row.csv"],
      ["header names equal after processing", "table-csv-duplicate-header.csv"],
    ] as const)("is not a table with no header: %s", (_what, name) => {
      expect(reasonOf(run(fixtures[name]), "")).toBe("no-header");
    });

    it.each([
      [
        "a duplicate name after processing, text rows below",
        [
          ["Amount", "amount"],
          ["foo", "bar"],
          ["1", "2"],
        ],
      ],
      [
        "a first row of numbers, text rows below",
        [
          ["1", "2"],
          ["사과", "배"],
        ],
      ],
      [
        "a padded number in the first row, text rows below",
        [
          ["이름", " 42"],
          ["가", "나"],
        ],
      ],
    ] as const)("the first row with two values is the only header candidate: %s", (_what, rows) => {
      expect(reasonOf(run(csvVersion(rows)), "")).toBe("no-header");
    });

    it("is not a table with no data row", () => {
      expect(reasonOf(run(fixtures["table-csv-no-rows.csv"]), "")).toBe("no-rows");
    });

    it("is too large one cell over the limit, and a table at the limit", () => {
      // 3 columns x (1 header row + 4 data rows)
      const version = fixtures["table-csv-blank-cells.csv"];
      expect(names(tableOf(run(version, { maxCells: 15 }), ""))).toEqual(["이름", "수량", "비고"]);
      expect(reasonOf(run(version, { maxCells: 14 }), "")).toBe("too-large");
    });

    it("answers null for a version that is not a table source", () => {
      expect(run(fixtures["normal-pdf.pdf"])).toBeNull();
      expect(run(fixtures["normal-markdown.md"])).toBeNull();
      expect(run({ body: "a\nb", blocks: null, limitations: [] })).toBeNull();
      expect(
        run({
          body: "a\nb",
          blocks: [{ start: 0, end: 1, locator: { format: "txt", line: 1 } }],
          limitations: [],
        }),
      ).toBeNull();
    });

    it("answers null for a version the store does not hold", () => {
      const h = open();
      try {
        h.store(csvVersion([["a", "b"]]));
        expect(h.source.read(h.db, { sourceId: 9999, version: 1 }, LIMITS)).toBeNull();
      } finally {
        h.close();
      }
    });

    it("processes the column names (case, width, white space) and keeps them apart when different", () => {
      const read = run(
        csvVersion([
          ["Amount", " ＱＴＹ  Total "],
          ["1", "2"],
        ]),
      );
      expect(names(tableOf(read, ""))).toEqual(["amount", "qty total"]);
    });

    it("does not read a cell below a blank header cell, and counts it", () => {
      const table = tableOf(
        run(
          csvVersion([
            ["이름", "", "수량"],
            ["사과", "x", "3"],
            ["", "y", ""],
          ]),
        ),
        "",
      );
      expect(table.columns.map((c) => c.index)).toEqual([1, 3]);
      expect(table.cellsOutsideHeader).toBe(2);
      expect(table.rowCount).toBe(1);
      expect(rowsOf(table)).toEqual([["사과", "3"]]);
    });

    it("skips rows with no value in the header's columns", () => {
      const table = tableOf(
        run(
          csvVersion([
            ["a", "b"],
            ["", ""],
            ["1x", ""],
            ["", ""],
            ["", "2y"],
          ]),
        ),
        "",
      );
      expect(rowsOf(table)).toEqual([
        ["1x", null],
        [null, "2y"],
      ]);
    });
  });
}
