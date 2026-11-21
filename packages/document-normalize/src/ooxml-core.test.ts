import { describe, expect, it } from "vitest";
import { resolveLimits } from "./limits.ts";
import { attributeValue, entryText, openOoxml, readCoreProperties, scanXml } from "./ooxml-core.ts";
import { buildDocx, buildZip } from "./testing/ooxml-builder.ts";
import type { CoreProps } from "./testing/ooxml-builder.ts";

describe("openOoxml", () => {
  it("opens a package that has its body part and exposes the checked entries", async () => {
    const opened = await openOoxml(
      buildDocx({ body: [{ text: "x" }] }),
      resolveLimits(),
      "word/document.xml",
    );
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(entryText(opened.pkg, "word/document.xml")).toContain("<w:t");
      expect(entryText(opened.pkg, "no/such.xml")).toBe("");
    }
  });

  it("a ZIP without the body part is format-mismatch (spec delta D3)", async () => {
    const opened = await openOoxml(
      buildZip([{ name: "other.xml", data: "<x/>" }]),
      resolveLimits(),
      "word/document.xml",
    );
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error.code).toBe("format-mismatch");
  });

  it("passes the guard's failure through unchanged", async () => {
    const bytes = buildZip([
      { name: "word/document.xml", data: "x" },
      { name: "../x", data: "x" },
    ]);
    const opened = await openOoxml(bytes, resolveLimits(), "word/document.xml");
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error.code).toBe("zip-path");
  });
});

describe("readCoreProperties", () => {
  const read = async (core: CoreProps) => {
    const opened = await openOoxml(
      buildDocx({ body: [], core }),
      resolveLimits(),
      "word/document.xml",
    );
    if (!opened.ok) throw new Error("must open");
    return readCoreProperties(opened.pkg);
  };

  it("returns ISO-8601 dates and drops empty or unparsable fields", async () => {
    expect(
      await read({ title: "t", author: " ", created: "2026-03-01T09:00:00+09:00", modified: "x" }),
    ).toEqual({
      title: "t",
      created: "2026-03-01T00:00:00.000Z",
    });
  });

  it("returns an empty object when core.xml is missing or not XML", async () => {
    const without = await openOoxml(
      buildZip([{ name: "word/document.xml", data: "x" }]),
      resolveLimits(),
      "word/document.xml",
    );
    if (!without.ok) throw new Error("must open");
    expect(readCoreProperties(without.pkg)).toEqual({});
    const broken = await openOoxml(
      buildZip([
        { name: "word/document.xml", data: "x" },
        { name: "docProps/core.xml", data: "<<< no" },
      ]),
      resolveLimits(),
      "word/document.xml",
    );
    if (!broken.ok) throw new Error("must open");
    expect(readCoreProperties(broken.pkg)).toEqual({});
  });
});

describe("scanXml (B1)", () => {
  const tokens = (xml: string) => {
    const out: string[] = [];
    scanXml(xml, (t) => {
      out.push(t.kind === "text" ? `#${t.value}` : `${t.kind === "close" ? "/" : ""}${t.name}`);
      return false;
    });
    return out;
  };

  it("skips comments, CDATA, processing instructions and keeps `>` inside quoted values", () => {
    expect(tokens('<?xml v?><!-- <a> --><x:a k="1>2"><![CDATA[<b>]]>t<c/></x:a>')).toEqual([
      "a",
      "#t",
      "c",
      "/a",
    ]);
  });

  it("an unterminated tag or comment ends the scan without a token", () => {
    expect(tokens("<a><b ")).toEqual(["a"]);
    expect(tokens("<a><!-- <b>")).toEqual(["a"]);
  });

  it("reads attribute values by local name, quoted either way", () => {
    expect(attributeValue(` w:type = 'x' state="hidden"`, "state")).toBe("hidden");
    expect(attributeValue(` w:type = 'x' state="hidden"`, "type")).toBe("x");
    expect(attributeValue(` a b=c d="1"`, "d")).toBe("1");
    expect(attributeValue(` a="1`, "a")).toBeUndefined();
  });
});
