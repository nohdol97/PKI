// P03-R15: the buttons an Insight gets are the table's six kinds with their screen names, and a refusal code is
// worded (a code the file does not know is shown as itself).
import { INSIGHT_FEEDBACK_KINDS } from "@pki/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InsightFeedback } from "./feedback.tsx";
import { feedbackLabel, feedbackRefusalText } from "./feedback-text.ts";

describe("feedback text", () => {
  it("offers the six Insight kinds by their screen names, the Insight's text only as text", () => {
    expect(INSIGHT_FEEDBACK_KINDS.map(feedbackLabel)).toEqual([
      "유용함",
      "중요함",
      "관련 없음",
      "이미 알고 있음",
      "다시 알리지 않기",
      "확인 완료",
    ]);
    const record = { notice: undefined, press: () => Promise.resolve() };
    const insight = { id: 1, summary: '<img src="https://tracker.example.test/x">' };
    // the six kinds are split over the detail pane: 확인 완료 in the head bar, the other five in the action bar
    const html = (["head", "bar"] as const)
      .map((part) =>
        renderToStaticMarkup(createElement(InsightFeedback, { insight, record, part })),
      )
      .join("");
    expect(html).not.toContain("<img");
    expect((html.match(/<button/g) ?? []).length).toBe(6);
  });

  it("words a refusal code and shows an unknown one as itself", () => {
    expect(feedbackRefusalText("not-latest")).toContain("다른 조치");
    expect(feedbackRefusalText("brand-new-code")).toContain("brand-new-code");
  });
});
