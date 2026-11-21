// Deterministic in-memory builder of minimal PDFs for tests and fixtures (I02A-T03).
// Same options -> same bytes: dates are the caller's, object order is fixed, xref
// offsets are computed. Text goes through a Type0 font whose ToUnicode map is
// generated from the text itself, so Korean, emoji and combining marks need no font file.

export interface PdfInfo {
  title?: string;
  author?: string;
  /** Raw PDF date string, e.g. `D:20240102030405+09'00'`. */
  creationDate?: string;
  modDate?: string;
}

export interface BuildPdfOptions {
  /** One entry per page; `\n` starts a new line; `""` is a page that draws a shape but has no text. */
  pages: string[];
  info?: PdfInfo;
  /** Adds a URI link annotation to page 1 (for the "no network" test). */
  linkUri?: string;
  /** Adds a Standard-security /Encrypt dictionary that a blank password does not open. */
  encrypt?: boolean;
}

const hex4 = (n: number): string => n.toString(16).padStart(4, "0");

function utf16beHex(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) out += hex4(text.charCodeAt(i));
  return out;
}

/** A PDF text string: UTF-16BE with a byte order mark, as hex. */
const textString = (text: string): string => `<FEFF${utf16beHex(text)}>`;

const literalString = (text: string): string => `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`;

export function buildPdf(options: BuildPdfOptions): Uint8Array {
  const cids = new Map<number, number>();
  for (const page of options.pages) {
    for (const ch of page) {
      const cp = ch.codePointAt(0) as number;
      if (cp !== 10 && !cids.has(cp)) cids.set(cp, cids.size + 1);
    }
  }

  const bfchars = [...cids].map(
    ([cp, cid]) => `<${hex4(cid)}> <${utf16beHex(String.fromCodePoint(cp))}>`,
  );
  const bfBlocks: string[] = [];
  for (let i = 0; i < bfchars.length; i += 100) {
    const chunk = bfchars.slice(i, i + 100);
    bfBlocks.push(`${chunk.length} beginbfchar\n${chunk.join("\n")}\nendbfchar`);
  }
  const toUnicode = [
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
    "/CMapName /Adobe-Identity-UCS def /CMapType 2 def",
    "1 begincodespacerange <0000> <FFFF> endcodespacerange",
    ...bfBlocks,
    "endcmap CMapName currentdict /CMap defineresource pop end end",
  ].join("\n");

  const contents = options.pages.map((page) => {
    if (page === "") return "0 0 100 100 re f";
    return page
      .split("\n")
      .map((line, i) => {
        if (line === "") return "";
        const codes = [...line].map((ch) => hex4(cids.get(ch.codePointAt(0) as number) as number));
        return `BT /F1 12 Tf 72 ${720 - 18 * i} Td <${codes.join("")}> Tj ET`;
      })
      .filter((s) => s !== "")
      .join("\n");
  });

  // Object numbers: 1 catalog, 2 pages, 3 font, 4 CID font, 5 descriptor, 6 ToUnicode,
  // then per page (page, content), then optional annotation, info, encrypt.
  const firstPage = 7;
  const pageObj = (i: number) => firstPage + 2 * i;
  const next = firstPage + 2 * options.pages.length;
  const annotObj = options.linkUri === undefined ? 0 : next;
  const infoObj = options.info === undefined ? 0 : next + (annotObj ? 1 : 0);
  const encryptObj = options.encrypt ? next + (annotObj ? 1 : 0) + (infoObj ? 1 : 0) : 0;

  const objects = new Map<number, string>();
  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objects.set(
    2,
    `<< /Type /Pages /Count ${options.pages.length} /Kids [${options.pages
      .map((_, i) => `${pageObj(i)} 0 R`)
      .join(" ")}] >>`,
  );
  objects.set(
    3,
    "<< /Type /Font /Subtype /Type0 /BaseFont /Fixture /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 6 0 R >>",
  );
  objects.set(
    4,
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Fixture /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 5 0 R /DW 1000 /CIDToGIDMap /Identity >>",
  );
  objects.set(
    5,
    "<< /Type /FontDescriptor /FontName /Fixture /Flags 4 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>",
  );
  objects.set(6, `<< /Length ${toUnicode.length} >>\nstream\n${toUnicode}\nendstream`);
  options.pages.forEach((_, i) => {
    const annots = i === 0 && annotObj ? ` /Annots [${annotObj} 0 R]` : "";
    objects.set(
      pageObj(i),
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageObj(i) + 1} 0 R${annots} >>`,
    );
    const body = contents[i] as string;
    objects.set(pageObj(i) + 1, `<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
  });
  if (annotObj) {
    objects.set(
      annotObj,
      `<< /Type /Annot /Subtype /Link /Rect [72 700 200 720] /Border [0 0 0] /A << /S /URI /URI ${literalString(options.linkUri as string)} >> >>`,
    );
  }
  if (infoObj) {
    const info = options.info as PdfInfo;
    const fields: string[] = [];
    if (info.title !== undefined) fields.push(`/Title ${textString(info.title)}`);
    if (info.author !== undefined) fields.push(`/Author ${textString(info.author)}`);
    if (info.creationDate !== undefined)
      fields.push(`/CreationDate ${literalString(info.creationDate)}`);
    if (info.modDate !== undefined) fields.push(`/ModDate ${literalString(info.modDate)}`);
    objects.set(infoObj, `<< ${fields.join(" ")} >>`);
  }
  if (encryptObj) {
    const blob = "0123456789ABCDEF".repeat(4);
    objects.set(
      encryptObj,
      `<< /Filter /Standard /V 1 /R 2 /Length 40 /P -4 /O <${blob}> /U <${blob}> >>`,
    );
  }

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  const count = Math.max(...objects.keys()) + 1;
  for (let n = 1; n < count; n++) {
    offsets[n] = out.length;
    out += `${n} 0 obj\n${objects.get(n) as string}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) out += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${count} /Root 1 0 R`;
  if (infoObj) out += ` /Info ${infoObj} 0 R`;
  if (encryptObj)
    out += ` /Encrypt ${encryptObj} 0 R /ID [<00112233445566778899AABBCCDDEEFF> <00112233445566778899AABBCCDDEEFF>]`;
  out += ` >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** The first `keep` bytes, or the first `keep` fraction of the file when `0 < keep < 1`. */
export function truncatePdf(bytes: Uint8Array, keep: number): Uint8Array {
  return bytes.slice(0, keep > 0 && keep < 1 ? Math.floor(bytes.length * keep) : keep);
}
