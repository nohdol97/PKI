// I02A-C6 (R1): format by declaration or extension, binary formats by first bytes.
import { describe, expect, it } from "vitest";
import { detectFormat } from "./detect.ts";

const bytes = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));
const PDF = bytes("%PDF-1.7\n");
const ZIP = bytes("PK\x03\x04rest");

describe("detectFormat by extension", () => {
  it.each([
    ["a.pdf", "pdf"],
    ["a.md", "markdown"],
    ["a.markdown", "markdown"],
    ["a.txt", "txt"],
    ["a.html", "html"],
    ["a.htm", "html"],
    ["a.docx", "docx"],
    ["a.xlsx", "xlsx"],
    ["a.csv", "csv"],
    ["a.json", "json"],
    ["DIR.v2/REPORT.PDF", "pdf"],
    ["Notes.MD", "markdown"],
  ])("%s is %s", (name, format) => {
    const content =
      format === "pdf" ? PDF : format === "docx" || format === "xlsx" ? ZIP : bytes("x");
    expect(detectFormat(name, undefined, content)).toEqual({ ok: true, format });
  });

  it("lets a declared format win over the extension", () => {
    expect(detectFormat("a.txt", "markdown", bytes("x"))).toEqual({ ok: true, format: "markdown" });
    expect(detectFormat(undefined, "json", bytes("{}"))).toEqual({ ok: true, format: "json" });
    expect(detectFormat("a.doc", "txt", bytes("x"))).toEqual({ ok: true, format: "txt" });
  });
});

describe("unsupported formats", () => {
  it.each([".doc", ".xls", ".ppt", ".hwp", ".hwpx", ".rtf"])("rejects legacy %s", (ext) => {
    const r = detectFormat(`file${ext}`, undefined, bytes("x"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("unsupported-format");
    expect(r.error.message).toContain(ext);
    expect(r.error.message).toContain("지원하지 않는 형식");
  });

  it("rejects an unknown extension, no extension and no name", () => {
    for (const name of ["a.pptx", "a.bin", "README", ".hidden", undefined]) {
      const r = detectFormat(name, undefined, bytes("x"));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("unsupported-format");
    }
  });
});

describe("first-byte check", () => {
  it("rejects a .pdf that does not start with %PDF-", () => {
    for (const content of [bytes("hello"), bytes(" %PDF-1.7"), new Uint8Array(), ZIP]) {
      const r = detectFormat("a.pdf", undefined, content);
      expect(r).toMatchObject({ ok: false, error: { code: "format-mismatch" } });
    }
  });

  it("rejects a .docx or .xlsx that does not start with the ZIP signature", () => {
    for (const name of ["a.docx", "a.xlsx"]) {
      for (const content of [
        PDF,
        bytes("hello"),
        new Uint8Array(),
        bytes("PK\x05\x06"),
        bytes("PK\x03"),
      ]) {
        const r = detectFormat(name, undefined, content);
        expect(r).toMatchObject({ ok: false, error: { code: "format-mismatch" } });
      }
    }
  });

  it("applies to a declared binary format too", () => {
    expect(detectFormat(undefined, "pdf", bytes("nope"))).toMatchObject({
      ok: false,
      error: { code: "format-mismatch" },
    });
  });

  it("does not look at the first bytes of text formats", () => {
    for (const name of ["a.txt", "a.md", "a.html", "a.csv", "a.json"]) {
      expect(detectFormat(name, undefined, PDF).ok).toBe(true);
    }
  });
});
