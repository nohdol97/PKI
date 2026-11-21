// I02A-C1 (DOCX), C6 (DOCX corrupt), C8 (DOCX metadata), C9 (DOCX limitation codes).
import { unzipSync, zipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveLimits } from "../limits.ts";
import { buildDocx, buildZip, heading } from "../testing/ooxml-builder.ts";
import type { DocxSpec } from "../testing/ooxml-builder.ts";
import { codePointLength, codePointSlice } from "../text-builder.ts";
import type { Block, FormatResult, ParsedDocument } from "../types.ts";
import { docxModule } from "./docx.ts";

const mammothSpy = vi.hoisted(() => vi.fn());
vi.mock("mammoth", async (importOriginal) => {
  const actual = await importOriginal<{ default: Record<string, unknown> }>();
  mammothSpy.mockImplementation(actual.default.convertToHtml as never);
  return { default: { ...actual.default, convertToHtml: mammothSpy } };
});
beforeEach(() => {
  mammothSpy.mockClear();
});

async function parse(spec: DocxSpec): Promise<ParsedDocument> {
  const result: FormatResult = await docxModule.parse(buildDocx(spec), resolveLimits());
  if (!result.ok) throw new Error(`unexpected failure ${JSON.stringify(result.error)}`);
  return result.value;
}
const slices = (doc: ParsedDocument) =>
  doc.blocks.map((b) => codePointSlice(doc.text, b.start, b.end));

describe("C1 paragraphs, tables and locators", () => {
  const spec: DocxSpec = {
    body: [
      heading(1, "제목"),
      { text: "본문 한글 😀 끝" },
      { text: "" },
      {
        table: [
          ["a", "b"],
          ["c", ["d1", "d2"]],
        ],
      },
      { text: "마지막", style: { id: "Quote", name: "Quote" } },
      heading(2, "소제목"),
    ],
  };

  it("emits every paragraph in document order with 0-based paragraph numbers (empty ones counted)", async () => {
    const doc = await parse(spec);
    expect(doc.text).toBe("제목\n본문 한글 😀 끝\na\nb\nc\nd1\nd2\n마지막\n소제목");
    expect(doc.blocks.map((b) => b.locator)).toEqual([
      { format: "docx", paragraph: 0, style: "heading 1", headingLevel: 1 },
      { format: "docx", paragraph: 1 },
      { format: "docx", paragraph: 3, table: { index: 0, row: 0, cell: 0 } },
      { format: "docx", paragraph: 4, table: { index: 0, row: 0, cell: 1 } },
      { format: "docx", paragraph: 5, table: { index: 0, row: 1, cell: 0 } },
      { format: "docx", paragraph: 6, table: { index: 0, row: 1, cell: 1 } },
      { format: "docx", paragraph: 7, table: { index: 0, row: 1, cell: 1 } },
      { format: "docx", paragraph: 8, style: "Quote" },
      { format: "docx", paragraph: 9, style: "heading 2", headingLevel: 2 },
    ]);
    expect(slices(doc)).toEqual([
      "제목",
      "본문 한글 😀 끝",
      "a",
      "b",
      "c",
      "d1",
      "d2",
      "마지막",
      "소제목",
    ]);
  });

  it("blocks are ordered, disjoint, in range, and joined by exactly one newline", async () => {
    const doc = await parse(spec);
    const total = codePointLength(doc.text);
    let previousEnd = -1;
    for (const block of doc.blocks) {
      expect(block.start).toBeGreaterThanOrEqual(0);
      expect(block.end).toBeGreaterThan(block.start);
      expect(block.end).toBeLessThanOrEqual(total);
      if (previousEnd >= 0) expect(codePointSlice(doc.text, previousEnd, block.start)).toBe("\n");
      previousEnd = block.end;
    }
  });

  it("counts positions in code points: a block after an emoji differs from the UTF-16 index", async () => {
    const doc = await parse(spec);
    const after = doc.blocks[2] as Block;
    expect(doc.text.indexOf("a\nb")).not.toBe(after.start);
    expect(doc.text.indexOf("a\nb")).toBe(after.start + 1);
  });

  it("keeps tabs and line breaks inside a paragraph as one block", async () => {
    const doc = await parse({ body: [{ text: "가\t나\n다" }] });
    expect(doc.text).toBe("가\t나\n다");
    expect(doc.blocks).toHaveLength(1);
  });

  it("text box paragraphs come out as paragraphs of their own, after the anchor paragraph (mammoth hoists them)", async () => {
    const doc = await parse({
      body: [{ text: "본문", textbox: ["상자 첫줄", "상자 둘째"] }, { text: "다음" }],
    });
    expect(doc.text).toBe("본문\n상자 첫줄\n상자 둘째\n다음");
    expect(doc.blocks.map((b) => b.locator)).toEqual([
      { format: "docx", paragraph: 0 },
      { format: "docx", paragraph: 1 },
      { format: "docx", paragraph: 2 },
      { format: "docx", paragraph: 3 },
    ]);
    expect(doc.limitations).toEqual([]);
  });

  it("a document with no text yields no blocks", async () => {
    const doc = await parse({ body: [{ text: "" }] });
    expect(doc.text).toBe("");
    expect(doc.blocks).toEqual([]);
  });

  it("is deterministic", async () => {
    expect(await parse(spec)).toEqual(await parse(spec));
  });
});

describe("C8 metadata", () => {
  it("reads title, author, created and modified (ISO-8601) from docProps/core.xml", async () => {
    const doc = await parse({
      body: [{ text: "x" }],
      core: {
        title: "분기 보고서",
        author: "홍길동",
        created: "2026-03-01T09:00:00Z",
        modified: "2026-03-02T10:30:00Z",
      },
    });
    expect(doc.metadata).toEqual({
      title: "분기 보고서",
      author: "홍길동",
      created: "2026-03-01T09:00:00.000Z",
      modified: "2026-03-02T10:30:00.000Z",
    });
  });

  it("leaves out fields that are absent or empty (never an empty string)", async () => {
    expect((await parse({ body: [{ text: "x" }] })).metadata).toEqual({});
    const partial = await parse({ body: [{ text: "x" }], core: { title: "  ", author: "나" } });
    expect(partial.metadata).toEqual({ author: "나" });
    expect(Object.hasOwn(partial.metadata, "title")).toBe(false);
  });

  it("drops a date that does not parse instead of inventing one", async () => {
    const doc = await parse({ body: [{ text: "x" }], core: { created: "not a date" } });
    expect(doc.metadata).toEqual({});
  });
});

describe("C9 limitation codes", () => {
  const codes = async (spec: DocxSpec) => (await parse(spec)).limitations.map((l) => l.code);

  it("none for a plain document", async () => {
    expect(await codes({ body: [{ text: "x" }] })).toEqual([]);
  });
  it("docx.images-omitted", async () => {
    expect(await codes({ body: [{ text: "x" }], images: 1 })).toEqual(["docx.images-omitted"]);
  });
  it("docx.headers-footers-omitted for a header or a footer", async () => {
    expect(await codes({ body: [{ text: "x" }], headers: ["머리글"] })).toEqual([
      "docx.headers-footers-omitted",
    ]);
    expect(await codes({ body: [{ text: "x" }], footers: ["바닥글"] })).toEqual([
      "docx.headers-footers-omitted",
    ]);
  });
  it("an empty header or footer part is not reported (nothing is lost)", async () => {
    expect(await codes({ body: [{ text: "x" }], headers: [""], footers: [""] })).toEqual([]);
  });
  it("docx.notes-omitted for footnotes or endnotes, but not for Word's separator-only parts", async () => {
    expect(await codes({ body: [{ text: "x" }], footnotes: ["각주"] })).toEqual([
      "docx.notes-omitted",
    ]);
    expect(await codes({ body: [{ text: "x" }], endnotes: ["미주"] })).toEqual([
      "docx.notes-omitted",
    ]);
    expect(await codes({ body: [{ text: "x" }], separatorNotes: true })).toEqual([]);
  });
  it("docx.comments-omitted", async () => {
    expect(await codes({ body: [{ text: "x" }], comments: ["메모"] })).toEqual([
      "docx.comments-omitted",
    ]);
  });
  it("reports several at once and keeps their text out of the result", async () => {
    const doc = await parse({
      body: [{ text: "본문" }],
      headers: ["HEADER-TEXT"],
      footnotes: ["NOTE-TEXT"],
      comments: ["COMMENT-TEXT"],
      images: 2,
    });
    expect(doc.limitations.map((l) => l.code).sort()).toEqual([
      "docx.comments-omitted",
      "docx.headers-footers-omitted",
      "docx.images-omitted",
      "docx.notes-omitted",
    ]);
    expect(doc.text).toBe("본문");
  });
});

describe("C4/C6 data only and damaged input", () => {
  it("turns mammoth's external file access off, and an external picture link does not matter", async () => {
    const doc = await parse({ body: [{ text: "본문" }], externalImage: "file:///etc/hostname" });
    expect(doc.text).toBe("본문");
    expect(doc.limitations.map((l) => l.code)).toEqual(["docx.images-omitted"]);
    const options = mammothSpy.mock.calls[0]?.[1] as { externalFileAccess: boolean };
    expect(options.externalFileAccess).toBe(false);
  });

  it("a ZIP without word/document.xml is format-mismatch and mammoth is not called", async () => {
    const result = await docxModule.parse(
      buildZip([{ name: "xl/workbook.xml", data: "<x/>" }]),
      resolveLimits(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("format-mismatch");
    expect(mammothSpy).not.toHaveBeenCalled();
  });

  it("a broken document.xml is corrupt, not a rejection", async () => {
    const result = await docxModule.parse(
      buildZip([{ name: "word/document.xml", data: "<w:document <<< not xml" }]),
      resolveLimits(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("corrupt");
  });

  it("a parser that rejects is turned into corrupt by the module itself", async () => {
    mammothSpy.mockRejectedValueOnce(new RangeError("boom SECRETMARK_1"));
    const result = await docxModule.parse(buildDocx({ body: [{ text: "x" }] }), resolveLimits());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("corrupt");
      expect(result.error.detail?.cause).toBe("RangeError");
      expect(JSON.stringify(result.error)).not.toContain("SECRETMARK_1");
    }
  });
});

describe("B4 document-derived text stays out of failures", () => {
  it("an undefined entity name in document.xml never reaches message or detail", async () => {
    const result = await docxModule.parse(
      buildZip([
        {
          name: "word/document.xml",
          data: '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&SECRETMARK_ent;</w:t></w:r></w:p></w:body></w:document>',
        },
      ]),
      resolveLimits(),
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("SECRETMARK_ent");
  });
});

describe("B1 limitation scans stay linear on hostile XML", () => {
  const enc = (text: string) => new TextEncoder().encode(text);
  const hostile = (part: RegExp, mutate: (xml: string) => string) => {
    const files = unzipSync(buildDocx(DOCX_FOR_SCAN));
    const name = Object.keys(files).find((n) => part.test(n)) as string;
    files[name] = enc(mutate(new TextDecoder().decode(files[name])));
    return zipSync(files);
  };
  const DOCX_FOR_SCAN: DocxSpec = {
    body: [{ text: "x" }],
    headers: ["h"],
    footnotes: ["n"],
  };

  it("a header whose comment repeats `<w:t ` without `>` finishes fast and reports nothing", async () => {
    const bytes = hostile(/^word\/header\d*\.xml$/, (xml) =>
      xml
        .replace(/<w:t[^>]*>h<\/w:t>/, "")
        .replace(/(<w:hdr[^>]*>)/, `$1<!-- ${"<w:t ".repeat(50_000)} -->`),
    );
    const started = Date.now();
    const result = await docxModule.parse(bytes, resolveLimits());
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.ok && result.value.limitations.map((l) => l.code)).not.toContain(
      "docx.headers-footers-omitted",
    );
  });

  it("a notes part whose comment repeats `<w:footnote ` without `>` finishes fast", async () => {
    const bytes = hostile(/^word\/footnotes\.xml$/, (xml) =>
      xml.replace(/(<w:footnotes[^>]*>)/, `$1<!-- ${"<w:footnote ".repeat(50_000)} -->`),
    );
    const started = Date.now();
    const result = await docxModule.parse(bytes, resolveLimits());
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.ok && result.value.limitations.map((l) => l.code)).toContain(
      "docx.notes-omitted",
    );
  });

  it("a real text run after a hostile comment is still found", async () => {
    const bytes = hostile(/^word\/header\d*\.xml$/, (xml) =>
      xml.replace(/(<w:hdr[^>]*>)/, `$1<!-- ${"<w:t ".repeat(1000)} -->`),
    );
    const result = await docxModule.parse(bytes, resolveLimits());
    expect(result.ok && result.value.limitations.map((l) => l.code)).toContain(
      "docx.headers-footers-omitted",
    );
  });
});
