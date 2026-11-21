// I02A-C1/C7/C8/C9 at the HTML format level (R6, R14, R17).
import { afterEach, describe, expect, it, vi } from "vitest";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { DEFAULT_LIMITS } from "../limits.ts";
import { codePointSlice } from "../text-builder.ts";
import type { ParsedDocument } from "../types.ts";
import { htmlModule } from "./html.ts";

afterEach(() => vi.restoreAllMocks());

function parse(html: string): ParsedDocument {
  const result = htmlModule.parse(html, DEFAULT_LIMITS);
  if (result instanceof Promise || !result.ok) throw new Error("expected a synchronous success");
  return result.value;
}

function slices(doc: ParsedDocument): string[] {
  return doc.blocks.map((b) => codePointSlice(doc.text, b.start, b.end));
}

describe("html blocks (R14, R9)", () => {
  it("makes one block per block-level element with path and line", () => {
    const doc = parse(
      "<!doctype html>\n<html><body>\n<div>\n<p>first</p>\n<p>second</p>\n</div>\n<ul><li>a</li><li>b</li></ul>\n</body></html>",
    );
    expect(doc.text).toBe("first\nsecond\na\nb");
    expect(slices(doc)).toEqual(["first", "second", "a", "b"]);
    expect(doc.blocks.map((b) => b.locator)).toEqual([
      { format: "html", path: "body>div[1]>p[1]", line: 4 },
      { format: "html", path: "body>div[1]>p[2]", line: 5 },
      { format: "html", path: "body>ul[1]>li[1]", line: 7 },
      { format: "html", path: "body>ul[1]>li[2]", line: 7 },
    ]);
    expect(doc.limitations).toEqual([]);
  });

  it("indexes same-name siblings and counts only same-name ones", () => {
    const doc = parse("<body><p>a</p><div>x</div><p>b</p><div><p>c</p></div></body>");
    expect(doc.blocks.map((b) => (b.locator as { path: string }).path)).toEqual([
      "body>p[1]",
      "body>div[1]",
      "body>p[2]",
      "body>div[2]>p[1]",
    ]);
  });

  it("splits a block element's own text around a nested block", () => {
    const doc = parse("<body><div>before <b>bold</b> <p>inner</p> after</div></body>");
    expect(slices(doc)).toEqual(["before bold", "inner", "after"]);
    expect(doc.blocks.map((b) => (b.locator as { path: string }).path)).toEqual([
      "body>div[1]",
      "body>div[1]>p[1]",
      "body>div[1]",
    ]);
  });

  it("collapses whitespace except inside pre", () => {
    const doc = parse("<body><p>  a \n\t b   <i>c</i>  d </p><pre>x  y\n  z</pre></body>");
    expect(slices(doc)).toEqual(["a b c d", "x  y\n  z"]);
  });

  it("makes no block for empty or whitespace-only elements", () => {
    const doc = parse("<body><p></p><p>   \n </p><div><span> </span></div><p>ok</p></body>");
    expect(slices(doc)).toEqual(["ok"]);
    expect(doc.blocks[0]?.start).toBe(0);
  });

  it("reports the line where the text starts, not the element's", () => {
    const doc = parse("<body>\n<p>\n\n  late</p></body>");
    expect(doc.blocks[0]?.locator).toEqual({ format: "html", path: "body>p[1]", line: 4 });
  });

  it("puts table cells in their own blocks and decodes entities", () => {
    const doc = parse("<table><tr><td>a &amp; b</td><td>&#xD55C;&#xAE00;</td></tr></table>");
    expect(slices(doc)).toEqual(["a & b", "한글"]);
    expect((doc.blocks[0]?.locator as { path: string }).path).toBe(
      "body>table[1]>tbody[1]>tr[1]>td[1]",
    );
  });

  it("counts positions in code points", () => {
    const doc = parse("<p>😀 x</p><p>y</p>");
    expect(doc.blocks[1]?.start).toBe(4);
    expect(slices(doc)).toEqual(["😀 x", "y"]);
  });

  it("returns text-less input as an empty result", () => {
    expect(parse("").text).toBe("");
    expect(parse("<body></body>").blocks).toEqual([]);
  });

  it("does not take head content as text", () => {
    const doc = parse("<head><title>T</title></head><body><p>B</p></body>");
    expect(doc.text).toBe("B");
  });
});

describe("html metadata (R17, C8)", () => {
  it("reads title and author", () => {
    const doc = parse(
      '<head><title> My  Title </title><meta name="Author" content=" Kim  Dol "></head><body><p>x</p></body>',
    );
    expect(doc.metadata).toEqual({ title: "My Title", author: "Kim Dol" });
  });

  it("leaves absent or empty fields out", () => {
    expect(parse("<p>x</p>").metadata).toEqual({});
    const doc = parse('<head><title> </title><meta name="author" content=""></head><p>x</p>');
    expect(doc.metadata).toEqual({});
    expect("title" in doc.metadata).toBe(false);
    expect("author" in doc.metadata).toBe(false);
  });
});

const HOSTILE = `<!doctype html>
<html><head><title>T</title>
<link rel="stylesheet" href="https://evil.example/a.css">
<style>.x{background:url(https://evil.example/bg.png)} BODYSTYLE</style>
<script>globalThis.__pwned = true; document.write("SCRIPTBODY")</script>
</head>
<body onload="globalThis.__pwned = true">
<p onclick="globalThis.__pwned = true">visible</p>
<img src="https://evil.example/i.png" onerror="globalThis.__pwned = true" alt="pic">
<a href="javascript:globalThis.__pwned=true">link text</a>
<iframe src="https://evil.example/frame">IFRAMEBODY</iframe>
<noscript>NOSCRIPTBODY</noscript>
<template><p>TEMPLATEBODY</p></template>
<object data="https://evil.example/o"><p>OBJECTBODY</p></object>
<embed src="https://evil.example/e">
<svg><text>SVGBODY</text></svg>
<p>end</p>
<script>globalThis.__pwned = true</script>
</body></html>`;

describe("html data-only reading (R6, C7)", () => {
  it("never runs script and drops the content of removed elements", () => {
    const doc = parse(HOSTILE);
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
    expect(doc.text).toBe("visible\nlink text\nend");
    for (const word of [
      "SCRIPTBODY",
      "BODYSTYLE",
      "IFRAMEBODY",
      "NOSCRIPTBODY",
      "TEMPLATEBODY",
      "OBJECTBODY",
      "SVGBODY",
      "__pwned",
    ]) {
      expect(doc.text).not.toContain(word);
    }
  });

  it("counts removed elements and external references", () => {
    const doc = parse(HOSTILE);
    // style, 2 script, iframe, noscript, template, object, embed, svg
    expect(doc.limitations).toEqual([
      { code: "html.elements-removed", count: 9 },
      { code: "html.external-references-ignored", count: 6 },
    ]);
  });

  it("counts references on removed elements but not their children, and skips fragments and data URIs", () => {
    const doc = parse(
      '<p><a href="#top">a</a><a href="">b</a><img src="data:image/png;base64,AAAA"><a href="rel/page.html">c</a><img srcset="x.png 1x, y.png 2x"></p>',
    );
    expect(doc.limitations).toEqual([{ code: "html.external-references-ignored", count: 2 }]);
  });

  it("opens no connection and reads no file (local spy with a positive control)", async () => {
    const calls: string[] = [];
    const spy = (target: Record<string, unknown>, name: string, label: string) => {
      vi.spyOn(target as Record<string, (...args: unknown[]) => unknown>, name).mockImplementation(
        () => {
          calls.push(label);
          throw new Error("blocked");
        },
      );
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((() => {
      calls.push("fetch");
      throw new Error("blocked");
    }) as never);
    spy(http, "request", "http.request");
    spy(http, "get", "http.get");
    spy(https, "request", "https.request");
    spy(https, "get", "https.get");
    spy(net, "connect", "net.connect");
    spy(net, "createConnection", "net.createConnection");
    spy(tls, "connect", "tls.connect");
    spy(dns, "lookup", "dns.lookup");

    parse(HOSTILE);
    expect(calls).toEqual([]);

    // Positive control: the same spy does catch a real call.
    expect(() => fetchSpy("https://example.invalid/")).toThrow("blocked");
    expect(calls).toEqual(["fetch"]);
  });
});

describe("block invariants (R9)", () => {
  it("keeps blocks sorted, disjoint, in range and separated by one newline", () => {
    const doc = parse(HOSTILE);
    let previousEnd = -1;
    for (const b of doc.blocks) {
      expect(b.start).toBeGreaterThan(previousEnd - 1);
      expect(b.end).toBeGreaterThan(b.start);
      if (previousEnd >= 0) expect(codePointSlice(doc.text, previousEnd, b.start)).toBe("\n");
      previousEnd = b.end;
    }
    expect(previousEnd).toBe(Array.from(doc.text).length);
  });
});
