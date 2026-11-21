// Builds the canonical text and its blocks together, so every block range is
// counted in code points by one piece of code (I02A-R8, R9). Format modules use
// this instead of computing offsets themselves.
import type {
  Block,
  DocumentMetadata,
  FormatResult,
  Limitation,
  Locator,
  NormalizeError,
  NormalizeErrorCode,
  ParsedDocument,
} from "./types.ts";

export function codePointLength(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++, n++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
  }
  return n;
}

/** The UTF-16 index of the `n`-th code point (or `text.length` when `n` is the count). */
function unitIndex(text: string, n: number): number {
  let i = 0;
  for (let seen = 0; seen < n; seen++) {
    if (i >= text.length) throw new RangeError("code point position is past the end of the text");
    const unit = text.charCodeAt(i);
    const isPair =
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      i + 1 < text.length &&
      text.charCodeAt(i + 1) >= 0xdc00 &&
      text.charCodeAt(i + 1) <= 0xdfff;
    i += isPair ? 2 : 1;
  }
  return i;
}

/** The text of the code point range `[start, end)`, the way a block range is read back. */
export function codePointSlice(text: string, start: number, end: number): string {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    throw new RangeError(`invalid code point range [${start}, ${end})`);
  }
  const from = unitIndex(text, start);
  return text.slice(from, from + unitIndex(text.slice(from), end - start));
}

export class TextBuilder {
  #text = "";
  #length = 0;
  #blocks: Block[] = [];

  /**
   * Append one element's text as a block. Empty text makes neither a block nor a
   * separator. `separator` goes before the block unless it is the first one.
   */
  block(text: string, locator: Locator, separator = "\n"): void {
    if (text === "") return;
    if (this.#blocks.length > 0) {
      this.#text += separator;
      this.#length += codePointLength(separator);
    }
    const start = this.#length;
    this.#text += text;
    this.#length += codePointLength(text);
    this.#blocks.push({ start, end: this.#length, locator });
  }

  finish(extra: { metadata?: DocumentMetadata; limitations?: Limitation[] } = {}): ParsedDocument {
    return {
      text: this.#text,
      blocks: this.#blocks,
      metadata: extra.metadata ?? {},
      limitations: extra.limitations ?? [],
    };
  }
}

/**
 * TXT and JSON keep the decoded text as is; each non-blank line becomes a block
 * whose locator is its 1-based line number (I02A-R16). `text` has `\n` breaks.
 */
export function verbatimLineBlocks(text: string, format: "txt" | "json"): ParsedDocument {
  const blocks: Block[] = [];
  let position = 0;
  let line = 1;
  for (const content of text.split("\n")) {
    const length = codePointLength(content);
    if (content.trim() !== "") {
      blocks.push({ start: position, end: position + length, locator: { format, line } });
    }
    position += length + 1;
    line++;
  }
  return { text, blocks, metadata: {}, limitations: [] };
}

export function formatFailure(
  code: NormalizeErrorCode,
  message: string,
  detail?: Record<string, string | number>,
): { ok: false; error: NormalizeError } {
  return { ok: false, error: detail ? { code, message, detail } : { code, message } };
}

export function formatSuccess(value: ParsedDocument): FormatResult {
  return { ok: true, value };
}
