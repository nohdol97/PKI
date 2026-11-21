// I02A-C5/C6/C11 at the pipeline level: checks come before parsers, failures are
// results, and a throwing parser becomes `corrupt`. Format modules are replaced
// by spies so these tests keep their meaning when the real modules land.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FORMAT_MODULES, normalizeDocument } from "./normalize.ts";
import { DEFAULT_LIMITS } from "./limits.ts";
import { formatFailure, formatSuccess, verbatimLineBlocks } from "./text-builder.ts";
import { DOCUMENT_FORMATS, LIMITATION_CODES, NORMALIZE_ERROR_CODES } from "./types.ts";
import type { FormatResult, NormalizeInput } from "./types.ts";

afterEach(() => vi.restoreAllMocks());

const utf8 = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
const hex = (s: string) => Uint8Array.from(Buffer.from(s.replaceAll(" ", ""), "hex"));
const bytes = (b: Uint8Array, name?: string): NormalizeInput =>
  name === undefined ? { kind: "bytes", bytes: b } : { kind: "bytes", bytes: b, name };

const echoTxt = (): FormatResult => formatSuccess(verbatimLineBlocks("unused", "txt"));
function spyTxt(impl: (text: string) => FormatResult | Promise<FormatResult> = echoTxt) {
  return vi.spyOn(FORMAT_MODULES.txt, "parse").mockImplementation((text) => impl(text));
}
const echo = (text: string): FormatResult => formatSuccess(verbatimLineBlocks(text, "txt"));

describe("registry", () => {
  it("has one module per format, each declaring its own format and input kind", () => {
    expect(Object.keys(FORMAT_MODULES).sort()).toEqual([...DOCUMENT_FORMATS].sort());
    for (const format of DOCUMENT_FORMATS) {
      expect(FORMAT_MODULES[format].format).toBe(format);
      expect(FORMAT_MODULES[format].input).toBe(
        ["pdf", "docx", "xlsx"].includes(format) ? "bytes" : "text",
      );
    }
  });
});

describe("success path", () => {
  it("decodes, normalizes line breaks and the BOM, and hands the text to the module with the limits", async () => {
    const parse = spyTxt(echo);
    const r = await normalizeDocument(
      bytes(Uint8Array.from(Buffer.concat([hex("efbbbf"), utf8("a\r\nb\rc\n")])), "n.txt"),
    );
    expect(parse).toHaveBeenCalledTimes(1);
    expect(parse.mock.calls[0]?.[0]).toBe("a\nb\nc\n");
    expect(parse.mock.calls[0]?.[1]).toEqual(DEFAULT_LIMITS);
    expect(r).toMatchObject({
      ok: true,
      document: {
        format: "txt",
        text: "a\nb\nc\n",
        encoding: { name: "utf-8", method: "bom" },
        limitations: [],
      },
    });
    expect(r.ok && r.document.blocks).toHaveLength(3);
  });

  it("does not apply Unicode normalization", async () => {
    spyTxt(echo);
    const nfd = "한"; // 한 as conjoining jamo
    const r = await normalizeDocument(bytes(utf8(nfd), "a.txt"));
    expect(r.ok && r.document.text).toBe(nfd);
  });

  it("adds text.encoding-fallback for EUC-KR and keeps module limitations in table order", async () => {
    spyTxt((text) => {
      const ok = echo(text);
      if (ok.ok) ok.value.limitations = [{ code: "csv.ragged-rows" }];
      return ok;
    });
    const r = await normalizeDocument(bytes(hex("c7d1 b1db 20 68 69"), "a.txt"));
    expect(r).toMatchObject({
      ok: true,
      document: { text: "한글 hi", encoding: { name: "euc-kr", method: "fallback" } },
    });
    expect(r.ok && r.document.limitations).toEqual([
      { code: "text.encoding-fallback" },
      { code: "csv.ragged-rows" },
    ]);
  });

  it("passes bytes, not text, to a binary module", async () => {
    const spy = vi
      .spyOn(FORMAT_MODULES.pdf, "parse")
      .mockImplementation((b) =>
        formatSuccess({ text: String(b.byteLength), blocks: [], metadata: {}, limitations: [] }),
      );
    const input = Uint8Array.from(Buffer.from("%PDF-1.7 body", "latin1"));
    const r = await normalizeDocument(bytes(input, "a.pdf"));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBeInstanceOf(Uint8Array);
    expect(r).toMatchObject({ ok: true, document: { format: "pdf" } });
    expect(r.ok && "encoding" in r.document).toBe(false);
  });

  it("reads a path input and returns the same result as the equivalent bytes", async () => {
    spyTxt(echo);
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "pki-norm-")));
    try {
      const path = join(dir, "a.txt");
      writeFileSync(path, "한글 😀");
      const fromPath = await normalizeDocument({ kind: "path", path, allowedRoot: dir });
      const fromBytes = await normalizeDocument(bytes(utf8("한글 😀"), "a.txt"));
      expect(fromPath).toEqual(fromBytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is deterministic: the same input twice gives deeply equal results", async () => {
    spyTxt(echo);
    const input = bytes(utf8("a\r\n한글 😀\n"), "a.txt");
    expect(await normalizeDocument(input)).toEqual(await normalizeDocument(input));
  });
});

describe("checks run before parsers", () => {
  it("too-large: the parser is not called", async () => {
    const parse = spyTxt();
    const r = await normalizeDocument(bytes(utf8("0123456789"), "a.txt"), {
      limits: { maxFileBytes: 9 },
    });
    expect(r).toMatchObject({ ok: false, error: { code: "too-large" } });
    expect(parse).not.toHaveBeenCalled();
  });

  it("a file of exactly maxFileBytes reaches the parser", async () => {
    const parse = spyTxt(echo);
    const r = await normalizeDocument(bytes(utf8("012345678"), "a.txt"), {
      limits: { maxFileBytes: 9 },
    });
    expect(r.ok).toBe(true);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("overriding maxFileBytes below a passing fixture's size turns it into too-large (C11)", async () => {
    spyTxt(echo);
    const input = bytes(utf8("some small document"), "a.txt");
    expect((await normalizeDocument(input)).ok).toBe(true);
    expect(await normalizeDocument(input, { limits: { maxFileBytes: 5 } })).toMatchObject({
      ok: false,
      error: { code: "too-large" },
    });
  });

  it("format-mismatch and unsupported-format: no parser is called", async () => {
    const pdf = vi.spyOn(FORMAT_MODULES.pdf, "parse");
    const docx = vi.spyOn(FORMAT_MODULES.docx, "parse");
    expect(await normalizeDocument(bytes(utf8("not a pdf"), "a.pdf"))).toMatchObject({
      ok: false,
      error: { code: "format-mismatch" },
    });
    expect(await normalizeDocument(bytes(utf8("not a zip"), "a.docx"))).toMatchObject({
      ok: false,
      error: { code: "format-mismatch" },
    });
    expect(await normalizeDocument(bytes(utf8("x"), "a.doc"))).toMatchObject({
      ok: false,
      error: { code: "unsupported-format" },
    });
    expect(pdf).not.toHaveBeenCalled();
    expect(docx).not.toHaveBeenCalled();
  });

  it("encoding-undecidable carries no text and the parser is not called", async () => {
    const parse = spyTxt();
    const r = await normalizeDocument(bytes(hex("80 81 82"), "a.txt"));
    expect(r).toMatchObject({ ok: false, error: { code: "encoding-undecidable" } });
    expect(r.ok).toBe(false);
    expect(parse).not.toHaveBeenCalled();
  });

  it("outside-root and not-a-file come back as results", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "pki-norm-")));
    try {
      const r1 = await normalizeDocument({ kind: "path", path: dir });
      expect(r1).toMatchObject({ ok: false, error: { code: "not-a-file" } });
      const r2 = await normalizeDocument({
        kind: "path",
        path: join(dir, "x.txt"),
        allowedRoot: tmpdir() + "/nonexistent-root",
      });
      expect(r2).toMatchObject({ ok: false, error: { code: "read-failed" } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("failures are results", () => {
  it("turns a throwing module into corrupt with the message in detail", async () => {
    spyTxt(() => {
      throw new Error("boom at offset 12");
    });
    const r = await normalizeDocument(bytes(utf8("x"), "a.txt"));
    expect(r).toMatchObject({
      ok: false,
      error: { code: "corrupt", detail: { cause: "boom at offset 12" } },
    });
  });

  it("turns a rejecting module and a non-Error throw into corrupt", async () => {
    spyTxt(() => Promise.reject(new Error("async boom")));
    expect(await normalizeDocument(bytes(utf8("x"), "a.txt"))).toMatchObject({
      ok: false,
      error: { code: "corrupt" },
    });
    spyTxt(() => {
      throw "a string";
    });
    expect(await normalizeDocument(bytes(utf8("x"), "a.txt"))).toMatchObject({
      ok: false,
      error: { code: "corrupt" },
    });
  });

  it("bounds the length of the detail message", async () => {
    spyTxt(() => {
      throw new Error("x".repeat(5000));
    });
    const r = await normalizeDocument(bytes(utf8("x"), "a.txt"));
    expect(!r.ok && String(r.error.detail?.["cause"]).length).toBeLessThanOrEqual(300);
  });

  it("passes a module's own failure through", async () => {
    spyTxt(() => formatFailure("encrypted", "locked", { page: 1 }));
    expect(await normalizeDocument(bytes(utf8("x"), "a.txt"))).toEqual({
      ok: false,
      error: { code: "encrypted", message: "locked", detail: { page: 1 } },
    });
  });

  it("never rejects across every input failure and every error code stays in the closed set", async () => {
    spyTxt(() => {
      throw new Error("x");
    });
    const inputs: NormalizeInput[] = [
      bytes(utf8("x"), "a.doc"),
      bytes(utf8("x"), "a.pdf"),
      bytes(utf8("x"), "a.xlsx"),
      bytes(hex("80 81 82"), "a.txt"),
      bytes(utf8("x"), "a.txt"),
      bytes(new Uint8Array(100), "a.csv"),
      { kind: "path", path: "/definitely/not/here.txt" },
      { kind: "path", path: tmpdir() },
    ];
    const settled = await Promise.allSettled(
      inputs.map((i) => normalizeDocument(i, { limits: { maxFileBytes: 50 } })),
    );
    for (const s of settled) {
      expect(s.status).toBe("fulfilled");
      if (s.status === "fulfilled" && !s.value.ok) {
        expect(NORMALIZE_ERROR_CODES).toContain(s.value.error.code);
      }
    }
  });

  it("rejects with TypeError for a bad limits object, before looking at the input", async () => {
    await expect(
      normalizeDocument(bytes(utf8("x"), "a.txt"), { limits: { maxFileBytes: 0 } }),
    ).rejects.toThrow(TypeError);
    await expect(
      normalizeDocument(bytes(utf8("x"), "a.txt"), { limits: { zip: { maxRatio: Number.NaN } } }),
    ).rejects.toThrow(TypeError);
  });
});

describe("constants", () => {
  it("lists 14 limitation codes without duplicates", () => {
    expect(LIMITATION_CODES).toHaveLength(14);
    expect(new Set(LIMITATION_CODES).size).toBe(14);
  });
});
