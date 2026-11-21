// Format decision (I02A-R1): a declared format, else the extension; binary
// formats are confirmed by their first bytes. Body-entry checks for DOCX/XLSX
// (`word/document.xml`, `xl/workbook.xml`) belong to the ZIP guard, which opens the archive.
import { extname } from "node:path";
import { formatFailure } from "./text-builder.ts";
import type { DocumentFormat, NormalizeError } from "./types.ts";

export type DetectResult =
  { ok: true; format: DocumentFormat } | { ok: false; error: NormalizeError };

const BY_EXTENSION: Readonly<Record<string, DocumentFormat>> = {
  ".pdf": "pdf",
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "txt",
  ".html": "html",
  ".htm": "html",
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".csv": "csv",
  ".json": "json",
};

const startsWith = (bytes: Uint8Array, signature: readonly number[]) =>
  signature.every((byte, i) => bytes[i] === byte);

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04

export function detectFormat(
  name: string | undefined,
  declared: DocumentFormat | undefined,
  bytes: Uint8Array,
): DetectResult {
  let format = declared;
  if (format === undefined) {
    const extension = name === undefined ? "" : extname(name).toLowerCase();
    format = BY_EXTENSION[extension]; // every key starts with ".", so no prototype name can match
    if (format === undefined) {
      const shown = extension === "" ? "(확장자 없음)" : extension;
      return formatFailure("unsupported-format", `지원하지 않는 형식: ${shown}`, {
        extension,
      });
    }
  }

  if (format === "pdf" && !startsWith(bytes, PDF_SIGNATURE)) {
    return formatFailure("format-mismatch", "내용이 PDF가 아니다(%PDF- 로 시작하지 않음)");
  }
  if ((format === "docx" || format === "xlsx") && !startsWith(bytes, ZIP_SIGNATURE)) {
    return formatFailure("format-mismatch", `내용이 ${format.toUpperCase()}(ZIP)이 아니다`);
  }
  return { ok: true, format };
}
