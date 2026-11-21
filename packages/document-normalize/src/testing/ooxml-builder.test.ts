import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { buildDocx, buildXlsx, buildZip, columnLetters, heading } from "./ooxml-builder.ts";

describe("ooxml-builder", () => {
  it("builds the same bytes every time", () => {
    const docx = () =>
      buildDocx({ body: [heading(1, "제목"), { table: [["a"]] }], core: { title: "t" } });
    const xlsx = () => buildXlsx({ sheets: [{ name: "s", rows: [["a", 1, new Date(0)]] }] });
    expect(Buffer.from(docx()).equals(Buffer.from(docx()))).toBe(true);
    expect(Buffer.from(xlsx()).equals(Buffer.from(xlsx()))).toBe(true);
  });

  it("writes fixed zip timestamps (2020-01-01 00:00)", () => {
    const bytes = buildZip([{ name: "a.txt", data: "x" }]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint16(10, true)).toBe(0); // local header: time
    expect(view.getUint16(12, true)).toBe(((2020 - 1980) << 9) | (1 << 5) | 1);
  });

  it("produces archives a standard reader opens, with the expected parts", () => {
    expect(Object.keys(unzipSync(buildDocx({ body: [{ text: "x" }] }))).sort()).toEqual(
      [
        "[Content_Types].xml",
        "_rels/.rels",
        "docProps/core.xml",
        "word/_rels/document.xml.rels",
        "word/document.xml",
        "word/styles.xml",
      ].sort(),
    );
    expect(unzipSync(buildZip([{ name: "a", data: "내용", method: "store" }])).a).toEqual(
      new TextEncoder().encode("내용"),
    );
  });

  it("can lie in the headers", () => {
    const bytes = buildZip([{ name: "a", data: "12345", declaredSize: 2 }]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(22, true)).toBe(2); // local header: declared uncompressed size
  });

  it("names columns like a spreadsheet", () => {
    expect([1, 26, 27, 52, 53, 702, 703].map(columnLetters)).toEqual([
      "A",
      "Z",
      "AA",
      "AZ",
      "BA",
      "ZZ",
      "AAA",
    ]);
  });
});
