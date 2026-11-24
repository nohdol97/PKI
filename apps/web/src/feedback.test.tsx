// P5F-R6: the correction buttons on an evidence row. A fact offers "잘못된 정보" and "확인 완료", a relation
// "잘못된 관계" and "확인 완료"; the labels name the row's quote, which reaches the page as text only.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "./api.ts";
import type { FeedbackLine } from "@pki/contracts";
import {
  createFeedbackCalls,
  InsightFeedback,
  ItemFeedback,
  itemPreferenceLines,
  RowFeedback,
  scopedNotice,
} from "./feedback.tsx";

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

// UI01 review A1: a refusal or failure belongs to the Insight it was made for; it never shows under another one.
describe("scopedNotice", () => {
  it("shows a held notice only for its own Insight", () => {
    const held = { id: 1, text: "거절" };
    expect(scopedNotice(held, 1)).toBe("거절");
    expect(scopedNotice(held, 2)).toBeUndefined();
    expect(scopedNotice(undefined, 1)).toBeUndefined();
  });
});

// CUF-C3 (R2): the preference buttons of an item in 탐색 and the lines it keeps.
describe("ItemFeedback (CUF-C3)", () => {
  it("draws the four preference kinds the table allows on an item, named by the item", () => {
    const html = renderToStaticMarkup(
      <ItemFeedback api={api} item={{ id: 7, name: "미리내 프로젝트" }} memberIds={[]} />,
    );
    expect(names(html)).toEqual([
      "유용함: 미리내 프로젝트",
      "중요함: 미리내 프로젝트",
      "관련 없음: 미리내 프로젝트",
      "다시 알리지 않기: 미리내 프로젝트",
    ]);
    expect(html).toContain('role="group" aria-label="선호: 미리내 프로젝트"');
  });

  it("keeps only the preference lines of the item and its members", () => {
    const line = (
      id: number,
      kind: FeedbackLine["kind"],
      cls: FeedbackLine["class"],
      tid: number,
      tk: FeedbackLine["target"]["kind"] = "item",
    ): FeedbackLine => ({
      id,
      kind,
      class: cls,
      target: { kind: tk, id: tid },
      label: `대상 ${tid}`,
      at: "2026-11-24T00:00:00Z",
    });
    const lines = [
      line(1, "useful", "preference", 7),
      line(2, "mute", "preference", 8),
      line(3, "important", "preference", 9),
      line(4, "confirmed", "correction", 7),
      line(5, "useful", "preference", 7, "insight"),
    ];
    expect(itemPreferenceLines(lines, new Set([7, 8])).map((l) => l.id)).toEqual([1, 2]);
  });
});

describe("createFeedbackCalls (UIF2-C4)", () => {
  it("sends one call at a time across record and undo, and sends again after the answer", async () => {
    let release: (v: unknown) => void = () => {};
    const call = vi.fn(() => new Promise((resolve) => (release = resolve)));
    const calls = createFeedbackCalls(call as unknown as ApiClient);
    const first = calls.record({ kind: "item", id: 1 }, "useful");
    expect(calls.record({ kind: "item", id: 1 }, "useful")).toBeUndefined();
    expect(calls.undo(7)).toBeUndefined();
    expect(call).toHaveBeenCalledTimes(1);
    release({ status: "recorded" });
    expect((await first)?.changed).toBe(true);
    const later = calls.undo(7);
    expect(later).toBeDefined();
    release({ status: "undone" });
    await later;
    expect(call).toHaveBeenCalledTimes(2);
  });
});
