// I02A-C10 (R8, R20) and the per-fixture outcomes of C1/C3/C8: the generator is
// deterministic, its output equals the committed fixtures/documents/, and every
// fixture normalizes to the recorded outcome, identically on a second run.
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeDocument } from "./index.ts";
import type { NormalizeResult } from "./index.ts";
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
      created: "2026-03-01T00:00:00Z",
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
  "limit-docx-omitted-parts.docx": {
    ok: true,
    blocks: 1,
    limitations: [
      { code: "docx.images-omitted" },
      { code: "docx.headers-footers-omitted" },
      { code: "docx.notes-omitted" },
      { code: "docx.comments-omitted" },
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
  "corrupt-xlsx-broken-workbook.xlsx": { ok: false, code: "corrupt" },
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
