// Public output types of the document normalizer (I02A, spec "공개 함수와 타입").
// Positions are Unicode code points, never UTF-16 units (I02A-R9, V02-R3).
import type { Limits, PartialLimits } from "./limits.ts";

export const DOCUMENT_FORMATS = [
  "pdf",
  "markdown",
  "txt",
  "html",
  "docx",
  "xlsx",
  "csv",
  "json",
] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

export const NORMALIZE_ERROR_CODES = [
  "unsupported-format",
  "format-mismatch",
  "outside-root",
  "not-a-file",
  "read-failed",
  "too-large",
  "zip-limit",
  "zip-path",
  "encoding-undecidable",
  "encrypted",
  "corrupt",
] as const;
export type NormalizeErrorCode = (typeof NORMALIZE_ERROR_CODES)[number];

/** The complete limitation-code table of the spec; a coverage test compares both. */
export const LIMITATION_CODES = [
  "text.encoding-fallback",
  "pdf.page-without-text",
  "docx.images-omitted",
  "docx.headers-footers-omitted",
  "docx.notes-omitted",
  "xlsx.formula-cached-value",
  "xlsx.merged-cells",
  "xlsx.hidden-sheet",
  "xlsx.comments-omitted",
  "csv.ragged-rows",
  "html.elements-removed",
  "html.external-references-ignored",
  "markdown.raw-html-as-text",
  "markdown.external-references-ignored",
] as const;
export type LimitationCode = (typeof LIMITATION_CODES)[number];

export type Locator =
  | { format: "pdf"; page: number }
  | {
      format: "docx";
      paragraph: number;
      style?: string;
      headingLevel?: number;
      table?: { index: number; row: number; cell: number };
      /** A comment block: its thread, its place in the thread (both from 0) and which part it is (I02B-R30). */
      comment?: { thread: number; index: number; part: "head" | "text" };
    }
  | { format: "xlsx"; sheet: string; cell?: string; row?: number; column?: number }
  | { format: "csv"; record: number; line: number; field: number }
  | { format: "html"; path: string; line: number }
  | { format: "markdown"; line: number; node: string; depth?: number }
  | { format: "txt" | "json"; line: number };

/** `[start, end)` in code points of the document `text`. */
export interface Block {
  start: number;
  end: number;
  locator: Locator;
}

export interface DocumentMetadata {
  title?: string;
  author?: string;
  created?: string;
  modified?: string;
  pageCount?: number;
  sheetNames?: string[];
  /** The authors of a DOCX's comments in the order they are written out (I02B-R30). */
  participants?: string[];
}

export interface EncodingInfo {
  name: "utf-8" | "utf-16le" | "utf-16be" | "euc-kr";
  method: "bom" | "strict" | "fallback";
}

export interface Limitation {
  code: LimitationCode;
  count?: number;
  pages?: number[];
}

export interface NormalizedDocument {
  format: DocumentFormat;
  text: string;
  blocks: Block[];
  metadata: DocumentMetadata;
  encoding?: EncodingInfo;
  limitations: Limitation[];
}

export interface NormalizeError {
  code: NormalizeErrorCode;
  message: string;
  detail?: Record<string, string | number>;
}

export type NormalizeInput =
  | { kind: "path"; path: string; allowedRoot?: string; format?: DocumentFormat }
  | { kind: "bytes"; bytes: Uint8Array; name?: string; format?: DocumentFormat };

export interface NormalizeOptions {
  limits?: PartialLimits;
}

export type NormalizeResult =
  { ok: true; document: NormalizedDocument } | { ok: false; error: NormalizeError };

// --- The contract every format module implements (T02-T05 fill these in) ---

/** What a format module returns: the text-builder output plus metadata and limitations. */
export interface ParsedDocument {
  text: string;
  blocks: Block[];
  metadata: DocumentMetadata;
  limitations: Limitation[];
}

export type FormatResult =
  { ok: true; value: ParsedDocument } | { ok: false; error: NormalizeError };

/**
 * A format module is self-contained: it sees only its own input (already decoded
 * text, or bytes that passed the size and signature checks) and the resolved
 * limits. It never reads files, decodes text, or adds the encoding limitation;
 * `normalizeDocument` does that. It returns a failure for conditions it can name
 * (`encrypted`, `too-large`, `zip-limit`, `zip-path`, `format-mismatch`,
 * `corrupt`) and may simply throw for anything else: the boundary in
 * `normalizeDocument` turns a throw or rejection into `corrupt`.
 */
export interface TextFormatModule {
  readonly format: "markdown" | "txt" | "html" | "csv" | "json";
  readonly input: "text";
  /** `text` has no BOM and only `\n` line breaks (I02A-R8). */
  parse(text: string, limits: Limits): FormatResult | Promise<FormatResult>;
}

export interface BinaryFormatModule {
  readonly format: "pdf" | "docx" | "xlsx";
  readonly input: "bytes";
  /** `bytes` is within `maxFileBytes` and starts with the format's signature. */
  parse(bytes: Uint8Array, limits: Limits): FormatResult | Promise<FormatResult>;
}

export type FormatModule = TextFormatModule | BinaryFormatModule;
