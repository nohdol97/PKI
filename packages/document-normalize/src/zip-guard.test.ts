// I02A-C4: the zip guard. Every rejection case also asserts that neither OOXML
// parser (mammoth, read-excel-file) was called, going through the real DOCX and
// XLSX modules. Each check line has a case that goes red when only that line is removed.
import { unzipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { docxModule } from "./formats/docx.ts";
import { xlsxModule } from "./formats/xlsx.ts";
import { resolveLimits } from "./limits.ts";
import type { PartialLimits } from "./limits.ts";
import { buildDocx, buildZip } from "./testing/ooxml-builder.ts";
import type { ZipEntrySpec } from "./testing/ooxml-builder.ts";
import type { BinaryFormatModule, FormatResult } from "./types.ts";
import { guardZip } from "./zip-guard.ts";

const parsers = vi.hoisted(() => ({ mammoth: vi.fn(), excel: vi.fn() }));
/** Bytes that the inflate streams really emitted, counted outside the guard's own bookkeeping. */
const probe = vi.hoisted(() => ({ emitted: 0 }));

type Stream = { on(event: "data", listener: (chunk: Buffer) => void): unknown };
type Zip = {
  openReadStream(entry: unknown, callback: (e: Error | null, s?: Stream) => void): void;
};
vi.mock("yauzl", async (importOriginal) => {
  const actual = await importOriginal<{
    default: { fromBuffer(...args: unknown[]): void } & Record<string, unknown>;
  }>();
  const fromBuffer = (
    buffer: unknown,
    options: unknown,
    callback: (e: Error | null, zip?: Zip) => void,
  ) =>
    actual.default.fromBuffer(buffer, options, (error: Error | null, zip?: Zip) => {
      if (zip) {
        const original = zip.openReadStream.bind(zip);
        zip.openReadStream = (entry, done) =>
          original(entry, (e, stream) => {
            stream?.on("data", (chunk) => {
              probe.emitted += chunk.length;
            });
            done(e, stream);
          });
      }
      callback(error, zip);
    });
  return { default: { ...actual.default, fromBuffer } };
});

vi.mock("mammoth", async (importOriginal) => {
  const actual = await importOriginal<{ default: Record<string, unknown> }>();
  parsers.mammoth.mockImplementation(actual.default.convertToHtml as never);
  return { default: { ...actual.default, convertToHtml: parsers.mammoth } };
});
vi.mock("read-excel-file/universal", async (importOriginal) => {
  const actual = await importOriginal<{ default: unknown }>();
  parsers.excel.mockImplementation(actual.default as never);
  return { ...actual, default: parsers.excel };
});

beforeEach(() => {
  parsers.mammoth.mockClear();
  parsers.excel.mockClear();
});

const CHUNK = 64 * 1024;
const zeros = (n: number) => new Uint8Array(n);
const MODULES: [string, BinaryFormatModule, string][] = [
  ["docx", docxModule, "word/document.xml"],
  ["xlsx", xlsxModule, "xl/workbook.xml"],
];

const limitsOf = (zip: NonNullable<PartialLimits["zip"]>) => resolveLimits({ zip });
const zipLimits = (zip: NonNullable<PartialLimits["zip"]>) => limitsOf(zip).zip;

function failure(result: FormatResult) {
  if (result.ok) throw new Error("expected a failure");
  return result.error;
}

describe("C4 central-directory prefilter (declared values)", () => {
  it("1: an entry whose size exceeds maxEntryBytes -> zip-limit maxEntryBytes", async () => {
    for (const [, module, bodyName] of MODULES) {
      const bytes = buildZip([
        { name: bodyName, data: "<x/>" },
        { name: "big.bin", data: zeros(2048) },
      ]);
      const error = failure(await module.parse(bytes, limitsOf({ maxEntryBytes: 1024 })));
      expect(error.code).toBe("zip-limit");
      expect(error.detail?.limit).toBe("maxEntryBytes");
      expect(parsers.mammoth).toHaveBeenCalledTimes(0);
      expect(parsers.excel).toHaveBeenCalledTimes(0);
    }
  });

  it("2: declared sizes summing over maxTotalBytes -> zip-limit maxTotalBytes", async () => {
    for (const [, module, bodyName] of MODULES) {
      const bytes = buildZip([
        { name: bodyName, data: "<x/>" },
        { name: "a.bin", data: zeros(1000) },
        { name: "b.bin", data: zeros(1000) },
      ]);
      const error = failure(await module.parse(bytes, limitsOf({ maxTotalBytes: 1500 })));
      expect(error.code).toBe("zip-limit");
      expect(error.detail?.limit).toBe("maxTotalBytes");
      expect(parsers.mammoth).toHaveBeenCalledTimes(0);
      expect(parsers.excel).toHaveBeenCalledTimes(0);
    }
  });

  it("3: more entries than maxEntries -> zip-limit maxEntries", async () => {
    for (const [, module, bodyName] of MODULES) {
      const bytes = buildZip([
        { name: bodyName, data: "<x/>" },
        { name: "a", data: "1" },
        { name: "b", data: "2" },
        { name: "c", data: "3" },
      ]);
      const error = failure(await module.parse(bytes, limitsOf({ maxEntries: 3 })));
      expect(error.code).toBe("zip-limit");
      expect(error.detail?.limit).toBe("maxEntries");
      expect(parsers.mammoth).toHaveBeenCalledTimes(0);
      expect(parsers.excel).toHaveBeenCalledTimes(0);
    }
  });

  it("4: an entry of at least ratioMinBytes whose ratio exceeds maxRatio -> zip-limit maxRatio", async () => {
    for (const [, module, bodyName] of MODULES) {
      const bytes = buildZip([
        { name: bodyName, data: "<x/>" },
        { name: "squeezed.bin", data: zeros(5000) },
      ]);
      const error = failure(
        await module.parse(bytes, limitsOf({ maxRatio: 10, ratioMinBytes: 1000 })),
      );
      expect(error.code).toBe("zip-limit");
      expect(error.detail?.limit).toBe("maxRatio");
      expect(parsers.mammoth).toHaveBeenCalledTimes(0);
      expect(parsers.excel).toHaveBeenCalledTimes(0);
    }
  });

  it("4: the ratio is only looked at from ratioMinBytes upward, and 'exceeds' is strict", async () => {
    const squeezed = buildZip([{ name: "s.bin", data: zeros(1000) }]);
    const high = await guardZip(squeezed, zipLimits({ maxRatio: 10, ratioMinBytes: 1000 }));
    expect(high.ok).toBe(false); // exactly ratioMinBytes is already checked
    const below = await guardZip(squeezed, zipLimits({ maxRatio: 10, ratioMinBytes: 1001 }));
    expect(below.ok).toBe(true);
    const stored = buildZip([{ name: "s.bin", data: zeros(2000), method: "store" }]);
    expect((await guardZip(stored, zipLimits({ maxRatio: 1, ratioMinBytes: 1 }))).ok).toBe(true);
    const over = await guardZip(stored, zipLimits({ maxRatio: 0.99, ratioMinBytes: 1 }));
    expect(over.ok).toBe(false);
  });

  it("5: an encrypted entry -> zip-limit encrypted", async () => {
    for (const [, module, bodyName] of MODULES) {
      const bytes = buildZip([
        { name: bodyName, data: "<x/>" },
        { name: "secret.bin", data: "x", encrypted: true },
      ]);
      const error = failure(await module.parse(bytes, resolveLimits()));
      expect(error.code).toBe("zip-limit");
      expect(error.detail?.limit).toBe("encrypted");
      expect(parsers.mammoth).toHaveBeenCalledTimes(0);
      expect(parsers.excel).toHaveBeenCalledTimes(0);
    }
  });
});

describe("C4 streaming inflate counts the real bytes", () => {
  it("6: an entry that inflates past its declared size stops within one chunk of it", async () => {
    for (const [, module, bodyName] of MODULES) {
      const bytes = buildZip([
        { name: bodyName, data: "<x/>" },
        { name: "bomb.bin", data: zeros(8 * 1024 * 1024), declaredSize: 1000 },
      ]);
      const error = failure(await module.parse(bytes, resolveLimits()));
      expect(error.code).toBe("zip-limit");
      expect(error.detail?.limit).toBe("declaredSize");
      expect(error.detail?.declared).toBe(1000);
      expect(error.detail?.inflated as number).toBeGreaterThan(1000);
      expect(error.detail?.inflated as number).toBeLessThanOrEqual(1000 + CHUNK);
      expect(parsers.mammoth).toHaveBeenCalledTimes(0);
      expect(parsers.excel).toHaveBeenCalledTimes(0);
    }
  });

  it("6: inflating really stops: the stream emits no more than the declared size plus one chunk", async () => {
    probe.emitted = 0;
    const bytes = buildZip([
      { name: "word/document.xml", data: "<x/>" },
      { name: "bomb.bin", data: zeros(8 * 1024 * 1024), declaredSize: 1000 },
    ]);
    expect((await guardZip(bytes, resolveLimits().zip)).ok).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 100)); // let a stream that was not destroyed run on
    expect(probe.emitted).toBeGreaterThan(1000);
    expect(probe.emitted).toBeLessThanOrEqual(4 + 1000 + CHUNK);
  });

  it("6: an entry that inflates to fewer bytes than declared is rejected too", async () => {
    for (const [, module, bodyName] of MODULES) {
      const bytes = buildZip([
        { name: bodyName, data: "<x/>" },
        { name: "short.bin", data: zeros(100), declaredSize: 500 },
      ]);
      const error = failure(await module.parse(bytes, resolveLimits()));
      expect(error.code).toBe("zip-limit");
      expect(error.detail?.limit).toBe("declaredSize");
      expect(error.detail?.inflated).toBe(100);
      expect(parsers.mammoth).toHaveBeenCalledTimes(0);
      expect(parsers.excel).toHaveBeenCalledTimes(0);
    }
  });

  it("an entry whose compressed data is damaged is corrupt, not an exception", async () => {
    const bytes = buildZip([
      { name: "word/document.xml", data: "<x/>" },
      { name: "broken.bin", data: zeros(100), declaredCompressedSize: 3 },
    ]);
    const error = failure(await docxModule.parse(bytes, resolveLimits()));
    expect(error.code).toBe("corrupt");
    expect(parsers.mammoth).toHaveBeenCalledTimes(0);
  });
});

describe("C4 entry names", () => {
  const BAD: [string, ZipEntrySpec, string][] = [
    ["parent segment first", { name: "../evil.xml", data: "x" }, "parent-segment"],
    ["parent segment inside", { name: "word/../evil.xml", data: "x" }, "parent-segment"],
    ["parent segment last", { name: "word/..", data: "x" }, "parent-segment"],
    ["absolute path", { name: "/abs/evil.xml", data: "x" }, "absolute"],
    ["backslash", { name: "word\\evil.xml", data: "x" }, "backslash"],
    ["drive letter", { name: "C:evil.xml", data: "x" }, "drive-letter"],
    ["NUL", { name: "x", rawName: Uint8Array.from([0x61, 0x00, 0x62]), data: "x" }, "nul"],
  ];

  it.each(BAD)("7: %s -> zip-path with the rule named", async (_label, entry, rule) => {
    for (const [, module, bodyName] of MODULES) {
      const bytes = buildZip([{ name: bodyName, data: "<x/>" }, entry]);
      const error = failure(await module.parse(bytes, resolveLimits()));
      expect(error.code).toBe("zip-path");
      expect(error.detail?.rule).toBe(rule);
      expect(parsers.mammoth).toHaveBeenCalledTimes(0);
      expect(parsers.excel).toHaveBeenCalledTimes(0);
    }
  });

  it("7: a rejected name is not echoed into the message (no document content)", async () => {
    const error = failure(
      await docxModule.parse(
        buildZip([
          { name: "word/document.xml", data: "x" },
          { name: "../SECRET-NAME", data: "x" },
        ]),
        resolveLimits(),
      ),
    );
    expect(JSON.stringify(error)).not.toContain("SECRET-NAME");
  });

  it("ordinary nested names and a directory entry are fine", async () => {
    const result = await guardZip(
      buildZip([
        { name: "word/", data: "" },
        { name: "word/_rels/document.xml.rels", data: "<r/>" },
        { name: "a..b/c.xml", data: "<c/>" },
      ]),
      resolveLimits().zip,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries.map((e) => e.name)).toEqual([
        "word/_rels/document.xml.rels",
        "a..b/c.xml",
      ]);
      expect(Object.keys(unzipSync(result.rezipped))).toEqual([
        "word/_rels/document.xml.rels",
        "a..b/c.xml",
      ]);
    }
  });
});

describe("C4 a valid document just under every limit passes", () => {
  const bytes = buildDocx({ body: [{ text: "경계 문서" }] });

  it("passes at exactly the limits and fails one below each", async () => {
    const open = await guardZip(bytes, resolveLimits().zip);
    if (!open.ok) throw new Error("builder output must pass");
    const sizes = open.entries.map((e) => e.data.length);
    const edge = {
      maxEntries: sizes.length,
      maxEntryBytes: Math.max(...sizes),
      maxTotalBytes: sizes.reduce((a, b) => a + b, 0),
    };
    const atLimit = await docxModule.parse(bytes, limitsOf(edge));
    expect(atLimit.ok).toBe(true);
    expect(parsers.mammoth).toHaveBeenCalledTimes(1);

    for (const key of ["maxEntries", "maxEntryBytes", "maxTotalBytes"] as const) {
      const error = failure(
        await docxModule.parse(bytes, limitsOf({ ...edge, [key]: edge[key] - 1 })),
      );
      expect(error.code).toBe("zip-limit");
      expect(error.detail?.limit).toBe(key);
    }
  });
});

describe("the parser gets a re-zipped archive of the checked entries only", () => {
  it("uses the central directory's names and content, never the local header's", async () => {
    const bytes = buildZip([
      { name: "word/document.xml", data: "<w:document/>", localName: "word/other.xml" },
      { name: "extra.txt", data: "kept" },
    ]);
    const result = await guardZip(bytes, resolveLimits().zip);
    if (!result.ok) throw new Error("must pass");
    expect(result.entries.map((e) => e.name)).toEqual(["word/document.xml", "extra.txt"]);
    const files = unzipSync(result.rezipped);
    expect(Object.keys(files)).toEqual(["word/document.xml", "extra.txt"]);
    expect(new TextDecoder().decode(files["word/document.xml"])).toBe("<w:document/>");
  });

  it("DOCX: mammoth is handed the re-zipped bytes, not the original", async () => {
    const original = buildDocx({ body: [{ text: "원본" }] });
    await docxModule.parse(original, resolveLimits());
    const input = parsers.mammoth.mock.calls[0]?.[0] as { buffer: Buffer };
    expect(Buffer.from(input.buffer).equals(Buffer.from(original))).toBe(false);
    expect(Object.keys(unzipSync(new Uint8Array(input.buffer))).sort()).toEqual(
      Object.keys(unzipSync(original)).sort(),
    );
  });
});

describe("damaged archives", () => {
  it("a ZIP signature followed by garbage is corrupt, never a rejection", async () => {
    const garbage = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5]);
    for (const [, module] of MODULES) {
      const error = failure(await module.parse(garbage, resolveLimits()));
      expect(error.code).toBe("corrupt");
    }
    expect(parsers.mammoth).toHaveBeenCalledTimes(0);
    expect(parsers.excel).toHaveBeenCalledTimes(0);
  });
});
