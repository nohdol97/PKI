// V02-R14: evidence spans are code point offsets into the version body (spec "T05가
// 넘기는 것" 12); the screen cuts the body by code points, never by UTF-16 index.
// The Insight is labelled as an inference, never as a confirmed fact.
import type { NativeLocator } from "@pki/contracts";
import { describe, expect, it } from "vitest";
import {
  evidenceVersionText,
  INSIGHT_EPISTEMIC,
  INSIGHT_NOT_CONFIRMED,
  locatorText,
  splitAtCodePoints,
} from "./evidence-text.ts";

describe("splitAtCodePoints", () => {
  // emoji outside the BMP (two UTF-16 units each) and Korean before the quote
  const body = "합성 🙂📅 자료: 미리내 프로젝트의 완료 목표는 2026-12-05입니다. 끝 🚧";
  const quote = "미리내 프로젝트의 완료 목표는 2026-12-05입니다";
  const start = Array.from(body).indexOf("미");
  const end = start + Array.from(quote).length;

  it("cuts at code point offsets, so the marked part is the quote after emoji", () => {
    expect(body.indexOf(quote)).not.toBe(start); // UTF-16 would be off by the emoji
    expect(splitAtCodePoints(body, start, end)).toEqual({
      before: "합성 🙂📅 자료: ",
      marked: quote,
      after: ". 끝 🚧",
    });
  });

  it("keeps a surrogate pair whole at the edges", () => {
    expect(splitAtCodePoints("🙂가🚧", 1, 2)).toEqual({ before: "🙂", marked: "가", after: "🚧" });
    expect(splitAtCodePoints("🙂가🚧", 2, 3)).toEqual({ before: "🙂가", marked: "🚧", after: "" });
  });

  it.each([
    [-1, 2],
    [2, 1],
    [0, 4],
    [1.5, 2],
  ])("refuses the span [%d, %d) it cannot show", (s, e) => {
    expect(splitAtCodePoints("🙂가🚧", s, e)).toBeUndefined();
  });

  it("marks an empty span as nothing", () => {
    expect(splitAtCodePoints("가나", 1, 1)).toEqual({ before: "가", marked: "", after: "나" });
  });
});

describe("Insight labels", () => {
  it("labels the only epistemic type an Insight has as an inference, not a fact", () => {
    expect(INSIGHT_EPISTEMIC.inferred).toBe("추론");
    expect(INSIGHT_NOT_CONFIRMED).toContain("확정 사실이 아닙니다");
    expect(Object.values(INSIGHT_EPISTEMIC).join()).not.toContain("확정");
  });
});

describe("evidenceVersionText", () => {
  it.each([
    [{ version: 1, latestVersion: 1 }, "version 1"],
    [{ version: 1, latestVersion: 3 }, "version 1 · 지난 version(최신 3)"],
  ])("%o → %s", (v, text) => {
    expect(evidenceVersionText(v)).toBe(text);
  });
});

// I02B-R39, C28: the seven locator shapes read as fixed Korean words (counted from 1 for the reader).
describe("locatorText", () => {
  const cases: [NativeLocator, string][] = [
    [{ format: "pdf", page: 3 }, "3쪽"],
    [{ format: "docx", paragraph: 4 }, "문단 5"],
    [
      { format: "docx", paragraph: 4, comment: { thread: 1, index: 0, part: "head" } },
      "문단 5 · 메모 2의 1번째 글(머리)",
    ],
    [{ format: "docx", paragraph: 0, table: { index: 0, row: 1, cell: 2 } }, "표 1의 2행 3열"],
    [{ format: "xlsx", sheet: "집계", cell: "B3" }, "시트 '집계' B3 칸"],
    [{ format: "xlsx", sheet: "집계", row: 4 }, "시트 '집계' 4행"],
    [{ format: "csv", record: 2, line: 3, field: 1 }, "레코드 2 · 3번째 줄 · 필드 1"],
    [{ format: "html", path: "body>p", line: 8 }, "8번째 줄 (body>p)"],
    [{ format: "markdown", line: 12, node: "paragraph" }, "12번째 줄"],
    [{ format: "txt", line: 5 }, "5번째 줄"],
    [{ format: "json", line: 6 }, "6번째 줄"],
  ];
  it.each(cases)("%j reads %s", (locator, text) => {
    expect(locatorText(locator)).toBe(text);
  });
});
