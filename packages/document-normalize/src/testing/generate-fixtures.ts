// Deterministic generator of the synthetic document fixtures (I02A-R20).
// `pnpm --filter @pki/document-normalize build:fixtures` writes fixtures/documents/.
// Everything is invented. Same code -> same bytes: zip times and PDF dates are fixed
// and nothing here reads the clock or a random source. Attack inputs (zip bombs,
// `../` entries, lying sizes) are not written; tests build them in memory.
import iconv from "iconv-lite";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDocx, buildXlsx, buildZip, heading } from "./ooxml-builder.ts";
import { buildPdf, truncatePdf } from "./pdf-builder.ts";

export const FIXTURES_DIR = new URL("../../../../fixtures/documents/", import.meta.url);

/** The global the hostile HTML's inline script tries to set; it must stay unset. */
export const HTML_SCRIPT_MARKER = "__pkiHtmlMarker";
/** A string that appears only inside the hostile HTML's script and iframe bodies. */
export const HTML_SCRIPT_SENTINEL = "SCRIPT-BODY-SENTINEL";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

function utf16(text: string, order: "le" | "be"): Uint8Array {
  const le = Buffer.from(text, "utf16le");
  if (order === "le") return Uint8Array.from([0xff, 0xfe, ...le]);
  const be = Buffer.from(le).swap16();
  return Uint8Array.from([0xfe, 0xff, ...be]);
}

const withBom = (text: string): Uint8Array => Uint8Array.from([0xef, 0xbb, 0xbf, ...enc(text)]);
const cp949 = (text: string): Uint8Array => iconv.encode(text, "cp949");

const TXT_TEXT = "합성 문서 제목\n첫 줄 😀 이모지 뒤의 글\n\n결합 문자 é 와 끝\n";

const MARKDOWN =
  "# 합성 마크다운\n\n첫 문단 😀 한글 é.\n\n- 항목 하나\n- 항목 둘\n\n```\ncode line\n```\n";
const MARKDOWN_LIMIT =
  "# 한계 표시\n\n<script>globalThis.mdMarker = 1</script>\n\n" +
  "문장 속 <b>태그</b> 와 ![그림 설명](https://example.invalid/pic.png) 그리고 [링크 글](https://example.invalid/page).\n";

const HTML =
  '<!doctype html>\n<html lang="ko">\n<head><meta charset="utf-8"><title>합성 HTML 문서</title>' +
  '<meta name="author" content="가상 작성자"></head>\n<body>\n<h1>제목 😀</h1>\n' +
  "<p>첫 문단입니다.   공백이   줄어듭니다.</p>\n<ul><li>항목 하나</li><li>항목 둘</li></ul>\n" +
  "<table><tr><td>칸 A</td><td>칸 B</td></tr></table>\n</body>\n</html>\n";

const HTML_HOSTILE =
  '<!doctype html>\n<html><head><title>합성 위험 HTML</title>\n<link rel="stylesheet" href="https://example.invalid/a.css">\n' +
  "<style>.x { background: url(https://example.invalid/bg.png); }</style>\n</head>\n<body>\n" +
  "<h1>위험 요소가 든 문서</h1>\n" +
  `<script>globalThis.${HTML_SCRIPT_MARKER} = true; var s = "${HTML_SCRIPT_SENTINEL}";</script>\n` +
  `<p onclick="globalThis.${HTML_SCRIPT_MARKER} = true">보이는 글</p>\n` +
  `<img src="https://example.invalid/i.png" onerror="globalThis.${HTML_SCRIPT_MARKER} = true">\n` +
  '<iframe src="https://example.invalid/f.html">IFRAME-SENTINEL</iframe>\n' +
  '<object data="https://example.invalid/o.swf"></object>\n' +
  "<svg><text>SVG-SENTINEL</text></svg>\n<noscript>NOSCRIPT-SENTINEL</noscript>\n" +
  "<template><p>TEMPLATE-SENTINEL</p></template>\n" +
  '<a href="https://example.invalid/link">링크 글</a>\n</body></html>\n';

const CSV = "이름,수량,비고\n사과,3,😀\n배,5,\n";
const CSV_RAGGED = "a,b,c\nd,e\nf,g,h,i\n";
const CSV_EUCKR = "이름,수량\n똠,1\n";

const JSON_TEXT = '{\n  "이름": "합성 문서",\n  "목록": [1, 2, 3],\n  "이모지": "😀"\n}\n';

const NOT_XML = "이것은 XML이 아니다 <<<";

/** All fixtures, name -> bytes, in a fixed (sorted) order. */
export function generateFixtures(): Map<string, Uint8Array> {
  const pdf = buildPdf({
    pages: ["한글 문서 첫 쪽 😀\n둘째 줄", "second page é combining"],
    info: {
      title: "합성 PDF 문서",
      author: "가상 작성자",
      creationDate: "D:20260301090000+09'00'",
    },
  });
  const files: [string, Uint8Array][] = [
    // Text encodings (R7): UTF-8, UTF-8 BOM, UTF-16LE/BE BOM, CRLF; EUC-KR and CP949 fall back.
    ["normal-text-utf8.txt", enc(TXT_TEXT)],
    ["normal-text-utf8-bom.txt", withBom(TXT_TEXT)],
    ["normal-text-utf16le-bom.txt", utf16(TXT_TEXT, "le")],
    ["normal-text-utf16be-bom.txt", utf16(TXT_TEXT, "be")],
    ["normal-text-crlf.txt", enc(TXT_TEXT.replaceAll("\n", "\r\n"))],
    ["limit-text-euckr.txt", cp949("한글 문서 하나\n둘째 줄 입니다\n")],
    ["limit-text-cp949-extension.txt", cp949("똠방 각하\n가나다 라마바\n")],
    ["corrupt-text-latin1.txt", Uint8Array.from(Buffer.from("café au lait, naïve\n", "latin1"))],
    ["corrupt-bytes.txt", Uint8Array.of(0x80, 0x81, 0x82, 0x0a)],
    ["corrupt-bytes.md", Uint8Array.of(0x80, 0x81, 0x82, 0x0a)],
    ["corrupt-bytes.html", Uint8Array.of(0x80, 0x81, 0x82, 0x0a)],
    // Markdown
    ["normal-markdown.md", enc(MARKDOWN)],
    ["limit-markdown-raw-html-and-links.md", enc(MARKDOWN_LIMIT)],
    // HTML
    ["normal-html.html", enc(HTML)],
    ["limit-html-hostile.html", enc(HTML_HOSTILE)],
    // CSV, JSON
    ["normal-csv.csv", enc(CSV)],
    ["limit-csv-ragged.csv", enc(CSV_RAGGED)],
    ["limit-csv-euckr.csv", cp949(CSV_EUCKR)],
    ["corrupt-csv-unclosed-quote.csv", enc('a,"b\nc,d\n')],
    ["normal-json.json", enc(JSON_TEXT)],
    ["corrupt-json-invalid.json", enc('{"a": [1, 2,}\n')],
    // PDF
    ["normal-pdf.pdf", pdf],
    [
      "limit-pdf-page-without-text.pdf",
      buildPdf({
        pages: ["first page", "", "third page"],
        linkUri: "https://example.invalid/link",
      }),
    ],
    ["corrupt-pdf-truncated.pdf", truncatePdf(pdf, 0.5)],
    ["corrupt-pdf-encrypted.pdf", buildPdf({ pages: ["secret"], encrypt: true })],
    ["corrupt-pdf-not-pdf.pdf", enc("plain text, not a PDF\n")],
    // DOCX
    [
      "normal-docx.docx",
      buildDocx({
        body: [
          heading(1, "합성 문서 제목"),
          { text: "첫 문단 😀 한글" },
          { text: "" },
          {
            table: [
              ["칸 A", "칸 B"],
              ["칸 C", "칸 D"],
            ],
          },
        ],
        core: {
          title: "합성 DOCX 문서",
          author: "가상 작성자",
          created: "2026-03-01T09:00:00Z",
          modified: "2026-03-02T09:00:00Z",
        },
      }),
    ],
    [
      "limit-docx-omitted-parts.docx",
      buildDocx({
        body: [{ text: "본문 문단" }],
        headers: ["머리글 글"],
        footers: ["바닥글 글"],
        footnotes: ["각주 글"],
        comments: ["메모 글"],
        images: 1,
        externalImage: "https://example.invalid/pic.png",
      }),
    ],
    ["corrupt-docx-not-zip.docx", enc("not a zip archive\n")],
    ["corrupt-docx-no-body.docx", buildZip([{ name: "hello.txt", data: "no document part" }])],
    // XLSX
    [
      "normal-xlsx.xlsx",
      buildXlsx({
        sheets: [
          {
            name: "합성 시트",
            rows: [
              ["이름", "수량", "날짜"],
              ["사과", 3, new Date(Date.UTC(2026, 2, 1))],
              ["😀 이모지", true, null],
            ],
          },
          { name: "둘째", rows: [["é", 1.5]] },
        ],
        core: {
          title: "합성 XLSX 문서",
          author: "가상 작성자",
          created: "2026-03-01T09:00:00Z",
          modified: "2026-03-02T09:00:00Z",
        },
      }),
    ],
    [
      "limit-xlsx-formula-merge-hidden.xlsx",
      buildXlsx({
        sheets: [
          {
            name: "계산",
            rows: [
              [1, 2, { formula: "A1+B1", value: 3 }],
              ["병합", null],
            ],
            merges: ["A2:B2"],
          },
          { name: "숨김", rows: [["숨긴 시트의 글"]], hidden: true },
        ],
      }),
    ],
    ["corrupt-xlsx-broken-workbook.xlsx", buildZip([{ name: "xl/workbook.xml", data: NOT_XML }])],
  ];
  return new Map(files.sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Writes the fixtures into `dir` and removes files there that are no longer generated. */
export function writeFixtures(dir: string): string[] {
  const fixtures = generateFixtures();
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) if (!fixtures.has(name)) unlinkSync(join(dir, name));
  for (const [name, bytes] of fixtures) writeFileSync(join(dir, name), bytes);
  return [...fixtures.keys()];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const names = writeFixtures(fileURLToPath(FIXTURES_DIR));
  console.log(`wrote ${names.length} fixtures`);
}
