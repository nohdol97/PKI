// Deterministic in-memory builder of minimal DOCX/XLSX packages and of crafted
// (malicious) ZIP archives. Used by tests and by the fixture generator (T06).
// Same input -> same bytes: zip timestamps are fixed and nothing reads the clock.
import { crc32, deflateRawSync } from "node:zlib";

const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1; // 2020-01-01

const utf8 = (value: string | Uint8Array): Uint8Array =>
  typeof value === "string" ? new TextEncoder().encode(value) : value;

export interface ZipEntrySpec {
  name: string;
  /** Entry content (a string is UTF-8 encoded). Defaults to empty. */
  data?: Uint8Array | string;
  /** Default `deflate`. */
  method?: "store" | "deflate";
  /** Lies for crafted archives: sizes written into the headers instead of the true ones. */
  declaredSize?: number;
  declaredCompressedSize?: number;
  /** Set the "encrypted" bit of the general-purpose flag (the content is not really encrypted). */
  encrypted?: boolean;
  /** Name written into the local header when it should differ from the central directory's. */
  localName?: string;
  /** Raw name bytes (e.g. with NUL); overrides `name` in both headers. */
  rawName?: Uint8Array;
}

function u16(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);
}
function u32(value: number): Uint8Array {
  return Uint8Array.of(
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  );
}
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Builds a ZIP archive byte by byte so that headers can lie (sizes, flags, names). */
export function buildZip(entries: ZipEntrySpec[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const content = utf8(entry.data ?? "");
    const method = entry.method ?? "deflate";
    const stored = method === "store" ? content : deflateRawSync(content);
    const flags = (entry.encrypted ? 1 : 0) | 0x800;
    const size = entry.declaredSize ?? content.length;
    const compressed = entry.declaredCompressedSize ?? stored.length;
    const crc = crc32(content);
    const centralName = entry.rawName ?? utf8(entry.name);
    const localName = entry.rawName ?? utf8(entry.localName ?? entry.name);
    const common = (name: Uint8Array) => [
      u16(20), // version needed
      u16(flags),
      u16(method === "store" ? 0 : 8),
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(crc),
      u32(compressed),
      u32(size),
      u16(name.length),
    ];
    const local = concat([u32(0x04034b50), ...common(localName), u16(0), localName, stored]);
    centrals.push(
      concat([
        u32(0x02014b50),
        u16(20), // version made by
        ...common(centralName),
        u16(0), // extra
        u16(0), // comment
        u16(0), // disk
        u16(0), // internal attributes
        u32(0), // external attributes
        u32(offset),
        centralName,
      ]),
    );
    locals.push(local);
    offset += local.length;
  }
  const directory = concat(centrals);
  return concat([
    ...locals,
    directory,
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(directory.length),
    u32(offset),
    u16(0),
  ]);
}

// --- OOXML parts shared by DOCX and XLSX ---

export interface CoreProps {
  title?: string;
  author?: string;
  /** W3CDTF text, written as is (e.g. `2026-03-01T09:00:00Z`). */
  created?: string;
  modified?: string;
}

const escapeXml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function coreXml(core: CoreProps): string {
  const fields = [
    core.title !== undefined ? `<dc:title>${escapeXml(core.title)}</dc:title>` : "",
    core.author !== undefined ? `<dc:creator>${escapeXml(core.author)}</dc:creator>` : "",
    core.created !== undefined
      ? `<dcterms:created xsi:type="dcterms:W3CDTF">${core.created}</dcterms:created>`
      : "",
    core.modified !== undefined
      ? `<dcterms:modified xsi:type="dcterms:W3CDTF">${core.modified}</dcterms:modified>`
      : "",
  ].join("");
  return (
    XML_HEAD +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    fields +
    "</cp:coreProperties>"
  );
}

const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function relsXml(rels: { id: string; type: string; target: string; external?: boolean }[]): string {
  return (
    XML_HEAD +
    `<Relationships xmlns="${REL_NS}">` +
    rels
      .map(
        (r) =>
          `<Relationship Id="${r.id}" Type="${r.type}" Target="${escapeXml(r.target)}"` +
          `${r.external ? ' TargetMode="External"' : ""}/>`,
      )
      .join("") +
    "</Relationships>"
  );
}

function contentTypesXml(overrides: { part: string; type: string }[]): string {
  return (
    XML_HEAD +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    overrides.map((o) => `<Override PartName="/${o.part}" ContentType="${o.type}"/>`).join("") +
    "</Types>"
  );
}

// --- DOCX ---

export interface DocxStyle {
  id: string;
  name: string;
}
export interface DocxParagraph {
  text: string;
  style?: DocxStyle;
  /** Paragraph texts of a text box anchored in this paragraph. */
  textbox?: string[];
}
/** A table: rows of cells; a cell is one paragraph text or a list of paragraph texts. */
export interface DocxTable {
  table: (string | string[])[][];
}
export type DocxBlock = DocxParagraph | DocxTable;

export interface DocxSpec {
  body: DocxBlock[];
  core?: CoreProps;
  /** Text of header / footer parts (one part per item). */
  headers?: string[];
  footers?: string[];
  /** Real footnotes / endnotes (separator notes are written by `separatorNotes`). */
  footnotes?: string[];
  endnotes?: string[];
  /** Write notes parts that hold only Word's separator notes (no real note). */
  separatorNotes?: boolean;
  comments?: string[];
  /** Number of embedded pictures; they are added in a paragraph appended after `body`. */
  images?: number;
  /** An external picture link (TargetMode="External") with this target. */
  externalImage?: string;
  /** Extra archive entries (appended). */
  extraEntries?: ZipEntrySpec[];
}

export const heading = (level: number, text: string): DocxParagraph => ({
  text,
  style: { id: `Heading${level}`, name: `heading ${level}` },
});

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const R_NS = `xmlns:r="${OFFICE_REL}"`;
const WORD_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml";

/** Runs for a text: `\t` becomes a tab and `\n` a line break. */
function runsXml(text: string): string {
  return text
    .split(/(\t|\n)/)
    .map((piece) => {
      if (piece === "\t") return "<w:r><w:tab/></w:r>";
      if (piece === "\n") return "<w:r><w:br/></w:r>";
      return piece === "" ? "" : `<w:r><w:t xml:space="preserve">${escapeXml(piece)}</w:t></w:r>`;
    })
    .join("");
}

function paragraphXml(text: string, style?: DocxStyle, textbox: string[] = []): string {
  const props = style ? `<w:pPr><w:pStyle w:val="${escapeXml(style.id)}"/></w:pPr>` : "";
  const box =
    textbox.length > 0
      ? `<w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml"><v:textbox><w:txbxContent>${textbox
          .map((t) => paragraphXml(t))
          .join("")}</w:txbxContent></v:textbox></v:shape></w:pict></w:r>`
      : "";
  return `<w:p>${props}${runsXml(text)}${box}</w:p>`;
}

function stylesXml(used: DocxStyle[]): string {
  return (
    XML_HEAD +
    `<w:styles ${W_NS}>` +
    used
      .map(
        (s) =>
          `<w:style w:type="paragraph" w:styleId="${escapeXml(s.id)}"><w:name w:val="${escapeXml(s.name)}"/></w:style>`,
      )
      .join("") +
    "</w:styles>"
  );
}

function notesXml(root: "footnotes" | "endnotes", notes: string[], separators: boolean): string {
  const item = root === "footnotes" ? "footnote" : "endnote";
  const sep = separators
    ? `<w:${item} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:${item}>` +
      `<w:${item} w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:${item}>`
    : "";
  const real = notes
    .map((text, i) => `<w:${item} w:id="${i + 1}">${paragraphXml(text)}</w:${item}>`)
    .join("");
  return XML_HEAD + `<w:${root} ${W_NS}>${sep}${real}</w:${root}>`;
}

const PNG_1X1 = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

function drawingXml(rid: string, kind: "embed" | "link"): string {
  return (
    '<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">' +
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill>' +
    `<a:blip r:${kind}="${rid}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
  );
}

export function buildDocx(spec: DocxSpec): Uint8Array {
  const styles = new Map<string, DocxStyle>();
  const useStyle = (style?: DocxStyle) => {
    if (style) styles.set(style.id, style);
  };

  const blocks = spec.body.map((block) => {
    if ("table" in block) {
      const rows = block.table
        .map((row) => {
          const cells = row
            .map((cell) => {
              const texts = Array.isArray(cell) ? cell : [cell];
              return `<w:tc>${texts.map((t) => paragraphXml(t)).join("")}</w:tc>`;
            })
            .join("");
          return `<w:tr>${cells}</w:tr>`;
        })
        .join("");
      return `<w:tbl>${rows}</w:tbl>`;
    }
    useStyle(block.style);
    return paragraphXml(block.text, block.style, block.textbox);
  });

  const rels: { id: string; type: string; target: string; external?: boolean }[] = [
    { id: "rIdStyles", type: `${OFFICE_REL}/styles`, target: "styles.xml" },
  ];
  const overrides = [
    { part: "word/document.xml", type: `${WORD_TYPE}.document.main+xml` },
    { part: "word/styles.xml", type: `${WORD_TYPE}.styles+xml` },
    {
      part: "docProps/core.xml",
      type: "application/vnd.openxmlformats-package.core-properties+xml",
    },
  ];
  const parts: ZipEntrySpec[] = [];

  const partsOf = (kind: "header" | "footer", texts: string[] = []) =>
    texts.forEach((text, i) => {
      const part = `word/${kind}${i + 1}.xml`;
      const root = kind === "header" ? "hdr" : "ftr";
      parts.push({
        name: part,
        data: XML_HEAD + `<w:${root} ${W_NS}>${paragraphXml(text)}</w:${root}>`,
      });
      rels.push({
        id: `rId${kind}${i + 1}`,
        type: `${OFFICE_REL}/${kind}`,
        target: `${kind}${i + 1}.xml`,
      });
      overrides.push({ part, type: `${WORD_TYPE}.${kind}+xml` });
    });
  partsOf("header", spec.headers);
  partsOf("footer", spec.footers);

  for (const root of ["footnotes", "endnotes"] as const) {
    const notes = spec[root] ?? [];
    if (notes.length === 0 && !spec.separatorNotes) continue;
    parts.push({
      name: `word/${root}.xml`,
      data: notesXml(root, notes, notes.length > 0 || spec.separatorNotes === true),
    });
    rels.push({ id: `rId${root}`, type: `${OFFICE_REL}/${root}`, target: `${root}.xml` });
    overrides.push({ part: `word/${root}.xml`, type: `${WORD_TYPE}.${root}+xml` });
  }

  if (spec.comments && spec.comments.length > 0) {
    const items = spec.comments
      .map((t, i) => `<w:comment w:id="${i}" w:author="작성자">${paragraphXml(t)}</w:comment>`)
      .join("");
    parts.push({
      name: "word/comments.xml",
      data: XML_HEAD + `<w:comments ${W_NS}>${items}</w:comments>`,
    });
    rels.push({ id: "rIdComments", type: `${OFFICE_REL}/comments`, target: "comments.xml" });
    overrides.push({ part: "word/comments.xml", type: `${WORD_TYPE}.comments+xml` });
  }

  let pictures = "";
  for (let i = 1; i <= (spec.images ?? 0); i++) {
    parts.push({ name: `word/media/image${i}.png`, data: PNG_1X1, method: "store" });
    rels.push({ id: `rIdImg${i}`, type: `${OFFICE_REL}/image`, target: `media/image${i}.png` });
    pictures += drawingXml(`rIdImg${i}`, "embed");
  }
  if (spec.externalImage !== undefined) {
    rels.push({
      id: "rIdExt",
      type: `${OFFICE_REL}/image`,
      target: spec.externalImage,
      external: true,
    });
    pictures += drawingXml("rIdExt", "link");
  }
  if (pictures) blocks.push(`<w:p>${pictures}</w:p>`);

  const document =
    XML_HEAD + `<w:document ${W_NS} ${R_NS}><w:body>${blocks.join("")}</w:body></w:document>`;

  return buildZip([
    { name: "[Content_Types].xml", data: contentTypesXml(overrides) },
    {
      name: "_rels/.rels",
      data: relsXml([
        { id: "rId1", type: `${OFFICE_REL}/officeDocument`, target: "word/document.xml" },
        {
          id: "rId2",
          type: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
          target: "docProps/core.xml",
        },
      ]),
    },
    { name: "word/document.xml", data: document },
    { name: "word/_rels/document.xml.rels", data: relsXml(rels) },
    { name: "word/styles.xml", data: stylesXml([...styles.values()]) },
    { name: "docProps/core.xml", data: coreXml(spec.core ?? {}) },
    ...parts,
    ...(spec.extraEntries ?? []),
  ]);
}

// --- XLSX ---

/** A cell: text, number, boolean, date, a formula with its cached value, or `null` (empty). */
export type XlsxCell =
  string | number | boolean | Date | { formula: string; value: string | number | boolean } | null;

export interface XlsxSheetSpec {
  name: string;
  /** `rows[r][c]` sits at row r+1, column c+1; `null` leaves the cell empty. */
  rows: XlsxCell[][];
  /** Merged ranges such as `A1:B1`. */
  merges?: string[];
  hidden?: boolean | "veryHidden";
}
export interface XlsxSpec {
  sheets: XlsxSheetSpec[];
  core?: CoreProps;
  extraEntries?: ZipEntrySpec[];
}

const SHEET_NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const SHEET_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml";

export function columnLetters(column: number): string {
  let letters = "";
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

export function buildXlsx(spec: XlsxSpec): Uint8Array {
  const strings: string[] = [];
  const stringIndex = (text: string): number => {
    const found = strings.indexOf(text);
    if (found >= 0) return found;
    strings.push(text);
    return strings.length - 1;
  };

  const cellXml = (address: string, cell: XlsxCell): string => {
    if (cell === null) return "";
    if (typeof cell === "string") {
      return `<c r="${address}" t="s"><v>${stringIndex(cell)}</v></c>`;
    }
    if (typeof cell === "number") return `<c r="${address}"><v>${cell}</v></c>`;
    if (typeof cell === "boolean") return `<c r="${address}" t="b"><v>${cell ? 1 : 0}</v></c>`;
    if (cell instanceof Date) {
      const serial = (cell.getTime() - EXCEL_EPOCH) / 86_400_000;
      return `<c r="${address}" s="1"><v>${serial}</v></c>`;
    }
    const f = `<f>${escapeXml(cell.formula)}</f>`;
    if (typeof cell.value === "string") {
      return `<c r="${address}" t="str">${f}<v>${escapeXml(cell.value)}</v></c>`;
    }
    if (typeof cell.value === "boolean") {
      return `<c r="${address}" t="b">${f}<v>${cell.value ? 1 : 0}</v></c>`;
    }
    return `<c r="${address}">${f}<v>${cell.value}</v></c>`;
  };

  const sheetXml = (sheet: XlsxSheetSpec): string => {
    const rows = sheet.rows
      .map((row, r) => {
        const cells = row
          .map((cell, c) => cellXml(`${columnLetters(c + 1)}${r + 1}`, cell))
          .join("");
        return cells ? `<row r="${r + 1}">${cells}</row>` : "";
      })
      .join("");
    const merges =
      sheet.merges && sheet.merges.length > 0
        ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>`
        : "";
    return XML_HEAD + `<worksheet ${SHEET_NS}><sheetData>${rows}</sheetData>${merges}</worksheet>`;
  };

  const sheetFiles = spec.sheets.map((sheet, i) => ({
    name: `xl/worksheets/sheet${i + 1}.xml`,
    data: sheetXml(sheet),
  }));

  const sheetsXml = spec.sheets
    .map((sheet, i) => {
      const state = sheet.hidden
        ? ` state="${sheet.hidden === true ? "hidden" : "veryHidden"}"`
        : "";
      return `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}"${state} r:id="rId${i + 1}"/>`;
    })
    .join("");
  const workbook =
    XML_HEAD + `<workbook ${SHEET_NS} ${R_NS}><sheets>${sheetsXml}</sheets></workbook>`;

  const wbRels = [
    ...spec.sheets.map((_, i) => ({
      id: `rId${i + 1}`,
      type: `${OFFICE_REL}/worksheet`,
      target: `worksheets/sheet${i + 1}.xml`,
    })),
    { id: "rIdStyles", type: `${OFFICE_REL}/styles`, target: "styles.xml" },
    { id: "rIdStrings", type: `${OFFICE_REL}/sharedStrings`, target: "sharedStrings.xml" },
  ];

  const shared =
    XML_HEAD +
    `<sst ${SHEET_NS} count="${strings.length}" uniqueCount="${strings.length}">` +
    strings.map((s) => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`).join("") +
    "</sst>";
  // cellXfs[1] is the built-in date format (numFmtId 14).
  const styles =
    XML_HEAD +
    `<styleSheet ${SHEET_NS}><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders>` +
    '<cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>';

  const overrides = [
    { part: "xl/workbook.xml", type: `${SHEET_TYPE}.sheet.main+xml` },
    ...sheetFiles.map((f) => ({ part: f.name, type: `${SHEET_TYPE}.worksheet+xml` })),
    { part: "xl/styles.xml", type: `${SHEET_TYPE}.styles+xml` },
    { part: "xl/sharedStrings.xml", type: `${SHEET_TYPE}.sharedStrings+xml` },
    {
      part: "docProps/core.xml",
      type: "application/vnd.openxmlformats-package.core-properties+xml",
    },
  ];

  return buildZip([
    { name: "[Content_Types].xml", data: contentTypesXml(overrides) },
    {
      name: "_rels/.rels",
      data: relsXml([
        { id: "rId1", type: `${OFFICE_REL}/officeDocument`, target: "xl/workbook.xml" },
        {
          id: "rId2",
          type: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
          target: "docProps/core.xml",
        },
      ]),
    },
    { name: "xl/workbook.xml", data: workbook },
    { name: "xl/_rels/workbook.xml.rels", data: relsXml(wbRels) },
    ...sheetFiles,
    { name: "xl/styles.xml", data: styles },
    { name: "xl/sharedStrings.xml", data: shared },
    { name: "docProps/core.xml", data: coreXml(spec.core ?? {}) },
    ...(spec.extraEntries ?? []),
  ]);
}
