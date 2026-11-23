// I02A-C10 (R8, R20) and the per-fixture outcomes of C1/C3/C8: the generator is
// deterministic, its output equals the committed fixtures/documents/, and every
// fixture normalizes to the recorded outcome, identically on a second run.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeDocument } from "./index.ts";
import type { Locator, NormalizeResult } from "./index.ts";
import { codePointSlice } from "./text-builder.ts";
import { FIXTURES_DIR, generateFixtures } from "./testing/generate-fixtures.ts";

const committedDir = fileURLToPath(FIXTURES_DIR);
const TXT_TEXT = "합성 문서 제목\n첫 줄 😀 이모지 뒤의 글\n\n결합 문자 é 와 끝\n";

interface Outcome {
  ok: boolean;
  /** Error code when `ok` is false. */
  code?: string;
  blocks?: number;
  limitations?: { code: string; count?: number; pages?: number[] }[];
  encoding?: { name: string; method: string };
  metadata?: Record<string, unknown>;
}

const utf8 = { name: "utf-8", method: "strict" };
const bom = (name: string) => ({ name, method: "bom" });
const cp949 = { name: "euc-kr", method: "fallback" };
const fallback = [{ code: "text.encoding-fallback" }];

const EXPECTED: Record<string, Outcome> = {
  "normal-text-utf8.txt": { ok: true, blocks: 3, encoding: utf8, limitations: [], metadata: {} },
  "normal-text-utf8-bom.txt": { ok: true, blocks: 3, encoding: bom("utf-8"), limitations: [] },
  "normal-text-utf16le-bom.txt": {
    ok: true,
    blocks: 3,
    encoding: bom("utf-16le"),
    limitations: [],
  },
  "normal-text-utf16be-bom.txt": {
    ok: true,
    blocks: 3,
    encoding: bom("utf-16be"),
    limitations: [],
  },
  "normal-text-crlf.txt": { ok: true, blocks: 3, encoding: utf8, limitations: [] },
  "limit-text-euckr.txt": { ok: true, blocks: 2, encoding: cp949, limitations: fallback },
  "limit-text-cp949-extension.txt": { ok: true, blocks: 2, encoding: cp949, limitations: fallback },
  "corrupt-text-latin1.txt": { ok: false, code: "encoding-undecidable" },
  "corrupt-bytes.txt": { ok: false, code: "encoding-undecidable" },
  "corrupt-bytes.md": { ok: false, code: "encoding-undecidable" },
  "corrupt-bytes.html": { ok: false, code: "encoding-undecidable" },
  "normal-markdown.md": { ok: true, blocks: 5, encoding: utf8, limitations: [] },
  "limit-markdown-raw-html-and-links.md": {
    ok: true,
    blocks: 3,
    limitations: [
      { code: "markdown.raw-html-as-text" },
      { code: "markdown.external-references-ignored", count: 2 },
    ],
  },
  "normal-html.html": {
    ok: true,
    blocks: 6,
    limitations: [],
    metadata: { title: "합성 HTML 문서", author: "가상 작성자" },
  },
  "limit-html-hostile.html": {
    ok: true,
    blocks: 3,
    limitations: [
      { code: "html.elements-removed", count: 7 },
      { code: "html.external-references-ignored", count: 5 },
    ],
    metadata: { title: "합성 위험 HTML" },
  },
  "normal-csv.csv": { ok: true, blocks: 8, encoding: utf8, limitations: [] },
  "limit-csv-ragged.csv": {
    ok: true,
    blocks: 9,
    limitations: [{ code: "csv.ragged-rows", count: 2 }],
  },
  "limit-csv-euckr.csv": { ok: true, blocks: 4, encoding: cp949, limitations: fallback },
  "corrupt-csv-unclosed-quote.csv": { ok: false, code: "corrupt" },
  "normal-json.json": { ok: true, blocks: 5, encoding: utf8, limitations: [] },
  "corrupt-json-invalid.json": { ok: false, code: "corrupt" },
  "normal-pdf.pdf": {
    ok: true,
    blocks: 2,
    limitations: [],
    metadata: {
      title: "합성 PDF 문서",
      author: "가상 작성자",
      created: "2026-03-01T00:00:00.000Z",
      pageCount: 2,
    },
  },
  "limit-pdf-page-without-text.pdf": {
    ok: true,
    blocks: 2,
    limitations: [{ code: "pdf.page-without-text", pages: [2] }],
    metadata: { pageCount: 3 },
  },
  "corrupt-pdf-truncated.pdf": { ok: false, code: "corrupt" },
  "corrupt-pdf-encrypted.pdf": { ok: false, code: "encrypted" },
  "corrupt-pdf-not-pdf.pdf": { ok: false, code: "format-mismatch" },
  "normal-docx.docx": {
    ok: true,
    blocks: 6,
    limitations: [],
    metadata: {
      title: "합성 DOCX 문서",
      author: "가상 작성자",
      created: "2026-03-01T09:00:00.000Z",
      modified: "2026-03-02T09:00:00.000Z",
    },
  },
  "normal-docx-comments.docx": {
    ok: true,
    blocks: 10,
    limitations: [],
    metadata: { participants: ["나", "가", "다"] },
  },
  "limit-docx-omitted-parts.docx": {
    ok: true,
    blocks: 1,
    limitations: [
      { code: "docx.images-omitted" },
      { code: "docx.headers-footers-omitted" },
      { code: "docx.notes-omitted" },
    ],
    metadata: {},
  },
  "corrupt-docx-not-zip.docx": { ok: false, code: "format-mismatch" },
  "corrupt-docx-no-body.docx": { ok: false, code: "format-mismatch" },
  "normal-xlsx.xlsx": {
    ok: true,
    blocks: 12,
    limitations: [],
    metadata: {
      title: "합성 XLSX 문서",
      author: "가상 작성자",
      created: "2026-03-01T09:00:00.000Z",
      modified: "2026-03-02T09:00:00.000Z",
      sheetNames: ["합성 시트", "둘째"],
    },
  },
  "limit-xlsx-formula-merge-hidden.xlsx": {
    ok: true,
    blocks: 7,
    limitations: [
      { code: "xlsx.formula-cached-value" },
      { code: "xlsx.merged-cells" },
      { code: "xlsx.hidden-sheet" },
    ],
    metadata: { sheetNames: ["계산", "숨김"] },
  },
  "limit-xlsx-comments.xlsx": {
    ok: true,
    blocks: 2,
    limitations: [{ code: "xlsx.comments-omitted" }],
    metadata: { sheetNames: ["메모"] },
  },
  "corrupt-xlsx-broken-workbook.xlsx": { ok: false, code: "corrupt" },
  "table-csv-blank-cells.csv": {
    ok: true,
    blocks: 13,
    encoding: utf8,
    limitations: [{ code: "csv.ragged-rows", count: 1 }],
  },
  "table-csv-title-above.csv": {
    ok: true,
    blocks: 7,
    encoding: utf8,
    limitations: [{ code: "csv.ragged-rows", count: 3 }],
  },
  "table-csv-number-first-row.csv": { ok: true, blocks: 6, encoding: utf8, limitations: [] },
  "table-csv-padded-number-first-row.csv": { ok: true, blocks: 4, encoding: utf8, limitations: [] },
  "table-csv-date-first-row.csv": { ok: true, blocks: 4, encoding: utf8, limitations: [] },
  "table-csv-duplicate-header.csv": { ok: true, blocks: 6, encoding: utf8, limitations: [] },
  "table-csv-no-rows.csv": { ok: true, blocks: 2, encoding: utf8, limitations: [] },
  "table-xlsx-two-sheets.xlsx": { ok: true, blocks: 15, limitations: [] },
  "table-xlsx-hidden-sheet.xlsx": {
    ok: true,
    blocks: 10,
    limitations: [{ code: "xlsx.hidden-sheet" }],
    metadata: { sheetNames: ["공개", "숨김"] },
  },
};

/**
 * C1 at fixture level: the exact `text` and, for every block, [start, end, locator,
 * text read back by code point range] for one normal fixture per format (plus the
 * hostile HTML, whose locator once named an inline element). Written out by hand
 * from the fixture sources, not derived from the parser at test time.
 */
type ExactBlock = [number, number, Locator, string];
const EXACT: Record<string, { text: string; blocks: ExactBlock[] }> = {
  "normal-text-utf8.txt": {
    text: "합성 문서 제목\n첫 줄 😀 이모지 뒤의 글\n\n결합 문자 é 와 끝\n",
    blocks: [
      [0, 8, { format: "txt", line: 1 }, "합성 문서 제목"],
      [9, 23, { format: "txt", line: 2 }, "첫 줄 😀 이모지 뒤의 글"],
      [25, 37, { format: "txt", line: 4 }, "결합 문자 é 와 끝"],
    ],
  },
  "normal-markdown.md": {
    text: "합성 마크다운\n첫 문단 😀 한글 é.\n항목 하나\n항목 둘\ncode line",
    blocks: [
      [0, 7, { format: "markdown", line: 1, node: "heading", depth: 1 }, "합성 마크다운"],
      [8, 21, { format: "markdown", line: 3, node: "paragraph" }, "첫 문단 😀 한글 é."],
      [22, 27, { format: "markdown", line: 5, node: "paragraph" }, "항목 하나"],
      [28, 32, { format: "markdown", line: 6, node: "paragraph" }, "항목 둘"],
      [33, 42, { format: "markdown", line: 8, node: "code" }, "code line"],
    ],
  },
  "normal-html.html": {
    text: "제목 😀\n첫 문단입니다. 공백이 줄어듭니다.\n항목 하나\n항목 둘\n칸 A\n칸 B",
    blocks: [
      [0, 4, { format: "html", path: "body>h1[1]", line: 5 }, "제목 😀"],
      [5, 24, { format: "html", path: "body>p[1]", line: 6 }, "첫 문단입니다. 공백이 줄어듭니다."],
      [25, 30, { format: "html", path: "body>ul[1]>li[1]", line: 7 }, "항목 하나"],
      [31, 35, { format: "html", path: "body>ul[1]>li[2]", line: 7 }, "항목 둘"],
      [36, 39, { format: "html", path: "body>table[1]>tbody[1]>tr[1]>td[1]", line: 8 }, "칸 A"],
      [40, 43, { format: "html", path: "body>table[1]>tbody[1]>tr[1]>td[2]", line: 8 }, "칸 B"],
    ],
  },
  "limit-html-hostile.html": {
    text: "위험 요소가 든 문서\n보이는 글\n링크 글",
    blocks: [
      [0, 11, { format: "html", path: "body>h1[1]", line: 7 }, "위험 요소가 든 문서"],
      [12, 17, { format: "html", path: "body>p[1]", line: 9 }, "보이는 글"],
      [18, 22, { format: "html", path: "body", line: 16 }, "링크 글"],
    ],
  },
  "normal-csv.csv": {
    text: "이름\t수량\t비고\n사과\t3\t😀\n배\t5",
    blocks: [
      [0, 2, { format: "csv", record: 1, line: 1, field: 1 }, "이름"],
      [3, 5, { format: "csv", record: 1, line: 1, field: 2 }, "수량"],
      [6, 8, { format: "csv", record: 1, line: 1, field: 3 }, "비고"],
      [9, 11, { format: "csv", record: 2, line: 2, field: 1 }, "사과"],
      [12, 13, { format: "csv", record: 2, line: 2, field: 2 }, "3"],
      [14, 15, { format: "csv", record: 2, line: 2, field: 3 }, "😀"],
      [16, 17, { format: "csv", record: 3, line: 3, field: 1 }, "배"],
      [18, 19, { format: "csv", record: 3, line: 3, field: 2 }, "5"],
    ],
  },
  "normal-json.json": {
    text: '{\n  "이름": "합성 문서",\n  "목록": [1, 2, 3],\n  "이모지": "😀"\n}\n',
    blocks: [
      [0, 1, { format: "json", line: 1 }, "{"],
      [2, 18, { format: "json", line: 2 }, '  "이름": "합성 문서",'],
      [19, 37, { format: "json", line: 3 }, '  "목록": [1, 2, 3],'],
      [38, 50, { format: "json", line: 4 }, '  "이모지": "😀"'],
      [51, 52, { format: "json", line: 5 }, "}"],
    ],
  },
  "normal-pdf.pdf": {
    text: "한글 문서 첫 쪽 😀\n둘째 줄\n\nsecond page é combining",
    blocks: [
      [0, 16, { format: "pdf", page: 1 }, "한글 문서 첫 쪽 😀\n둘째 줄"],
      [18, 42, { format: "pdf", page: 2 }, "second page é combining"],
    ],
  },
  "normal-docx.docx": {
    text: "합성 문서 제목\n첫 문단 😀 한글\n칸 A\n칸 B\n칸 C\n칸 D",
    blocks: [
      [
        0,
        8,
        { format: "docx", paragraph: 0, style: "heading 1", headingLevel: 1 },
        "합성 문서 제목",
      ],
      [9, 18, { format: "docx", paragraph: 1 }, "첫 문단 😀 한글"],
      [19, 22, { format: "docx", paragraph: 3, table: { index: 0, row: 0, cell: 0 } }, "칸 A"],
      [23, 26, { format: "docx", paragraph: 4, table: { index: 0, row: 0, cell: 1 } }, "칸 B"],
      [27, 30, { format: "docx", paragraph: 5, table: { index: 0, row: 1, cell: 0 } }, "칸 C"],
      [31, 34, { format: "docx", paragraph: 6, table: { index: 0, row: 1, cell: 1 } }, "칸 D"],
    ],
  },
  "normal-xlsx.xlsx": {
    text: "합성 시트\n이름\t수량\t날짜\n사과\t3\t2026-03-01T00:00:00.000Z\n😀 이모지\tTRUE\n\n둘째\né\t1.5",
    blocks: [
      [0, 5, { format: "xlsx", sheet: "합성 시트" }, "합성 시트"],
      [6, 8, { format: "xlsx", sheet: "합성 시트", cell: "A1", row: 1, column: 1 }, "이름"],
      [9, 11, { format: "xlsx", sheet: "합성 시트", cell: "B1", row: 1, column: 2 }, "수량"],
      [12, 14, { format: "xlsx", sheet: "합성 시트", cell: "C1", row: 1, column: 3 }, "날짜"],
      [15, 17, { format: "xlsx", sheet: "합성 시트", cell: "A2", row: 2, column: 1 }, "사과"],
      [18, 19, { format: "xlsx", sheet: "합성 시트", cell: "B2", row: 2, column: 2 }, "3"],
      [
        20,
        44,
        { format: "xlsx", sheet: "합성 시트", cell: "C2", row: 2, column: 3 },
        "2026-03-01T00:00:00.000Z",
      ],
      [45, 50, { format: "xlsx", sheet: "합성 시트", cell: "A3", row: 3, column: 1 }, "😀 이모지"],
      [51, 55, { format: "xlsx", sheet: "합성 시트", cell: "B3", row: 3, column: 2 }, "TRUE"],
      [57, 59, { format: "xlsx", sheet: "둘째" }, "둘째"],
      [60, 62, { format: "xlsx", sheet: "둘째", cell: "A1", row: 1, column: 1 }, "é"],
      [63, 66, { format: "xlsx", sheet: "둘째", cell: "B1", row: 1, column: 2 }, "1.5"],
    ],
  },
};

const fixtures = generateFixtures();
const run = (name: string, bytes: Uint8Array): Promise<NormalizeResult> =>
  normalizeDocument({ kind: "bytes", bytes, name });

describe("fixture generator (C10, R20)", () => {
  it("produces the same bytes on two runs, even when the clock moved between them", async () => {
    const first = generateFixtures();
    await sleep(5);
    const second = generateFixtures();
    expect([...second.keys()]).toEqual([...first.keys()]);
    for (const [name, bytes] of first) {
      expect(Buffer.from(second.get(name) as Uint8Array).equals(Buffer.from(bytes)), name).toBe(
        true,
      );
    }
  });

  it("equals the committed fixtures/documents/ file for file, byte for byte", () => {
    const committed = readdirSync(committedDir).sort();
    expect(committed).toEqual([...fixtures.keys()].sort());
    for (const [name, bytes] of fixtures) {
      const onDisk = readFileSync(join(committedDir, name));
      expect(onDisk.equals(Buffer.from(bytes)), name).toBe(true);
    }
  });

  it("is marked -text in .gitattributes for every file, so core.autocrlf cannot rewrite it (C10, R20)", () => {
    const repo = fileURLToPath(new URL("../../..", import.meta.url));
    const names = readdirSync(committedDir);
    const out = execFileSync(
      "git",
      ["check-attr", "text", "--", ...names.map((n) => `fixtures/documents/${n}`)],
      { cwd: repo, encoding: "utf8" },
    );
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(names.length);
    for (const line of lines) expect(line, line).toMatch(/: text: unset$/);
  });

  it("keeps .jsonl out of fixtures/documents/ (the synthetic manifest reads only fixtures/*.jsonl)", () => {
    expect([...fixtures.keys()].filter((name) => name.endsWith(".jsonl"))).toEqual([]);
    expect(readdirSync(committedDir).filter((name) => name.endsWith(".jsonl"))).toEqual([]);
  });

  it("covers every format with a normal, a limitation and a corrupt-or-refused fixture", () => {
    const formats = ["txt", "md", "html", "csv", "json", "pdf", "docx", "xlsx"];
    for (const ext of formats) {
      for (const kind of ["normal", "limit", "corrupt"]) {
        if (ext === "json" && kind === "limit") continue; // JSON has no limitation code (spec table)
        const has = [...fixtures.keys()].some(
          (name) => name.startsWith(`${kind}-`) && name.endsWith(`.${ext}`),
        );
        expect(has, `${kind} ${ext}`).toBe(true);
      }
    }
  });
});

describe("per-fixture outcomes (C1, C3, C8, C10)", () => {
  it("has an expected outcome for every fixture and no stale entries", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...fixtures.keys()].sort());
  });

  it.each([...fixtures.keys()])("%s", async (name) => {
    const bytes = fixtures.get(name) as Uint8Array;
    const expected = EXPECTED[name] as Outcome;
    const first = await run(name, bytes);
    const second = await run(name, bytes);
    expect(second).toEqual(first);

    expect(first.ok, name).toBe(expected.ok);
    if (!first.ok) {
      expect(first.error.code).toBe(expected.code);
      expect(first).not.toHaveProperty("document");
      return;
    }
    const doc = first.document;
    expect(doc.text).not.toContain("�");
    if (expected.blocks !== undefined) expect(doc.blocks).toHaveLength(expected.blocks);
    if (expected.limitations !== undefined) expect(doc.limitations).toEqual(expected.limitations);
    if (expected.encoding !== undefined) expect(doc.encoding).toEqual(expected.encoding);
    if (expected.metadata !== undefined) expect(doc.metadata).toEqual(expected.metadata);
  });

  it("has an exact table for the normal fixture of every format", () => {
    const formats = ["txt", "md", "html", "csv", "json", "pdf", "docx", "xlsx"];
    for (const ext of formats) {
      expect(
        Object.keys(EXACT).some((n) => n.startsWith("normal-") && n.endsWith(`.${ext}`)),
        ext,
      ).toBe(true);
    }
  });

  it.each(Object.keys(EXACT))("%s: exact text, locators and slices (C1)", async (name) => {
    const result = await run(name, fixtures.get(name) as Uint8Array);
    if (!result.ok) throw new Error("expected success");
    const { text, blocks } = result.document;
    const expected = EXACT[name] as { text: string; blocks: ExactBlock[] };
    expect(text).toBe(expected.text);
    expect(blocks.map((b) => [b.start, b.end, b.locator])).toEqual(
      expected.blocks.map(([start, end, locator]) => [start, end, locator]),
    );
    expect(blocks.map((b) => codePointSlice(text, b.start, b.end))).toEqual(
      expected.blocks.map(([, , , slice]) => slice),
    );
  });

  it("reads the committed file by path with the same result as the in-memory bytes", async () => {
    for (const name of fixtures.keys()) {
      const viaPath = await normalizeDocument({
        kind: "path",
        path: join(committedDir, name),
        allowedRoot: committedDir,
      });
      expect(viaPath, basename(name)).toEqual(await run(name, fixtures.get(name) as Uint8Array));
    }
  });
});

describe("text fixtures (C3, R7, R8)", () => {
  it("decodes UTF-8, UTF-8 BOM, UTF-16LE, UTF-16BE and CRLF files to the same text and blocks", async () => {
    const names = [
      "normal-text-utf8.txt",
      "normal-text-utf8-bom.txt",
      "normal-text-utf16le-bom.txt",
      "normal-text-utf16be-bom.txt",
      "normal-text-crlf.txt",
    ];
    const results = await Promise.all(names.map((n) => run(n, fixtures.get(n) as Uint8Array)));
    for (const r of results) {
      if (!r.ok) throw new Error("expected success");
      expect(r.document.text).toBe(TXT_TEXT);
      expect(r.document.blocks).toEqual(
        (results[0] as { ok: true; document: { blocks: unknown } }).document.blocks,
      );
    }
  });

  it("reads the CP949 extension syllable the built-in EUC-KR decoder cannot", async () => {
    const r = await run(
      "limit-text-cp949-extension.txt",
      fixtures.get("limit-text-cp949-extension.txt") as Uint8Array,
    );
    if (!r.ok) throw new Error("expected success");
    expect(r.document.text).toContain("똠");
  });
});
