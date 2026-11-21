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

  it("skips comments and processing instructions, keeps `>` inside quoted values, returns CDATA as text", () => {
    expect(tokens('<?xml v?><!-- <a> --><x:a k="1>2"><![CDATA[<b>]]>t<c/></x:a>')).toEqual([
      "a",
      "#<b>",
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

  it("decodes the five predefined entities and numeric references only (D1)", () => {
    expect(attributeValue(` state="&#104;idden"`, "state")).toBe("hidden");
    expect(attributeValue(` state="&#x68;&#X69;dden"`, "state")).toBe("hidden");
    expect(attributeValue(` v="&lt;&gt;&amp;&quot;&apos;"`, "v")).toBe(`<>&"'`);
    expect(attributeValue(` v="&nbsp;&#xZZ;&#1114112;&amp;lt;"`, "v")).toBe(
      "&nbsp;&#xZZ;&#1114112;&lt;",
    );
  });

  it("a processing instruction ends at `?>`, not at the first `>` (D1)", () => {
    expect(tokens("<?pi a > <!-- ?><b/><!-- c --><d/>")).toEqual(["b", "d"]);
  });

  it("a DOCTYPE ends at its own `>`: quoted literals and the internal subset may hold `>` (D1)", () => {
    expect(tokens('<!DOCTYPE w SYSTEM "a>b<!--"><b/><!-- c --><d/>')).toEqual(["b", "d"]);
    expect(tokens("<!DOCTYPE w SYSTEM 'a>b'><b/>")).toEqual(["b"]);
    expect(tokens('<!DOCTYPE w [<!ENTITY e "x>]"><!-- it\'s ]> --><?p ]> ?>]><b/>')).toEqual(["b"]);
  });

  it("CDATA content is text, an empty or unclosed CDATA is not (D1)", () => {
    expect(tokens("<t><![CDATA[HDR]]></t>")).toEqual(["t", "#HDR", "/t"]);
    expect(tokens("<t><![CDATA[]]></t>")).toEqual(["t", "/t"]);
    expect(tokens("<t><![CDATA[HDR")).toEqual(["t"]);
  });

  it("stays linear on floods of `<?`, long DOCTYPE literals and unclosed CDATA (D1)", () => {
    const mb = 1_000_000;
    const floods = [
      "<?".repeat(mb / 2),
      `<!DOCTYPE a "${"x".repeat(mb)}`,
      `<!DOCTYPE a [${"<!ENTITY e 'x".repeat(mb / 12)}`,
      "<![CDATA[".repeat(mb / 9),
      `<a x='${"&#104;".repeat(mb / 6)}'/>`,
    ];
    for (const xml of floods) {
      const started = Date.now();
      scanXml(xml, (t) => {
        if (t.kind === "open") attributeValue(t.attributes, "x");
        return false;
      });
      expect(Date.now() - started).toBeLessThan(1000);
    }
  });
});
