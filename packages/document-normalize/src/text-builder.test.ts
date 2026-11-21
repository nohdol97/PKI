// I02A-C2 helper / R8-R9: block ranges are Unicode code points, not UTF-16 units.
import { describe, expect, it } from "vitest";
import {
  TextBuilder,
  codePointLength,
  codePointSlice,
  verbatimLineBlocks,
} from "./text-builder.ts";

describe("codePointLength / codePointSlice", () => {
  const text = "한글😀é끝"; // 6 code points, 7 UTF-16 units (emoji = 2 units; e + combining acute = 2 code points)

  it("counts an emoji as one code point", () => {
    expect(text.length).toBe(7);
    expect(codePointLength(text)).toBe(6);
    expect(codePointLength("")).toBe(0);
  });

  it("slices by code point", () => {
    expect(codePointSlice(text, 0, 2)).toBe("한글");
    expect(codePointSlice(text, 2, 3)).toBe("😀");
    expect(codePointSlice(text, 3, 5)).toBe("é");
    expect(codePointSlice(text, 5, 6)).toBe("끝");
    expect(codePointSlice(text, 3, 3)).toBe("");
    expect(codePointSlice(text, 0, 6)).toBe(text);
  });

  it("differs from a UTF-16 slice after an emoji", () => {
    expect(codePointSlice(text, 3, 4)).toBe("e");
    expect(text.slice(3, 4)).not.toBe("e");
  });

  it("counts a lone surrogate as one code point and rejects bad ranges", () => {
    expect(codePointLength("a\ud83db")).toBe(3);
    expect(() => codePointSlice(text, 0, 7)).toThrow(RangeError);
    expect(() => codePointSlice(text, -1, 2)).toThrow(RangeError);
    expect(() => codePointSlice(text, 3, 2)).toThrow(RangeError);
    expect(() => codePointSlice(text, 0.5, 2)).toThrow(RangeError);
  });
});

describe("TextBuilder", () => {
  it("places blocks with the given separators and code point ranges", () => {
    const b = new TextBuilder();
    b.block("😀 한글", { format: "txt", line: 1 });
    b.block("둘째", { format: "txt", line: 2 }, "\n\n");
    const doc = b.finish();
    expect(doc.text).toBe("😀 한글\n\n둘째");
    expect(doc.blocks).toEqual([
      { start: 0, end: 4, locator: { format: "txt", line: 1 } },
      { start: 6, end: 8, locator: { format: "txt", line: 2 } },
    ]);
    for (const block of doc.blocks) {
      expect(codePointSlice(doc.text, block.start, block.end)).toBe(
        block.locator.format === "txt" && block.locator.line === 1 ? "😀 한글" : "둘째",
      );
    }
  });

  it("makes neither a block nor a separator for empty text", () => {
    const b = new TextBuilder();
    b.block("", { format: "txt", line: 1 });
    expect(b.isEmpty).toBe(true);
    b.block("a", { format: "txt", line: 2 });
    b.block("", { format: "txt", line: 3 });
    b.block("b", { format: "txt", line: 4 });
    const doc = b.finish();
    expect(doc.text).toBe("a\nb");
    expect(doc.blocks.map((x) => [x.start, x.end])).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it("carries metadata and limitations through finish", () => {
    const doc = new TextBuilder().finish({
      metadata: { title: "t" },
      limitations: [{ code: "csv.ragged-rows" }],
    });
    expect(doc).toEqual({
      text: "",
      blocks: [],
      metadata: { title: "t" },
      limitations: [{ code: "csv.ragged-rows" }],
    });
  });
});

describe("verbatimLineBlocks", () => {
  it("keeps the text and blocks only the non-blank lines, 1-based", () => {
    const doc = verbatimLineBlocks("😀a\n\n  \n한글", "txt");
    expect(doc.text).toBe("😀a\n\n  \n한글");
    expect(doc.blocks).toEqual([
      { start: 0, end: 2, locator: { format: "txt", line: 1 } },
      { start: 7, end: 9, locator: { format: "txt", line: 4 } },
    ]);
    expect(codePointSlice(doc.text, 7, 9)).toBe("한글");
  });

  it("handles empty text and a trailing newline", () => {
    expect(verbatimLineBlocks("", "json").blocks).toEqual([]);
    expect(verbatimLineBlocks("a\n", "json").blocks).toEqual([
      { start: 0, end: 1, locator: { format: "json", line: 1 } },
    ]);
  });
});
