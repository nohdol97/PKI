// I02A-C1 (XLSX), C2 (XLSX), C6 (XLSX corrupt), C8 (XLSX metadata), C9 (XLSX limitation codes).
import { unzipSync, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { resolveLimits } from "../limits.ts";
import { buildXlsx, buildZip } from "../testing/ooxml-builder.ts";
import type { XlsxSpec } from "../testing/ooxml-builder.ts";
import { codePointLength, codePointSlice } from "../text-builder.ts";
import type { Block, FormatResult, ParsedDocument } from "../types.ts";
import { xlsxModule } from "./xlsx.ts";

const excelSpy = vi.hoisted(() => vi.fn());
vi.mock("read-excel-file/universal", async (importOriginal) => {
  const actual = await importOriginal<{ default: unknown }>();
  excelSpy.mockImplementation(actual.default as never);
  return { ...actual, default: excelSpy };
});

async function parse(spec: XlsxSpec): Promise<ParsedDocument> {
  const result: FormatResult = await xlsxModule.parse(buildXlsx(spec), resolveLimits());
  if (!result.ok) throw new Error(`unexpected failure ${JSON.stringify(result.error)}`);
  return result.value;
}
const slices = (doc: ParsedDocument) =>
  doc.blocks.map((b) => codePointSlice(doc.text, b.start, b.end));

describe("C1 sheets, cells and locators", () => {
  const spec: XlsxSpec = {
    sheets: [
      {
        name: "매출",
        rows: [
          ["이름", "점수"],
          ["가나다 😀", 90.5],
          [null, true],
        ],
      },
      { name: "Sheet2", rows: [["x"]] },
    ],
  };

  it("puts the sheet name first, then value cells; tabs within a row, newlines between rows, a blank line between sheets", async () => {
    const doc = await parse(spec);
    expect(doc.text).toBe("매출\n이름\t점수\n가나다 😀\t90.5\nTRUE\n\nSheet2\nx");
    expect(slices(doc)).toEqual([
      "매출",
      "이름",
      "점수",
      "가나다 😀",
      "90.5",
      "TRUE",
      "Sheet2",
      "x",
    ]);
    expect(doc.blocks.map((b) => b.locator)).toEqual([
      { format: "xlsx", sheet: "매출" },
      { format: "xlsx", sheet: "매출", cell: "A1", row: 1, column: 1 },
      { format: "xlsx", sheet: "매출", cell: "B1", row: 1, column: 2 },
      { format: "xlsx", sheet: "매출", cell: "A2", row: 2, column: 1 },
      { format: "xlsx", sheet: "매출", cell: "B2", row: 2, column: 2 },
      { format: "xlsx", sheet: "매출", cell: "B3", row: 3, column: 2 },
      { format: "xlsx", sheet: "Sheet2" },
      { format: "xlsx", sheet: "Sheet2", cell: "A1", row: 1, column: 1 },
    ]);
  });

  it("addresses cells by their true row and column when the sheet starts at C3 or goes past Z", async () => {
    const wide = Array.from({ length: 53 }, () => null) as (string | null)[];
    wide[25] = "Z열";
    wide[26] = "AA열";
    wide[51] = "AZ열";
    wide[52] = "BA열";
    const doc = await parse({
      sheets: [{ name: "s", rows: [[], [], [null, null, "C3값"], wide] }],
    });
    expect(doc.blocks.slice(1).map((b) => b.locator)).toEqual([
      { format: "xlsx", sheet: "s", cell: "C3", row: 3, column: 3 },
      { format: "xlsx", sheet: "s", cell: "Z4", row: 4, column: 26 },
      { format: "xlsx", sheet: "s", cell: "AA4", row: 4, column: 27 },
      { format: "xlsx", sheet: "s", cell: "AZ4", row: 4, column: 52 },
      { format: "xlsx", sheet: "s", cell: "BA4", row: 4, column: 53 },
    ]);
    expect(slices(doc)).toEqual(["s", "C3값", "Z열", "AA열", "AZ열", "BA열"]);
  });

  it("formats values: strings verbatim, numbers by JS default, booleans, dates as ISO-8601, formulas by cached value", async () => {
    const doc = await parse({
      sheets: [
        {
          name: "v",
          rows: [
            ["  공백  ", 0.1 + 0.2, 1e21, false],
            [
              new Date("2026-03-01T00:00:00Z"),
              { formula: "SUM(B1:C1)", value: 6 },
              { formula: "A1", value: "텍스트" },
            ],
          ],
        },
      ],
    });
    expect(slices(doc)).toEqual([
      "v",
      "  공백  ",
      "0.30000000000000004",
      "1e+21",
      "FALSE",
      "2026-03-01T00:00:00.000Z",
      "6",
      "텍스트",
    ]);
  });

  it("empty cells and empty strings make neither a block nor a line", async () => {
    const doc = await parse({
      sheets: [
        {
          name: "s",
          rows: [
            ["", null, "끝"],
            [null, ""],
          ],
        },
      ],
    });
    expect(doc.text).toBe("s\n끝");
  });

  it("a sheet with no values still gets its name block", async () => {
    const doc = await parse({
      sheets: [
        { name: "빈 시트", rows: [] },
        { name: "둘째", rows: [["x"]] },
      ],
    });
    expect(doc.text).toBe("빈 시트\n\n둘째\nx");
  });

  it("blocks are ordered, disjoint, in range", async () => {
    const doc = await parse(spec);
    const total = codePointLength(doc.text);
    let end = 0;
    for (const block of doc.blocks) {
      expect(block.start).toBeGreaterThanOrEqual(end);
      expect(block.end).toBeGreaterThan(block.start);
      end = block.end;
    }
    expect(end).toBeLessThanOrEqual(total);
  });

  it("is deterministic", async () => {
    expect(await parse(spec)).toEqual(await parse(spec));
  });
});

describe("C2 code point positions", () => {
  it("a Korean and emoji cell shifts later blocks away from their UTF-16 positions", async () => {
    const doc = await parse({
      sheets: [{ name: "한글😀", rows: [["가😀나", "다é라"], ["마"]] }],
    });
    expect(slices(doc)).toEqual(["한글😀", "가😀나", "다é라", "마"]);
    const last = doc.blocks[3] as Block;
    const utf16 = doc.text.indexOf("마");
    expect(utf16).toBeGreaterThan(last.start);
    expect(utf16 - last.start).toBe(2); // the two emoji, each one code point but two UTF-16 units
    expect(codePointSlice(doc.text, last.start, last.end)).toBe("마");
  });
});

describe("C8 metadata", () => {
  it("lists sheet names in workbook order and reads core properties", async () => {
    const doc = await parse({
      sheets: [
        { name: "첫째", rows: [["a"]] },
        { name: "둘째", rows: [["b"]] },
      ],
      core: {
        title: "표",
        author: "작성자",
        created: "2026-01-02T03:04:05Z",
        modified: "2026-01-03T00:00:00Z",
      },
    });
    expect(doc.metadata).toEqual({
      title: "표",
      author: "작성자",
      created: "2026-01-02T03:04:05.000Z",
      modified: "2026-01-03T00:00:00.000Z",
      sheetNames: ["첫째", "둘째"],
    });
  });

  it("without core properties only the sheet names are present", async () => {
    const doc = await parse({ sheets: [{ name: "s", rows: [["a"]] }] });
    expect(doc.metadata).toEqual({ sheetNames: ["s"] });
  });
});

describe("C9 limitation codes", () => {
  const codes = async (spec: XlsxSpec) => (await parse(spec)).limitations.map((l) => l.code);

  it("none for a plain workbook", async () => {
    expect(await codes({ sheets: [{ name: "s", rows: [["a", 1]] }] })).toEqual([]);
  });
  it("xlsx.formula-cached-value", async () => {
    expect(
      await codes({ sheets: [{ name: "s", rows: [[{ formula: "1+2", value: 3 }]] }] }),
    ).toEqual(["xlsx.formula-cached-value"]);
  });
  it("xlsx.merged-cells", async () => {
    expect(await codes({ sheets: [{ name: "s", rows: [["a"]], merges: ["A1:B1"] }] })).toEqual([
      "xlsx.merged-cells",
    ]);
  });
  it("xlsx.hidden-sheet, and the hidden sheet is still in the text", async () => {
    const spec: XlsxSpec = {
      sheets: [
        { name: "보임", rows: [["a"]] },
        { name: "숨김", rows: [["비밀 아님"]], hidden: true },
      ],
    };
    expect(await codes(spec)).toEqual(["xlsx.hidden-sheet"]);
    expect((await parse(spec)).text).toContain("비밀 아님");
    const veryHidden = { sheets: [{ name: "s", rows: [["a"]], hidden: "veryHidden" as const }] };
    expect(await codes(veryHidden)).toEqual(["xlsx.hidden-sheet"]);
  });
  it("a conditional-format <formula> and an empty <mergeCells/> do not trigger the codes", async () => {
    const sheet =
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData><mergeCells count="0"/>' +
      '<conditionalFormatting sqref="A1"><cfRule type="expression" priority="1"><formula>A1&gt;1</formula></cfRule></conditionalFormatting></worksheet>';
    const files = unzipSync(buildXlsx({ sheets: [{ name: "s", rows: [["a"]] }] }));
    files["xl/worksheets/sheet1.xml"] = new TextEncoder().encode(sheet);
    const result = await xlsxModule.parse(zipSync(files), resolveLimits());
    expect(result.ok && result.value.limitations).toEqual([]);
  });
  it("a sheet named like a formula or merge tag does not trigger the codes", async () => {
    expect(await codes({ sheets: [{ name: "f mergeCell", rows: [["<f> <mergeCell "]] }] })).toEqual(
      [],
    );
  });
});

describe("C6 damaged input", () => {
  it("a ZIP without xl/workbook.xml is format-mismatch and read-excel-file is not called", async () => {
    excelSpy.mockClear();
    const result = await xlsxModule.parse(
      buildZip([{ name: "word/document.xml", data: "<x/>" }]),
      resolveLimits(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("format-mismatch");
    expect(excelSpy).not.toHaveBeenCalled();
  });

  it("a broken workbook is corrupt, never a rejection", async () => {
    const result = await xlsxModule.parse(
      buildZip([{ name: "xl/workbook.xml", data: "<<< not xml" }]),
      resolveLimits(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("corrupt");
  });
});

describe("B4 document-derived text stays out of failures", () => {
  it("a cell reference and a part name carrying a marker never reach message or detail", async () => {
    const files = unzipSync(buildXlsx({ sheets: [{ name: "S1", rows: [["a"]] }] }));
    const name = Object.keys(files).find((n) => n.startsWith("xl/worksheets/")) as string;
    files[name] = new TextEncoder().encode(
      new TextDecoder().decode(files[name]).replace(/r="A1"/, 'r="SECRETMARK_cell"'),
    );
    const result = await xlsxModule.parse(zipSync(files), resolveLimits());
    expect(JSON.stringify(result.ok ? {} : result.error)).not.toContain("SECRETMARK");
  });

  it("a rejecting parser keeps its message out of the result", async () => {
    excelSpy.mockRejectedValueOnce(new RangeError("SECRETMARK_msg"));
    const result = await xlsxModule.parse(
      buildXlsx({ sheets: [{ name: "S", rows: [["a"]] }] }),
      resolveLimits(),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "corrupt", detail: { cause: "RangeError" } },
    });
    expect(JSON.stringify(result)).not.toContain("SECRETMARK_msg");
  });
});

describe("A4 the parser reads the re-zipped archive", () => {
  it("read-excel-file is handed the guard's archive, not the original bytes", async () => {
    const original = buildXlsx({ sheets: [{ name: "S", rows: [["x"]] }] });
    await xlsxModule.parse(original, resolveLimits());
    const handed = excelSpy.mock.calls.at(-1)?.[0] as Uint8Array;
    expect(Buffer.from(handed).equals(Buffer.from(original))).toBe(false);
    expect(Object.keys(unzipSync(handed)).sort()).toEqual(Object.keys(unzipSync(original)).sort());
  });
});

describe("B1 limitation scans stay linear on hostile XML", () => {
  const withWorkbook = (mutate: (xml: string) => string) => {
    const files = unzipSync(buildXlsx({ sheets: [{ name: "S1", rows: [["a"]], hidden: true }] }));
    files["xl/workbook.xml"] = new TextEncoder().encode(
      mutate(new TextDecoder().decode(files["xl/workbook.xml"])),
    );
    return zipSync(files);
  };

  it("a workbook comment repeating `<sheet ` without `>` finishes fast", async () => {
    const bytes = withWorkbook((xml) =>
      xml.replace("<sheets>", `<!-- ${"<sheet ".repeat(50_000)} --><sheets>`),
    );
    const started = Date.now();
    const result = await xlsxModule.parse(bytes, resolveLimits());
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.ok && result.value.limitations.map((l) => l.code)).toContain("xlsx.hidden-sheet");
  });

  it("a hidden sheet mentioned only inside a comment is not reported", async () => {
    const files = unzipSync(buildXlsx({ sheets: [{ name: "S1", rows: [["a"]] }] }));
    files["xl/workbook.xml"] = new TextEncoder().encode(
      new TextDecoder()
        .decode(files["xl/workbook.xml"])
        .replace("<sheets>", '<!-- <sheet name="x" state="hidden"/> --><sheets>'),
    );
    const result = await xlsxModule.parse(zipSync(files), resolveLimits());
    expect(result.ok && result.value.limitations.map((l) => l.code)).not.toContain(
      "xlsx.hidden-sheet",
    );
  });
});
