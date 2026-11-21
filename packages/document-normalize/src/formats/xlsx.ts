// XLSX (I02A-R12): every sheet in workbook order through read-excel-file, after the zip guard.
import readXlsxFile from "read-excel-file/universal";
import { entryText, openOoxml, readCoreProperties } from "../ooxml-core.ts";
import type { OoxmlPackage } from "../ooxml-core.ts";
import { TextBuilder, formatFailure, formatSuccess } from "../text-builder.ts";
import type { BinaryFormatModule, Limitation } from "../types.ts";

function columnLetters(column: number): string {
  let letters = "";
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

/** Cell value as text (R12); `undefined` when the cell makes no block. */
function cellText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  const text = String(value);
  return text === "" ? undefined : text;
}

const FORMULA = /<(?:\w+:)?f[\s>/]/;
const MERGE = /<(?:\w+:)?mergeCell[\s>/]/;
const HIDDEN = /<(?:\w+:)?sheet\b[^>]*\bstate\s*=\s*"(?:hidden|veryHidden)"/;

function limitations(pkg: OoxmlPackage): Limitation[] {
  const sheets = [...pkg.entries.keys()]
    .filter((name) => /^xl\/worksheets\/[^/]+\.xml$/.test(name))
    .map((name) => entryText(pkg, name));
  const found: Limitation[] = [];
  if (sheets.some((xml) => FORMULA.test(xml))) found.push({ code: "xlsx.formula-cached-value" });
  if (sheets.some((xml) => MERGE.test(xml))) found.push({ code: "xlsx.merged-cells" });
  if (HIDDEN.test(entryText(pkg, "xl/workbook.xml"))) found.push({ code: "xlsx.hidden-sheet" });
  return found;
}

export const xlsxModule: BinaryFormatModule = {
  format: "xlsx",
  input: "bytes",
  async parse(bytes, limits) {
    try {
      const opened = await openOoxml(bytes, limits, "xl/workbook.xml");
      if (!opened.ok) return opened;
      const { pkg } = opened;

      const sheets = await readXlsxFile(pkg.rezipped, { trim: false });
      const builder = new TextBuilder();
      for (const { sheet, data } of sheets) {
        builder.block(sheet, { format: "xlsx", sheet }, "\n\n");
        let lastRow = 0;
        data.forEach((cells, r) => {
          cells.forEach((value, c) => {
            const text = cellText(value);
            if (text === undefined) return;
            const locator = {
              format: "xlsx" as const,
              sheet,
              cell: `${columnLetters(c + 1)}${r + 1}`,
              row: r + 1,
              column: c + 1,
            };
            builder.block(text, locator, r + 1 === lastRow ? "\t" : "\n");
            lastRow = r + 1;
          });
        });
      }
      return formatSuccess(
        builder.finish({
          metadata: { ...readCoreProperties(pkg), sheetNames: sheets.map((s) => s.sheet) },
          limitations: limitations(pkg),
        }),
      );
    } catch (error) {
      return formatFailure("corrupt", "XLSX를 해석하지 못했다", {
        cause: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      });
    }
  },
};
