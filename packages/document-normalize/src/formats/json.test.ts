// I02A-C1/C6 for JSON: text kept verbatim, no structure flattening, invalid JSON is corrupt.
import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../limits.ts";
import { normalizeDocument } from "../normalize.ts";
import { codePointSlice } from "../text-builder.ts";
import { jsonModule } from "./json.ts";

const run = (text: string) => jsonModule.parse(text, DEFAULT_LIMITS);

describe("json module", () => {
  it("keeps pretty-printed JSON verbatim with line blocks", () => {
    const text = '{\n  "이름": "홍길동",\n\n  "목록": [1, 2]\n}\n';
    const r = run(text);
    if (!("ok" in r) || !r.ok) throw new Error("expected success");
    expect(r.value.text).toBe(text);
    expect(r.value.blocks.map((b) => [b.locator, codePointSlice(text, b.start, b.end)])).toEqual([
      [{ format: "json", line: 1 }, "{"],
      [{ format: "json", line: 2 }, '  "이름": "홍길동",'],
      [{ format: "json", line: 4 }, '  "목록": [1, 2]'],
      [{ format: "json", line: 5 }, "}"],
    ]);
  });

  it.each(["{", '{"a":1,}', "", "   ", "undefined", "{'a':1}"])(
    "returns corrupt for %j without putting the content in the message",
    (text) => {
      const r = run(text);
      expect(r).toMatchObject({ ok: false, error: { code: "corrupt" } });
      if ("ok" in r && !r.ok) expect(r.error.message).not.toContain(text.trim() || "\u0000");
    },
  );

  it("accepts scalar JSON documents", () => {
    expect(run("42")).toMatchObject({ ok: true });
    expect(run('"x"')).toMatchObject({ ok: true });
  });

  it("goes through the pipeline and reports corrupt for broken JSON bytes", async () => {
    const r = await normalizeDocument({
      kind: "bytes",
      bytes: Uint8Array.from(Buffer.from('{"a":', "utf8")),
      name: "x.json",
    });
    expect(r).toMatchObject({ ok: false, error: { code: "corrupt" } });
  });
});
