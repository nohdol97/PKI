// I02A-C1/C3/C6/C9 for CSV: records joined by tab, one block per non-blank field,
// locator {record, line, field} 1-based, ragged rows flagged, unclosed quote is corrupt.
import iconv from "iconv-lite";
import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../limits.ts";
import { normalizeDocument } from "../normalize.ts";
import { codePointSlice } from "../text-builder.ts";
import type { ParsedDocument } from "../types.ts";
import { csvModule } from "./csv.ts";

const ok = (text: string): ParsedDocument => {
  const r = csvModule.parse(text, DEFAULT_LIMITS);
  if (!("ok" in r) || !r.ok) throw new Error(`expected success: ${JSON.stringify(r)}`);
  return r.value;
};
const view = (v: ParsedDocument) =>
  v.blocks.map((b) => {
    const l = b.locator;
    if (l.format !== "csv") throw new Error("not csv");
    return [l.record, l.line, l.field, codePointSlice(v.text, b.start, b.end)];
  });

describe("csv module", () => {
  it("joins fields by tab and records by newline, with one block per non-blank field", () => {
    const v = ok("이름,나이\n홍길동,30\n");
    expect(v.text).toBe("이름\t나이\n홍길동\t30");
    expect(view(v)).toEqual([
      [1, 1, 1, "이름"],
      [1, 1, 2, "나이"],
      [2, 2, 1, "홍길동"],
      [2, 2, 2, "30"],
    ]);
    expect(v.limitations).toEqual([]);
  });

  it("adds no tab for empty fields and no line for an all-empty record (R9)", () => {
    const v = ok("a,,c\n,,\nd,e,\n");
    expect(v.text).toBe("a\tc\nd\te");
    expect(view(v)).toEqual([
      [1, 1, 1, "a"],
      [1, 1, 3, "c"],
      [3, 3, 1, "d"],
      [3, 3, 2, "e"],
    ]);
  });

  it("treats whitespace-only fields like empty ones: no block, no text", () => {
    const v = ok("a, ,c\n  ,\t\n  ,x\n");
    expect(v.text).toBe("a\tc\nx");
    expect(view(v)).toEqual([
      [1, 1, 1, "a"],
      [1, 1, 3, "c"],
      [3, 3, 2, "x"],
    ]);
    // between two blocks there is only a separator
    const between = v.blocks
      .slice(1)
      .map((b, i) => v.text.slice((v.blocks[i] as { end: number }).end, b.start));
    expect(between.every((gap) => gap === "\t" || gap === "\n")).toBe(true);
  });

  it("yields empty text for a file whose fields are all blank", () => {
    const v = ok(",\n , \n");
    expect(v.text).toBe("");
    expect(v.blocks).toEqual([]);
  });

  it("maps a record to the line where it starts, across blank lines and quoted newlines", () => {
    const v = ok('a,b\n\n"x\ny",z\nq,r\n');
    expect(view(v)).toEqual([
      [1, 1, 1, "a"],
      [1, 1, 2, "b"],
      [2, 3, 1, "x\ny"],
      [2, 3, 2, "z"],
      [3, 5, 1, "q"],
      [3, 5, 2, "r"],
    ]);
  });

  it("maps the start line of a last multi-line record without a trailing newline", () => {
    const v = ok('a\n"x\ny\nz"');
    expect(view(v)).toEqual([
      [1, 1, 1, "a"],
      [2, 2, 1, "x\ny\nz"],
    ]);
  });

  it("handles escaped quotes and a tab inside a field", () => {
    const v = ok('"he said ""hi""",b\n');
    expect(v.text).toBe('he said "hi"\tb');
  });

  it("flags ragged rows with the number of records that differ from the first", () => {
    const v = ok("a,b,c\n1,2\n3,4,5\n6,7,8,9\n");
    expect(v.limitations).toEqual([{ code: "csv.ragged-rows", count: 2 }]);
    expect(v.text).toBe("a\tb\tc\n1\t2\n3\t4\t5\n6\t7\t8\t9");
  });

  it("does not flag equal-width records", () => {
    expect(ok("a,b\n1,2\n").limitations).toEqual([]);
  });

  it("measures offsets in code points with emoji", () => {
    const v = ok("😀,가\n나,😀\n");
    expect(view(v).map((x) => x[3])).toEqual(["😀", "가", "나", "😀"]);
    expect(v.blocks[1]?.start).toBe(2);
  });

  it("has no blocks for an empty file", () => {
    const v = ok("");
    expect(v.text).toBe("");
    expect(v.blocks).toEqual([]);
  });

  it.each(['a,"b\nc', 'a,b"c\n', 'a,"b"c\n'])("returns corrupt for %j", (text) => {
    const r = csvModule.parse(text, DEFAULT_LIMITS);
    expect(r).toMatchObject({ ok: false, error: { code: "corrupt" } });
  });
});

describe("csv through the pipeline", () => {
  // "똠" is the CP949 extension syllable (bytes 8C 63), so the locators are checked
  // after the fallback decoder, not after UTF-8.
  const eucKr = (text: string) => Uint8Array.from(iconv.encode(text, "cp949"));

  it("keeps locators and the encoding limitation for an EUC-KR file", async () => {
    const bytes = eucKr("이름,별칭\n홍길동,똠방\n");
    expect(Buffer.from(bytes).includes(Buffer.from("8c63", "hex"))).toBe(true);
    const r = await normalizeDocument({ kind: "bytes", bytes, name: "a.csv" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.document;
    expect(d.encoding).toEqual({ name: "euc-kr", method: "fallback" });
    expect(d.text).toBe("이름\t별칭\n홍길동\t똠방");
    expect(d.limitations.map((l) => l.code)).toEqual(["text.encoding-fallback"]);
    expect(
      d.blocks.map((b) => [JSON.stringify(b.locator), codePointSlice(d.text, b.start, b.end)]),
    ).toEqual([
      ['{"format":"csv","record":1,"line":1,"field":1}', "이름"],
      ['{"format":"csv","record":1,"line":1,"field":2}', "별칭"],
      ['{"format":"csv","record":2,"line":2,"field":1}', "홍길동"],
      ['{"format":"csv","record":2,"line":2,"field":2}', "똠방"],
    ]);
  });

  it("sorts csv.ragged-rows after text.encoding-fallback", async () => {
    const bytes = eucKr("이름,별\n홍\n");
    const r = await normalizeDocument({ kind: "bytes", bytes, name: "a.csv" });
    expect(r.ok && r.document.limitations.map((l) => l.code)).toEqual([
      "text.encoding-fallback",
      "csv.ragged-rows",
    ]);
  });

  it("returns corrupt for an unclosed quote", async () => {
    const r = await normalizeDocument({
      kind: "bytes",
      bytes: Uint8Array.from(Buffer.from('a,"b\nc', "utf8")),
      name: "a.csv",
    });
    expect(r).toMatchObject({ ok: false, error: { code: "corrupt" } });
  });
});
