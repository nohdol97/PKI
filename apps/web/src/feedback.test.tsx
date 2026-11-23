// P5F-R6: the correction buttons on an evidence row. A fact offers "잘못된 정보" and "확인 완료", a relation
// "잘못된 관계" and "확인 완료"; the labels name the row's quote, which reaches the page as text only.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ApiClient } from "./api.ts";
import { RowFeedback } from "./feedback.tsx";

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
