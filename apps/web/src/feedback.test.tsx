// P5F-R6: the correction buttons on an evidence row. A fact offers "잘못된 정보" and "확인 완료", a relation
// "잘못된 관계" and "확인 완료"; the labels name the row's quote, which reaches the page as text only.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ApiClient } from "./api.ts";
import { InsightFeedback, RowFeedback } from "./feedback.tsx";

const api = (() => Promise.reject(new Error("not called"))) as unknown as ApiClient;
const names = (html: string) =>
  [...html.matchAll(/<button[^>]*aria-label="([^"]*)"/g)].map((m) => m[1]);

describe("RowFeedback", () => {
  it("offers the corrections the table allows on the row's target and nothing else", () => {
    const fact = renderToStaticMarkup(
      <RowFeedback api={api} target={{ kind: "fact", id: 4 }} label="인용 4" onChange={() => {}} />,
    );
    expect(names(fact)).toEqual(["확인 완료: 인용 4", "잘못된 정보: 인용 4"]);
    const relation = renderToStaticMarkup(
      <RowFeedback
        api={api}
        target={{ kind: "relation", id: 5 }}
        label="인용 5"
        onChange={() => {}}
      />,
    );
    expect(names(relation)).toEqual(["확인 완료: 인용 5", "잘못된 관계: 인용 5"]);
  });
});

// UI01 (R6): the Insight's feedback is split over the detail pane: "확인 완료" is the head bar's action (the
// mockup's "검토 완료" slot), the other kinds are the action bar, the first of them (유용함) the main one.
describe("InsightFeedback", () => {
  const record = { notice: undefined, press: () => Promise.resolve() };
  const insight = { id: 1, summary: "요약" };

  it("offers only 확인 완료 in the head, with its name unchanged", () => {
    const head = renderToStaticMarkup(
      <InsightFeedback insight={insight} record={record} part="head" />,
    );
    expect(names(head)).toEqual(["확인 완료: 요약"]);
    expect(head).not.toContain('role="group"');
  });

  it("offers the other kinds in a named group, 유용함 first and filled", () => {
    const bar = renderToStaticMarkup(
      <InsightFeedback insight={insight} record={record} part="bar" />,
    );
    expect(names(bar)).toEqual([
      "유용함: 요약",
      "중요함: 요약",
      "관련 없음: 요약",
      "이미 알고 있음: 요약",
      "다시 알리지 않기: 요약",
    ]);
    expect(bar).toContain('role="group" aria-label="피드백: 요약"');
    expect(bar).toMatch(
      /class="btn-primary"[^>]*aria-label="유용함: 요약"|aria-label="유용함: 요약"[^>]*class="btn-primary"/,
    );
  });
});
