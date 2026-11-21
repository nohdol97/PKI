// I02A-C1/C7/C9 at the Markdown format level (R6, R15).
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LIMITS } from "../limits.ts";
import { codePointSlice } from "../text-builder.ts";
import type { ParsedDocument } from "../types.ts";
import { markdownModule } from "./markdown.ts";

afterEach(() => vi.restoreAllMocks());

function parse(md: string): ParsedDocument {
  const result = markdownModule.parse(md, DEFAULT_LIMITS);
  if (result instanceof Promise || !result.ok) throw new Error("expected a synchronous success");
  return result.value;
}

function slices(doc: ParsedDocument): string[] {
  return doc.blocks.map((b) => codePointSlice(doc.text, b.start, b.end));
}

describe("markdown blocks (R15, R9)", () => {
  it("makes one block per leaf block with line, node and depth", () => {
    const doc = parse("# Title\n\nfirst para\nsecond line\n\n```js\nlet a = 1;\n```\n\n## Sub\n");
    expect(slices(doc)).toEqual(["Title", "first para\nsecond line", "let a = 1;", "Sub"]);
    expect(doc.blocks.map((b) => b.locator)).toEqual([
      { format: "markdown", line: 1, node: "heading", depth: 1 },
      { format: "markdown", line: 3, node: "paragraph" },
      { format: "markdown", line: 6, node: "code" },
      { format: "markdown", line: 10, node: "heading", depth: 2 },
    ]);
    expect(doc.text).toBe("Title\nfirst para\nsecond line\nlet a = 1;\nSub");
    expect(doc.limitations).toEqual([]);
  });

  it("descends into quotes and lists", () => {
    const doc = parse("> quoted\n\n- one\n- two\n\n1. three\n");
    expect(slices(doc)).toEqual(["quoted", "one", "two", "three"]);
    expect(doc.blocks.map((b) => (b.locator as { line: number }).line)).toEqual([1, 3, 4, 6]);
  });

  it("keeps link text only and image alt only, counting dropped addresses", () => {
    const doc = parse(
      "see [the *docs*](https://x.example/a) and ![logo](https://x.example/l.png) or <https://auto.example>\n\n[ref][r] ![img][r]\n\n[r]: https://x.example/r\n",
    );
    expect(slices(doc)).toEqual(["see the docs and logo or https://auto.example", "ref img"]);
    expect(doc.text).not.toContain("x.example/a");
    expect(doc.limitations).toEqual([{ code: "markdown.external-references-ignored", count: 6 }]);
  });

  it("counts a link reference definition's address as dropped (R15)", () => {
    const doc = parse(
      'text\n\n[a]: https://x.example/a\n[b]: https://x.example/b "t"\n\n> [c]: /c\n',
    );
    expect(doc.text).toBe("text");
    expect(doc.limitations).toEqual([{ code: "markdown.external-references-ignored", count: 3 }]);
  });

  it("keeps inline code and emphasis text", () => {
    expect(slices(parse("a `b*c` **d** _e_"))).toEqual(["a b*c d e"]);
  });

  it("keeps raw HTML literally and flags it (R6, C7)", () => {
    const doc = parse(
      "<script>alert(1)</script>\n\ntext <b>bold</b> end\n\n<div>\nblock\n</div>\n",
    );
    expect(doc.text).toContain("<script>alert(1)</script>");
    expect(slices(doc)).toEqual([
      "<script>alert(1)</script>",
      "text <b>bold</b> end",
      "<div>\nblock\n</div>",
    ]);
    expect(doc.blocks[0]?.locator).toEqual({ format: "markdown", line: 1, node: "html" });
    expect(doc.limitations).toEqual([{ code: "markdown.raw-html-as-text" }]);
  });

  it("flags HTML that appears only inside a sentence", () => {
    const doc = parse("text <b>bold</b> end");
    expect(doc.text).toBe("text <b>bold</b> end");
    expect(doc.limitations).toEqual([{ code: "markdown.raw-html-as-text" }]);
  });

  it("does not interpret GFM tables or footnotes", () => {
    const doc = parse("| a | b |\n|---|---|\n| 1 | 2 |\n\ntext[^1]\n\n[^1]: note\n");
    expect(doc.text).toContain("| a | b |");
    expect(doc.text).toContain("|---|---|");
    expect(doc.blocks[0]?.locator).toMatchObject({ node: "paragraph" });
  });

  it("makes no block for empty headings or code and keeps hard breaks as newlines", () => {
    const doc = parse("#\n\n```\n```\n\nline one  \nline two\n");
    expect(slices(doc)).toEqual(["line one\nline two"]);
  });

  it("counts positions in code points and returns no metadata", () => {
    const doc = parse("😀 a\n\nb");
    expect(doc.blocks[1]?.start).toBe(4);
    expect(doc.metadata).toEqual({});
  });

  it("handles empty input", () => {
    expect(parse("")).toMatchObject({ text: "", blocks: [] });
  });
});

describe("block invariants (R9)", () => {
  it("keeps blocks sorted, disjoint, in range and separated by one newline", () => {
    const doc = parse("# T\n\n- a\n- b\n\n```\nc\n```\n\n<i>x</i>\n\n😀 d\n");
    let previousEnd = -1;
    for (const b of doc.blocks) {
      expect(b.start).toBeGreaterThan(previousEnd - 1);
      expect(b.end).toBeGreaterThan(b.start);
      if (previousEnd >= 0) expect(codePointSlice(doc.text, previousEnd, b.start)).toBe("\n");
      previousEnd = b.end;
    }
    expect(previousEnd).toBe(Array.from(doc.text).length);
  });
});
