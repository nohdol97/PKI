import { describe, expect, it } from "vitest";
import { buildPdf, truncatePdf } from "./pdf-builder.ts";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("buildPdf", () => {
  const options = {
    pages: ["안녕 😀", "", "é"],
    info: { title: "제목", creationDate: "D:20240102030405Z" },
    linkUri: "https://example.test/a(b)",
  };

  it("is deterministic and starts with the PDF signature", () => {
    const a = buildPdf(options);
    expect(text(a.slice(0, 5))).toBe("%PDF-");
    expect(buildPdf(options)).toEqual(a);
  });

  it("writes xref offsets that point at the objects", () => {
    const source = text(buildPdf(options));
    const start = Number(/startxref\n(\d+)\n/.exec(source)?.[1]);
    expect(source.slice(start, start + 4)).toBe("xref");
    const entries = [...source.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)];
    expect(entries.length).toBeGreaterThan(8);
    entries.forEach((entry, i) => {
      expect(source.slice(Number(entry[1])).startsWith(`${i + 1} 0 obj`)).toBe(true);
    });
  });

  it("adds the optional parts only when asked", () => {
    const plain = text(buildPdf({ pages: ["a"] }));
    expect(plain).not.toMatch(/\/Encrypt|\/URI|\/Info/);
    const full = text(buildPdf({ ...options, encrypt: true }));
    expect(full).toMatch(/\/Encrypt \d+ 0 R/);
    expect(full).toContain("/URI (https://example.test/a\\(b\\))");
    expect(full).toMatch(/\/Info \d+ 0 R/);
  });

  it("truncates by bytes or by fraction", () => {
    const bytes = buildPdf({ pages: ["a"] });
    expect(truncatePdf(bytes, 10)).toHaveLength(10);
    expect(truncatePdf(bytes, 0.5)).toHaveLength(Math.floor(bytes.length / 2));
  });
});
