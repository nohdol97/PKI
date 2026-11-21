// I02A-C3 / R7: the encoding ladder, one test per step and per refusal.
import { describe, expect, it } from "vitest";
import { decodeText } from "./encoding.ts";
import { DEFAULT_LIMITS } from "./limits.ts";

const hex = (s: string) => Uint8Array.from(Buffer.from(s.replaceAll(" ", ""), "hex"));
const cat = (...parts: Uint8Array[]) => Uint8Array.from(Buffer.concat(parts));
const utf8 = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
const utf16le = (s: string) => new Uint8Array(Buffer.from(s, "utf16le"));
const utf16be = (s: string) => new Uint8Array(Buffer.from(s, "utf16le").swap16());

const decode = (bytes: Uint8Array, ratio = DEFAULT_LIMITS.encoding.fallbackMaxForeignRatio) =>
  decodeText(bytes, { fallbackMaxForeignRatio: ratio });

// EUC-KR bytes: 한글 = c7d1 b1db, 안녕 = bec8 b3e7, 가 = b0a1, 伽 = caa1, ㄱㄴㄷ = a4a1 a4a4 a4a7
const HANGUL_HANGEUL = "c7d1 b1db";

describe("step 1: byte order mark", () => {
  it("decodes a UTF-8 BOM and drops the mark", () => {
    const r = decode(cat(hex("efbbbf"), utf8("안녕 hello")));
    expect(r).toEqual({
      ok: true,
      text: "안녕 hello",
      encoding: { name: "utf-8", method: "bom" },
    });
  });

  it("decodes a UTF-16LE BOM", () => {
    const r = decode(cat(hex("fffe"), utf16le("안녕 😀")));
    expect(r).toEqual({
      ok: true,
      text: "안녕 😀",
      encoding: { name: "utf-16le", method: "bom" },
    });
  });

  it("decodes a UTF-16BE BOM", () => {
    const r = decode(cat(hex("feff"), utf16be("안녕 😀")));
    expect(r).toEqual({
      ok: true,
      text: "안녕 😀",
      encoding: { name: "utf-16be", method: "bom" },
    });
  });

  it("does not fall through to EUC-KR when a BOM-marked file is invalid", () => {
    expect(decode(cat(hex("efbbbf"), hex(HANGUL_HANGEUL))).ok).toBe(false);
    expect(decode(cat(hex("fffe"), hex("41 00 42"))).ok).toBe(false);
    expect(decode(cat(hex("feff"), hex("00 41 00"))).ok).toBe(false);
  });
});

describe("step 2: strict UTF-8", () => {
  it("decodes UTF-8 without a BOM", () => {
    expect(decode(utf8("한글 😀 abc"))).toEqual({
      ok: true,
      text: "한글 😀 abc",
      encoding: { name: "utf-8", method: "strict" },
    });
  });

  it("decodes empty input and plain ASCII as UTF-8", () => {
    expect(decode(new Uint8Array())).toMatchObject({ ok: true, text: "" });
    expect(decode(utf8("abc"))).toMatchObject({
      ok: true,
      encoding: { name: "utf-8", method: "strict" },
    });
  });

  it("is checked before EUC-KR: bytes that are valid in both read as UTF-8", () => {
    const r = decode(utf8("한글"));
    expect(r).toMatchObject({ ok: true, text: "한글", encoding: { name: "utf-8" } });
  });
});

describe("step 3: EUC-KR (CP949) fallback", () => {
  it("decodes EUC-KR Hangul and reports a fallback", () => {
    expect(decode(hex(`${HANGUL_HANGEUL} 20 62 61 73 65`))).toEqual({
      ok: true,
      text: "한글 base",
      encoding: { name: "euc-kr", method: "fallback" },
    });
  });

  it('decodes a CP949 extension syllable ("똠") that KS X 1001 does not have', () => {
    expect(decode(hex("8c63 b0a1"))).toMatchObject({
      ok: true,
      text: "똠가",
      encoding: { name: "euc-kr", method: "fallback" },
    });
  });

  it("accepts a foreign-character ratio equal to the limit and rejects one above it", () => {
    const nine = "b0a1".repeat(9);
    expect(decode(hex(`${nine} caa1`))).toMatchObject({ ok: true }); // 1 of 10 = 0.1
    expect(decode(hex(`${"b0a1".repeat(8)} caa1 caa1`)).ok).toBe(false); // 2 of 10 = 0.2
    expect(decode(hex(`${"b0a1".repeat(8)} caa1 caa1`), 0.2)).toMatchObject({ ok: true });
  });

  it("counts ASCII, CJK punctuation and fullwidth forms as native, not foreign", () => {
    // 가 + ideographic full stop (a1a3) + fullwidth "A" (a3c1) + ASCII: 0 foreign.
    expect(decode(hex("b0a1 a1a3 a3c1 41 20"), 0.001)).toMatchObject({ ok: true });
  });

  it("rejects bytes with a stray invalid byte even when the ratio would pass", () => {
    const longHangul = "b0a1".repeat(40);
    const withBad = decode(hex(`${longHangul} ff`)); // 1 replacement char in 41 = 0.024
    expect(withBad.ok).toBe(false);
  });

  it("rejects EUC-KR that decodes cleanly but has no Hangul syllable", () => {
    const jamoOnly = hex("a4a1 a4a4 a4a7"); // ㄱㄴㄷ, no syllable
    const hanjaOnly = hex("f9a1 f9a2 f9a3"); // three hanja, not valid UTF-8
    expect(decode(jamoOnly, 1)).toEqual({ ok: false });
    expect(decode(hanjaOnly, 1)).toEqual({ ok: false });
  });
});

describe("step 4: undecidable", () => {
  it("refuses Latin-1 text", () => {
    const latin1 = new Uint8Array(Buffer.from("Café crème brûlée naïve", "latin1"));
    expect(decode(latin1)).toEqual({ ok: false });
  });

  it("refuses bytes that are neither UTF-8 nor EUC-KR", () => {
    expect(decode(hex("80 81 82"))).toEqual({ ok: false });
    expect(decode(hex("ff ff ff"))).toEqual({ ok: false });
  });

  it("never returns text with a replacement character", () => {
    for (const bytes of [hex("80 81 82"), hex(`${"b0a1".repeat(40)} ff`), hex("41 ff 42")]) {
      const r = decode(bytes);
      expect(r.ok).toBe(false);
      expect("text" in r).toBe(false);
    }
  });
});
