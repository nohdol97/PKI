// I02A-C1/C2/C3 for TXT: verbatim text, one block per non-blank line with a 1-based line number.
import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../limits.ts";
import { normalizeDocument } from "../normalize.ts";
import { codePointSlice } from "../text-builder.ts";
import { txtModule } from "./txt.ts";

const parse = (text: string) => {
  const r = txtModule.parse(text, DEFAULT_LIMITS);
  if (!("ok" in r) || !r.ok) throw new Error("expected success");
  return r.value;
};

describe("txt module", () => {
  it("keeps the text as is and makes one block per non-blank line", () => {
    const v = parse("첫째 줄\n\n  \n셋째 줄\n");
    expect(v.text).toBe("첫째 줄\n\n  \n셋째 줄\n");
    expect(v.blocks.map((b) => [b.locator, codePointSlice(v.text, b.start, b.end)])).toEqual([
      [{ format: "txt", line: 1 }, "첫째 줄"],
      [{ format: "txt", line: 4 }, "셋째 줄"],
    ]);
    expect(v.limitations).toEqual([]);
  });

  it("counts block positions in code points when an emoji comes first (C2)", () => {
    const v = parse("😀 hi\n한글 é\n끝");
    expect(v.blocks[1]?.start).toBe(5);
    expect(v.text.indexOf("한글")).toBe(6);
    expect(v.blocks.map((b) => codePointSlice(v.text, b.start, b.end))).toEqual([
      "😀 hi",
      "한글 é",
      "끝",
    ]);
  });

  it("has no blocks for an empty file", () => {
    expect(parse("").blocks).toEqual([]);
  });

  it("carries the encoding through the pipeline for a UTF-8 BOM file with CRLF", async () => {
    const bytes = Uint8Array.from(Buffer.from("﻿가\r\n나", "utf8"));
    const r = await normalizeDocument({ kind: "bytes", bytes, name: "a.txt" });
    expect(r).toMatchObject({
      ok: true,
      document: { format: "txt", text: "가\n나", encoding: { name: "utf-8", method: "bom" } },
    });
  });
});
