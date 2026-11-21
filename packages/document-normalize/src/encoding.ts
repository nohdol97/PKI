// The text decoding ladder (I02A-R7): BOM, then strict UTF-8, then EUC-KR (CP949),
// else undecidable. Garbled text is never returned.
import iconv from "iconv-lite";
import type { EncodingInfo } from "./types.ts";

export type DecodeResult = { ok: true; text: string; encoding: EncodingInfo } | { ok: false };

const REPLACEMENT = "�";

function strict(label: "utf-8" | "utf-16le", bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function swapped(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out[i] = bytes[i + 1] as number;
    out[i + 1] = bytes[i] as number;
  }
  if (bytes.length % 2 === 1) out[bytes.length - 1] = bytes[bytes.length - 1] as number;
  return out;
}

const isHangulSyllable = (cp: number) => cp >= 0xac00 && cp <= 0xd7a3;

/** ASCII, Hangul (syllables, Jamo, compatibility Jamo), CJK punctuation, fullwidth forms. */
function isNative(cp: number): boolean {
  return (
    cp <= 0x7f ||
    isHangulSyllable(cp) ||
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x3130 && cp <= 0x318f) ||
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0xff00 && cp <= 0xffef)
  );
}

/** CP949 is a superset of EUC-KR; the built-in TextDecoder lacks its extension syllables. */
function eucKr(bytes: Uint8Array, maxForeignRatio: number): string | undefined {
  const text = iconv.decode(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), "cp949");
  if (text.includes(REPLACEMENT)) return undefined;
  let total = 0;
  let foreign = 0;
  let hangul = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    total++;
    if (isHangulSyllable(cp)) hangul = true;
    if (!isNative(cp)) foreign++;
  }
  if (!hangul) return undefined;
  if (foreign / total > maxForeignRatio) return undefined;
  return text;
}

export function decodeText(
  bytes: Uint8Array,
  options: { fallbackMaxForeignRatio: number },
): DecodeResult {
  const fail: DecodeResult = { ok: false };
  const b0 = bytes[0];
  const b1 = bytes[1];

  if (b0 === 0xef && b1 === 0xbb && bytes[2] === 0xbf) {
    const text = strict("utf-8", bytes.subarray(3));
    return text === undefined
      ? fail
      : { ok: true, text, encoding: { name: "utf-8", method: "bom" } };
  }
  if (b0 === 0xff && b1 === 0xfe) {
    const text = strict("utf-16le", bytes.subarray(2));
    return text === undefined
      ? fail
      : { ok: true, text, encoding: { name: "utf-16le", method: "bom" } };
  }
  if (b0 === 0xfe && b1 === 0xff) {
    const text = strict("utf-16le", swapped(bytes.subarray(2)));
    return text === undefined
      ? fail
      : { ok: true, text, encoding: { name: "utf-16be", method: "bom" } };
  }

  const utf8 = strict("utf-8", bytes);
  if (utf8 !== undefined) {
    return { ok: true, text: utf8, encoding: { name: "utf-8", method: "strict" } };
  }

  const korean = eucKr(bytes, options.fallbackMaxForeignRatio);
  if (korean !== undefined) {
    return { ok: true, text: korean, encoding: { name: "euc-kr", method: "fallback" } };
  }
  return fail;
}
