// CSV: records joined by newline, non-blank fields by tab, one block per such field (I02A-R9, R13).
// The record's start line comes from csv-parse's `info.lines`, which is the line on
// which the record ends; quoted newlines inside its fields are subtracted.
import { parse } from "csv-parse/sync";
import { formatFailure, TextBuilder } from "../text-builder.ts";
import type { Limitation, TextFormatModule } from "../types.ts";

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

    // R9, R13: only non-blank fields make blocks. Empty and whitespace-only fields add
    // no text and no tab, and a record without any such field adds no line.
    const width = rows[0]?.record.length;
    const builder = new TextBuilder();
    let ragged = 0;
    rows.forEach(({ record, info }, r) => {
      if (r > 0 && record.length !== width) ragged++;
      const embeddedBreaks = record.reduce((n, f) => n + f.split("\n").length - 1, 0);
      const line = info.lines - embeddedBreaks;
      let first = true;
      record.forEach((field, f) => {
        if (field.trim() === "") return;
        builder.block(
          field,
          { format: "csv", record: r + 1, line, field: f + 1 },
          first ? "\n" : "\t",
        );
        first = false;
      });
    });
    const limitations: Limitation[] =
      ragged > 0 ? [{ code: "csv.ragged-rows", count: ragged }] : [];
    return { ok: true, value: builder.finish({ limitations }) };
  },
};
