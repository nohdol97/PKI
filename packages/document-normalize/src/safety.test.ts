// Cross-format safety checks over the whole fixture bundle: I02A-C7 (no network, no
// script), C6 (corrupt inputs come back as results), C9 (limitation codes: code
// constant = emitted by fixtures = spec table), C1/R9 (block invariants).
import { readFileSync } from "node:fs";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codePointSlice, LIMITATION_CODES, normalizeDocument } from "./index.ts";
import type { NormalizedDocument, NormalizeResult } from "./index.ts";
import type { Block } from "./types.ts";
import {
  generateFixtures,
  HTML_SCRIPT_MARKER,
  HTML_SCRIPT_SENTINEL,
} from "./testing/generate-fixtures.ts";
import { buildDocx, buildXlsx, buildZip } from "./testing/ooxml-builder.ts";

afterEach(() => vi.restoreAllMocks());

const fixtures = generateFixtures();
const run = (name: string, bytes: Uint8Array): Promise<NormalizeResult> =>
  normalizeDocument({ kind: "bytes", bytes, name });
const runAll = async (): Promise<Map<string, NormalizeResult>> => {
  const out = new Map<string, NormalizeResult>();
  for (const [name, bytes] of fixtures) out.set(name, await run(name, bytes));
  return out;
};
const documents = (results: Map<string, NormalizeResult>): [string, NormalizedDocument][] =>
  [...results].flatMap(([name, r]) =>
    r.ok ? [[name, r.document] as [string, NormalizedDocument]] : [],
  );

describe("no network, no script (C7, R6)", () => {
  it("makes no network call for any fixture, and the same spies do catch a real call", async () => {
    const calls: string[] = [];
    const block = (label: string) => () => {
      calls.push(label);
      throw new Error(`blocked ${label}`);
    };
    const spy = (target: object, name: string, label: string) =>
      vi
        .spyOn(target as Record<string, (...args: unknown[]) => unknown>, name)
        .mockImplementation(block(label));
    vi.spyOn(globalThis, "fetch").mockImplementation(((): Promise<Response> => {
      calls.push("fetch");
      return Promise.reject(new Error("blocked fetch"));
    }) as typeof fetch);
    spy(http, "request", "http.request");
    spy(http, "get", "http.get");
    spy(https, "request", "https.request");
    spy(https, "get", "https.get");
    spy(net, "connect", "net.connect");
    spy(net, "createConnection", "net.createConnection");
    spy(tls, "connect", "tls.connect");
    spy(dns, "lookup", "dns.lookup");

    // Positive control: every spy catches a real call made the way a parser would make it.
    await expect(fetch("https://example.invalid/")).rejects.toThrow("blocked fetch");
    expect(() => http.request("http://example.invalid/")).toThrow("blocked");
    expect(() => http.get("http://example.invalid/")).toThrow("blocked");
    expect(() => https.request("https://example.invalid/")).toThrow("blocked");
    expect(() => https.get("https://example.invalid/")).toThrow("blocked");
    expect(() => net.connect(1)).toThrow("blocked");
    expect(() => net.createConnection(1)).toThrow("blocked");
    expect(() => tls.connect(1)).toThrow("blocked");
    expect(() => dns.lookup("example.invalid", () => undefined)).toThrow("blocked");
    expect(calls.sort()).toEqual(
      [
        "dns.lookup",
        "fetch",
        "http.get",
        "http.request",
        "https.get",
        "https.request",
        "net.connect",
        "net.createConnection",
        "tls.connect",
      ].sort(),
    );
    calls.length = 0;

    const results = await runAll();
    expect(results.size).toBe(fixtures.size);
    expect(calls).toEqual([]);
  });

  it("never runs the HTML script and keeps its body and the iframe body out of the text", async () => {
    const globals = globalThis as Record<string, unknown>;
    Reflect.deleteProperty(globals, HTML_SCRIPT_MARKER);
    const name = "limit-html-hostile.html";
    const r = await run(name, fixtures.get(name) as Uint8Array);
    if (!r.ok) throw new Error("expected success");
    expect(globals[HTML_SCRIPT_MARKER]).toBeUndefined();
    expect(r.document.text).not.toContain(HTML_SCRIPT_SENTINEL);
    expect(r.document.text).not.toContain("IFRAME-SENTINEL");
    expect(r.document.text).not.toContain(HTML_SCRIPT_MARKER);
    expect(r.document.text).toContain("보이는 글");
  });

  it("keeps the Markdown <script> as literal text", async () => {
    const name = "limit-markdown-raw-html-and-links.md";
    const r = await run(name, fixtures.get(name) as Uint8Array);
    if (!r.ok) throw new Error("expected success");
    expect(r.document.text).toContain("<script>");
    expect(r.document.text).not.toContain("https://example.invalid");
  });
});

describe("corrupt bundle (C6, R5)", () => {
  const CORRUPT: Record<string, string> = {
    "corrupt-text-latin1.txt": "encoding-undecidable",
    "corrupt-bytes.txt": "encoding-undecidable",
    "corrupt-bytes.md": "encoding-undecidable",
    "corrupt-bytes.html": "encoding-undecidable",
    "corrupt-csv-unclosed-quote.csv": "corrupt",
    "corrupt-json-invalid.json": "corrupt",
    "corrupt-pdf-truncated.pdf": "corrupt",
    "corrupt-pdf-encrypted.pdf": "encrypted",
    "corrupt-pdf-not-pdf.pdf": "format-mismatch",
    "corrupt-docx-not-zip.docx": "format-mismatch",
    "corrupt-docx-no-body.docx": "format-mismatch",
    "corrupt-xlsx-broken-workbook.xlsx": "corrupt",
  };

  it("names exactly the corrupt-* fixtures the generator makes", () => {
    expect(Object.keys(CORRUPT).sort()).toEqual(
      [...fixtures.keys()].filter((n) => n.startsWith("corrupt-")).sort(),
    );
  });

  it.each(Object.entries(CORRUPT))("%s resolves to %s and never rejects", async (name, code) => {
    const result = await run(name, fixtures.get(name) as Uint8Array);
    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(result).not.toHaveProperty("document");
  });

  it.each([".doc", ".xls", ".ppt", ".hwp", ".hwpx", ".rtf"])(
    "refuses the legacy extension %s as unsupported-format",
    async (extension) => {
      const result = await run(`old${extension}`, new Uint8Array([1, 2, 3]));
      expect(result).toMatchObject({ ok: false, error: { code: "unsupported-format" } });
    },
  );

  it("answers in-memory attack archives with results: bomb, ../ entry, lying size", async () => {
    const limits = { zip: { maxEntryBytes: 4096 } };
    const attack = async (entries: Parameters<typeof buildZip>[0]) =>
      normalizeDocument(
        { kind: "bytes", bytes: buildZip(entries), name: "attack.docx" },
        { limits },
      );
    const body = { name: "word/document.xml", data: "<w:document/>" };
    const bomb = { name: "word/bomb.bin", data: new Uint8Array(1 << 20) };
    const lying = { name: "word/lie.bin", data: new Uint8Array(1 << 20), declaredSize: 10 };
    expect(await attack([body, bomb])).toMatchObject({
      ok: false,
      error: { code: "zip-limit", detail: { limit: "maxEntryBytes" } },
    });
    expect(await attack([body, { name: "../evil.txt", data: "x" }])).toMatchObject({
      ok: false,
      error: { code: "zip-path" },
    });
    expect(await attack([body, lying])).toMatchObject({ ok: false, error: { code: "zip-limit" } });
  });
});

describe("limitation codes (C9, R18)", () => {
  const specPath = new URL(
    "../../../docs/specs/2026-11-21-I02-document-normalization.md",
    import.meta.url,
  );

  /** The codes in the first column of the spec's "한계 표시 코드" table. */
  function specTableCodes(markdown: string): string[] {
    const start = markdown.indexOf("### 한계 표시 코드");
    if (start < 0) throw new Error("spec section 한계 표시 코드 not found");
    const rest = markdown.slice(start + 1);
    const next = rest.indexOf("\n### ");
    const section = next < 0 ? rest : rest.slice(0, next);
    return [...section.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1] as string);
  }

  it("has one fixture per code, and constant = emitted by the fixtures = spec table", async () => {
    const emitters = new Map<string, string[]>();
    for (const [name, doc] of documents(await runAll())) {
      for (const { code } of doc.limitations)
        emitters.set(code, [...(emitters.get(code) ?? []), name]);
    }
    const constant = [...LIMITATION_CODES].sort();
    const emitted = [...emitters.keys()].sort();
    const table = specTableCodes(readFileSync(specPath, "utf8")).sort();

    expect(emitted).toEqual(constant);
    expect(table).toEqual(constant);
    for (const code of LIMITATION_CODES) {
      expect(emitters.get(code)?.length ?? 0, code).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("block invariants on every successful result (C1, R9)", () => {
  it("keeps blocks sorted, disjoint, in range, separated only by separators, slices non-empty", async () => {
    const all = documents(await runAll());
    expect(all.length).toBeGreaterThan(10);
    // R9: pages are separated by a blank line, block-per-element formats by one newline.
    const gaps: Partial<Record<NormalizedDocument["format"], string>> = {
      pdf: "\n\n",
      docx: "\n",
      html: "\n",
      markdown: "\n",
    };
    for (const [name, doc] of all) {
      const length = Array.from(doc.text).length;
      let previousEnd = 0;
      doc.blocks.forEach((b, i) => {
        const where = `${name} block ${i}`;
        expect(b.start, where).toBeGreaterThanOrEqual(previousEnd);
        expect(b.start, where).toBeGreaterThanOrEqual(0);
        expect(b.end, where).toBeGreaterThan(b.start);
        expect(b.end, where).toBeLessThanOrEqual(length);
        expect(codePointSlice(doc.text, b.start, b.end).trim(), where).not.toBe("");
        // Between blocks (and before the first / after the last) only separators.
        expect(codePointSlice(doc.text, previousEnd, b.start), where).toMatch(/^[\t\n]*$/);
        if (i > 0 && gaps[doc.format] !== undefined) {
          // the comments of a DOCX follow its body after a blank line (I02B-R30)
          const isComment = (x: Block | undefined) =>
            x?.locator.format === "docx" && x.locator.comment !== undefined;
          const gap =
            doc.format === "docx" && isComment(b) && !isComment(doc.blocks[i - 1])
              ? "\n\n"
              : gaps[doc.format];
          expect(codePointSlice(doc.text, previousEnd, b.start), where).toBe(gap);
        }
        expect(b.locator.format, where).toBe(doc.format);
        previousEnd = b.end;
      });
      expect(codePointSlice(doc.text, previousEnd, length), `${name} tail`).toMatch(/^[\t\n]*$/);
      expect(doc.text, name).not.toContain("\r");
      expect(doc.text, name).not.toContain("�");
      expect(doc.text.startsWith("﻿"), name).toBe(false);
    }
  });

  it("keeps the builders deterministic (a smoke check of the inputs the generator uses)", () => {
    const docx = () => buildDocx({ body: [{ text: "가" }] });
    const xlsx = () => buildXlsx({ sheets: [{ name: "s", rows: [["a"]] }] });
    expect(Buffer.from(docx()).equals(Buffer.from(docx()))).toBe(true);
    expect(Buffer.from(xlsx()).equals(Buffer.from(xlsx()))).toBe(true);
  });
});
