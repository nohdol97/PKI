// CSV: records joined by tab, one block per non-blank field (I02A-R13).
// The record's start line comes from csv-parse's `info.lines`, which is the line on
// which the record ends; quoted newlines inside its fields are subtracted.
import { parse } from "csv-parse/sync";
import { codePointLength, formatFailure } from "../text-builder.ts";
import type { Block, Limitation, TextFormatModule } from "../types.ts";

interface Row {
  record: string[];
  info: { lines: number };
}

export const csvModule: TextFormatModule = {
  format: "csv",
  input: "text",
  parse(input) {
    let rows: Row[];
    try {
      rows = parse(input, {
        info: true,
        relax_column_count: true,
        skip_empty_lines: true,
      }) as unknown as Row[];
    } catch (error) {
      // csv-parse messages quote the offending content, so only the code is kept.
      const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
      return formatFailure("corrupt", "the file is not parseable CSV", { csvCode: code });
    }

    const width = rows[0]?.record.length;
    let text = "";
    let length = 0;
    const blocks: Block[] = [];
    let ragged = 0;
    rows.forEach(({ record, info }, r) => {
      if (r > 0) {
        text += "\n";
        length += 1;
        if (record.length !== width) ragged++;
      }
      const embeddedBreaks = record.reduce((n, f) => n + f.split("\n").length - 1, 0);
      const line = info.lines - embeddedBreaks;
      record.forEach((field, f) => {
        if (f > 0) {
          text += "\t";
          length += 1;
        }
        const size = codePointLength(field);
        if (field.trim() !== "") {
          blocks.push({
            start: length,
            end: length + size,
            locator: { format: "csv", record: r + 1, line, field: f + 1 },
          });
        }
        text += field;
        length += size;
      });
    });
    const limitations: Limitation[] =
      ragged > 0 ? [{ code: "csv.ragged-rows", count: ragged }] : [];
    return { ok: true, value: { text, blocks, metadata: {}, limitations } };
  },
};
