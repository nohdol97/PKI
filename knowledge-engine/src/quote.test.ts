// extraction.quote (V02-R6, C1), unit part: the code locates a quote in the
// stored body and computes [start, end) in Unicode code points; a quote the body
// does not hold exactly once is dropped. That positions in a response are ignored
// is in extraction.test.ts (it needs the stored evidence).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { locateQuote } from "./quote.ts";

const fixtures = resolve(import.meta.dirname, "../../fixtures");
const record = (file: string) =>
  JSON.parse(readFileSync(resolve(fixtures, file), "utf8").split("\n")[0] as string) as {
    content: string;
  };

describe("locateQuote", () => {
  it("drops a quote the body does not hold", () => {
    expect(locateQuote("물결 API 개발 완료", "물결 API 개발 지연")).toEqual({
      dropped: "quote-missing",
    });
    // exact: no normalization of spaces or case (A21)
    expect(locateQuote("물결  API", "물결 API")).toEqual({ dropped: "quote-missing" });
  });

  it("drops a quote found more than once, overlapping occurrences included", () => {
    expect(locateQuote("A는 B에 의존. A는 B에 의존.", "A는 B에 의존")).toEqual({
      dropped: "quote-ambiguous",
    });
    expect(locateQuote("aaa", "aa")).toEqual({ dropped: "quote-ambiguous" });
  });

  it("counts code points: emoji outside the BMP before the quote shift UTF-16 offsets", () => {
    const body = "🙂 x 📅 미리내 프로젝트";
    expect(locateQuote(body, "미리내")).toEqual({ start: 6, end: 9 });
    expect(body.indexOf("미리내")).toBe(8); // what a UTF-16 count would wrongly store
  });

  it("agrees with the fixture's expected spans (Korean and emoji)", () => {
    expect(
      locateQuote(
        record("v02-mail.jsonl").content,
        "미리내 프로젝트의 완료 목표는 2026-12-05입니다",
      ),
    ).toEqual({ start: 30, end: 60 });
    expect(
      locateQuote(
        record("v02-messenger.jsonl").content,
        "물결 API 개발 완료가 2026-12-10으로 연기되었습니다",
      ),
    ).toEqual({ start: 12, end: 46 });
  });

  it("drops a quote that is empty, splits a surrogate pair, or lies past a NUL", () => {
    expect(locateQuote("abc", "")).toEqual({ dropped: "quote-missing" });
    const emoji = "x🙂y";
    expect(locateQuote(emoji, emoji.slice(2))).toEqual({ dropped: "quote-missing" }); // low half + y
    expect(locateQuote(emoji, emoji.slice(0, 2))).toEqual({ dropped: "quote-missing" }); // x + high half
    // SQLite's length() stops at U+0000, so storage could not check such a span
    expect(locateQuote("a\u0000bc", "bc")).toEqual({ dropped: "quote-missing" });
  });
});
