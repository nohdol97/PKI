import http from "node:http";
import https from "node:https";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LIMITS } from "../limits.ts";
import { normalizeDocument } from "../normalize.ts";
import { codePointSlice } from "../text-builder.ts";
import { buildPdf, truncatePdf } from "../testing/pdf-builder.ts";
import { pdfDateToIso, pdfModule } from "./pdf.ts";

// Wraps unpdf's opener so a test can see the options it got and the page reads it made.
const opened = vi.hoisted(() => ({
  calls: [] as { options: Record<string, unknown>; getPage: ReturnType<typeof vi.fn> }[],
  /** When set, every page reports these text items (pdf.js text-layer shapes a builder cannot make). */
  items: undefined as { str: string; hasEOL: boolean }[][] | undefined,
}));
vi.mock("unpdf", async () => {
  const actual = await vi.importActual<typeof import("unpdf")>("unpdf");
  return {
    ...actual,
    getDocumentProxy: async (data: Uint8Array, options: Record<string, unknown>) => {
      const proxy = await actual.getDocumentProxy(data, options);
      const original = proxy.getPage.bind(proxy);
      const getPage = vi.fn(async (n: number) =>
        opened.items
          ? ({ getTextContent: async () => ({ items: opened.items?.[n - 1] ?? [] }) } as never)
          : original(n),
      );
      proxy.getPage = getPage as unknown as typeof proxy.getPage;
      opened.calls.push({ options, getPage });
      return proxy;
    },
  };
});

afterEach(() => {
  opened.calls.length = 0;
  opened.items = undefined;
  vi.restoreAllMocks();
});

async function parseOk(bytes: Uint8Array, limits = DEFAULT_LIMITS) {
  const result = await pdfModule.parse(bytes, limits);
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
  return result.value;
}

const normalize = (bytes: Uint8Array, limits?: Parameters<typeof normalizeDocument>[1]) =>
  normalizeDocument({ kind: "bytes", bytes, name: "doc.pdf" }, limits);

describe("pdfModule text and blocks (C1, C2)", () => {
  const PAGE1 = "안녕하세요 😀 café";
  const PAGE2 = "둘째 쪽\ne\u0301 끝";
  const PAGE3 = "마지막 🎉";
  const bytes = buildPdf({ pages: [PAGE1, PAGE2, PAGE3] });

  it("makes one block per page, in page order, with 1-based page locators", async () => {
    const doc = await parseOk(bytes);
    expect(doc.text).toBe([PAGE1, PAGE2, PAGE3].join("\n\n"));
    expect(doc.blocks.map((b) => b.locator)).toEqual([
      { format: "pdf", page: 1 },
      { format: "pdf", page: 2 },
      { format: "pdf", page: 3 },
    ]);
    expect(doc.blocks.map((b) => codePointSlice(doc.text, b.start, b.end))).toEqual([
      PAGE1,
      PAGE2,
      PAGE3,
    ]);
  });

  it("keeps line ends inside a page as \\n and drops the last one", async () => {
    const doc = await parseOk(buildPdf({ pages: ["첫 줄\n둘째 줄\n셋째 줄"] }));
    expect(doc.text).toBe("첫 줄\n둘째 줄\n셋째 줄");
  });

  it("counts block positions in code points, not UTF-16 units (C2)", async () => {
    const doc = await parseOk(bytes);
    const afterEmoji = doc.blocks[1];
    expect(afterEmoji?.start).toBe([...PAGE1].length + 2);
    // The emoji is 2 UTF-16 units, so the UTF-16 index of page 2 is larger.
    expect(doc.text.indexOf(PAGE2)).toBeGreaterThan(afterEmoji?.start ?? Infinity);
    expect(doc.blocks[2]?.end).toBe([...doc.text].length);
  });

  it("keeps combining marks as separate code points", async () => {
    const doc = await parseOk(buildPdf({ pages: ["é"] }));
    expect([...doc.text]).toEqual(["e", "́"]);
    expect(doc.blocks[0]).toMatchObject({ start: 0, end: 2 });
  });

  it("drops the line end that closes a page's last line", async () => {
    opened.items = [[{ str: "끝", hasEOL: true }]];
    expect((await parseOk(buildPdf({ pages: ["x"] }))).text).toBe("끝");
  });

  it("does not change or detach the input bytes", async () => {
    const copy = bytes.slice();
    await parseOk(bytes);
    expect(bytes).toEqual(copy);
  });
});

describe("pages without a text layer (R10, R18, C9)", () => {
  it("makes no block for them and lists their page numbers", async () => {
    const doc = await parseOk(buildPdf({ pages: ["하나", "", "셋", " "] }));
    expect(doc.blocks.map((b) => b.locator)).toEqual([
      { format: "pdf", page: 1 },
      { format: "pdf", page: 3 },
    ]);
    expect(doc.text).toBe("하나\n\n셋");
    expect(doc.limitations).toEqual([{ code: "pdf.page-without-text", pages: [2, 4] }]);
  });

  it("counts a page of only blanks and line ends as having no text", async () => {
    opened.items = [
      [
        { str: " ", hasEOL: true },
        { str: "", hasEOL: true },
      ],
    ];
    const doc = await parseOk(buildPdf({ pages: ["x"] }));
    expect(doc).toMatchObject({ text: "", blocks: [] });
    expect(doc.limitations).toEqual([{ code: "pdf.page-without-text", pages: [1] }]);
  });

  it("returns empty text, no blocks and every page when nothing has text", async () => {
    const doc = await parseOk(buildPdf({ pages: ["", ""] }));
    expect(doc).toMatchObject({ text: "", blocks: [] });
    expect(doc.limitations).toEqual([{ code: "pdf.page-without-text", pages: [1, 2] }]);
  });

  it("adds no limitation when every page has text", async () => {
    expect((await parseOk(buildPdf({ pages: ["a", "b"] }))).limitations).toEqual([]);
  });
});

describe("page limit (R3, C5)", () => {
  const bytes = buildPdf({ pages: ["a", "b", "c"] });
  const limits = (maxPages: number) => ({ ...DEFAULT_LIMITS, pdf: { maxPages } });

  it("accepts a page count equal to the limit", async () => {
    expect((await parseOk(bytes, limits(3))).blocks).toHaveLength(3);
  });

  it("returns too-large for one page over, before any page is read", async () => {
    const result = await pdfModule.parse(bytes, limits(2));
    expect(result).toMatchObject({ ok: false, error: { code: "too-large" } });
    expect(opened.calls).toHaveLength(1);
    expect(opened.calls[0]?.getPage).not.toHaveBeenCalled();
  });

  it("reaches the same answer through normalizeDocument and the limits option", async () => {
    const result = await normalize(bytes, { limits: { pdf: { maxPages: 2 } } });
    expect(result).toMatchObject({ ok: false, error: { code: "too-large" } });
    expect((await normalize(bytes, { limits: { pdf: { maxPages: 3 } } })).ok).toBe(true);
  });
});

describe("failures (R10, C6)", () => {
  it("returns encrypted for a password-protected PDF", async () => {
    const result = await normalize(buildPdf({ pages: ["비밀"], encrypt: true }));
    expect(result).toMatchObject({ ok: false, error: { code: "encrypted" } });
  });

  it("returns corrupt for truncated PDFs at several cut points", async () => {
    const bytes = buildPdf({ pages: ["안녕", "둘째"] });
    for (const keep of [0.2, 0.5, 0.8, bytes.length - 30]) {
      const result = await normalize(truncatePdf(bytes, keep));
      expect(result, `cut at ${keep}`).toMatchObject({ ok: false, error: { code: "corrupt" } });
    }
  });

  it("returns corrupt for a file that only has the signature", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.4\nnot a document");
    expect(await normalize(bytes)).toMatchObject({ ok: false, error: { code: "corrupt" } });
  });

  it("puts no document content in a failure message", async () => {
    const result = await normalize(truncatePdf(buildPdf({ pages: ["기밀문장"] }), 0.5));
    expect(JSON.stringify(result)).not.toContain("기밀문장");
  });
});

describe("metadata (R17, C8)", () => {
  it("reads Title, Author and the dates as ISO-8601, plus the page count", async () => {
    const doc = await parseOk(
      buildPdf({
        pages: ["a", "b"],
        info: {
          title: "분기 보고서 😀",
          author: "홍길동",
          creationDate: "D:20240102030405Z",
          modDate: "D:20240102120000+09'00'",
        },
      }),
    );
    expect(doc.metadata).toEqual({
      title: "분기 보고서 😀",
      author: "홍길동",
      created: "2024-01-02T03:04:05.000Z",
      modified: "2024-01-02T03:00:00.000Z",
      pageCount: 2,
    });
  });

  it("leaves a field out when the PDF has no value for it", async () => {
    const none = (await parseOk(buildPdf({ pages: ["a"] }))).metadata;
    expect(none).toEqual({ pageCount: 1 });
    const some = (await parseOk(buildPdf({ pages: ["a"], info: { title: "T", author: "" } })))
      .metadata;
    expect(some).toEqual({ title: "T", pageCount: 1 });
    expect("author" in some).toBe(false);
  });

  it("omits an unparseable date instead of guessing", async () => {
    const doc = await parseOk(
      buildPdf({ pages: ["a"], info: { creationDate: "yesterday", modDate: "D:2024" } }),
    );
    expect(doc.metadata).toEqual({ pageCount: 1, modified: "2024-01-01T00:00:00.000Z" });
  });

  it("converts PDF dates", () => {
    expect(pdfDateToIso("D:20240229235959-05'30'")).toBe("2024-03-01T05:29:59.000Z");
    expect(pdfDateToIso("D:20240102030405")).toBe("2024-01-02T03:04:05.000Z");
    expect(pdfDateToIso("D:20241301")).toBeUndefined();
    expect(pdfDateToIso(undefined)).toBeUndefined();
  });
});

describe("data only (R6)", () => {
  it("opens pdf.js without eval, system fonts, or any font/CMap location", async () => {
    await parseOk(buildPdf({ pages: ["a"] }));
    const options = opened.calls[0]?.options ?? {};
    expect(options).toMatchObject({
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
    });
    for (const key of ["standardFontDataUrl", "cMapUrl", "iccUrl", "wasmUrl"]) {
      expect(options[key], key).toBeUndefined();
    }
  });

  it("makes no network connection for a PDF with a link annotation", async () => {
    const uri = "http://127.0.0.1:9/never";
    const trap = () => {
      throw new Error("network use");
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(trap);
    const spies = [
      vi.spyOn(http, "request").mockImplementation(trap),
      vi.spyOn(http, "get").mockImplementation(trap),
      vi.spyOn(https, "request").mockImplementation(trap),
      vi.spyOn(https, "get").mockImplementation(trap),
      vi.spyOn(net, "connect").mockImplementation(trap),
      vi.spyOn(net.Socket.prototype, "connect").mockImplementation(trap),
    ];
    const doc = await parseOk(buildPdf({ pages: ["링크 쪽"], linkUri: uri }));
    expect(doc.text).toBe("링크 쪽");
    expect(doc.text).not.toContain(uri);
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
