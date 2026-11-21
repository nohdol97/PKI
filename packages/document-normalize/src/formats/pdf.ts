// PDF -> blocks, one block per page with a text layer (I02A-R10, R17, R18).
import { getDocumentProxy } from "unpdf";
import { formatFailure, TextBuilder } from "../text-builder.ts";
import type { BinaryFormatModule, DocumentMetadata, Limitation } from "../types.ts";

// Data only (I02A-R6): no eval-built glyph code, no system fonts, no font or CMap
// download. unpdf spreads these last, so they override its own defaults. Without
// `pdfjs-dist` installed unpdf adds no font/CMap URLs at all.
const OPEN_OPTIONS = {
  isEvalSupported: false,
  disableFontFace: true,
  useSystemFonts: false,
  useWorkerFetch: false,
  disableRange: true,
  disableStream: true,
  disableAutoFetch: true,
  standardFontDataUrl: undefined,
  cMapUrl: undefined,
  iccUrl: undefined,
  wasmUrl: undefined,
  verbosity: 0,
} as const;

/** `D:YYYYMMDDHHmmSSOHH'mm'` (every part after the year optional) -> ISO-8601 UTC, or undefined. */
export function pdfDateToIso(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const m =
    /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:(Z)|([+-])(\d{2})'?(\d{2})?'?)?/.exec(
      raw.trim(),
    );
  if (!m) return undefined;
  const [year, month = 1, day = 1, hour = 0, minute = 0, second = 0] = [
    m[1],
    m[2],
    m[3],
    m[4],
    m[5],
    m[6],
  ].map((v) => (v === undefined ? undefined : Number(v)));
  const offset = m[8] ? (m[8] === "-" ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10] ?? 0)) : 0;
  const ms = Date.UTC(
    year as number,
    (month as number) - 1,
    day as number,
    hour as number,
    minute as number,
    second as number,
  );
  // Date.UTC rolls month 13 or day 31 of a short month over; a PDF date that does so is invalid.
  const local = new Date(ms);
  if (
    local.getUTCMonth() !== (month as number) - 1 ||
    local.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return undefined;
  }
  const date = new Date(ms - offset * 60_000);
  return date.toISOString().replace(/\.000Z$/, "Z");
}

function metadataFrom(info: Record<string, unknown>, pageCount: number): DocumentMetadata {
  const metadata: DocumentMetadata = { pageCount };
  const text = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : undefined);
  const title = text(info.Title);
  const author = text(info.Author);
  const created = pdfDateToIso(info.CreationDate);
  const modified = pdfDateToIso(info.ModDate);
  if (title !== undefined) metadata.title = title;
  if (author !== undefined) metadata.author = author;
  if (created !== undefined) metadata.created = created;
  if (modified !== undefined) metadata.modified = modified;
  return metadata;
}

export const pdfModule: BinaryFormatModule = {
  format: "pdf",
  input: "bytes",
  async parse(bytes, limits) {
    // pdf.js takes ownership of the buffer it is given; hand it a copy.
    let pdf;
    try {
      pdf = await getDocumentProxy(new Uint8Array(bytes), OPEN_OPTIONS);
    } catch (error) {
      if (error instanceof Error && error.name === "PasswordException") {
        return formatFailure("encrypted", "the PDF is password protected");
      }
      return formatFailure("corrupt", "the PDF could not be parsed", {
        cause: error instanceof Error ? error.name : "unknown",
      });
    }
    try {
      if (pdf.numPages > limits.pdf.maxPages) {
        return formatFailure("too-large", "the PDF has more pages than the page limit", {
          pages: pdf.numPages,
          limit: limits.pdf.maxPages,
        });
      }
      const builder = new TextBuilder();
      const withoutText: number[] = [];
      for (let page = 1; page <= pdf.numPages; page++) {
        const content = await (await pdf.getPage(page)).getTextContent();
        let text = "";
        for (const item of content.items) {
          if (!("str" in item)) continue;
          text += item.str;
          if (item.hasEOL) text += "\n";
        }
        text = text.replace(/\n+$/, "");
        if (text.trim() === "") withoutText.push(page);
        else builder.block(text, { format: "pdf", page });
      }
      const info = ((await pdf.getMetadata()).info ?? {}) as Record<string, unknown>;
      const limitations: Limitation[] =
        withoutText.length > 0 ? [{ code: "pdf.page-without-text", pages: withoutText }] : [];
      return {
        ok: true,
        value: builder.finish({ metadata: metadataFrom(info, pdf.numPages), limitations }),
      };
    } finally {
      await pdf.loadingTask.destroy();
    }
  },
};
