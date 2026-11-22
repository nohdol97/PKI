// V02-R15: imported text is untrusted data. The source view draws it as text nodes
// only, so markup in it (the malicious fixture's <script> and remote <img>) never
// becomes an element; the badge says it is untrusted. V02-R14: the span is marked.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiError } from "./api.ts";
import {
  EvidenceEntry,
  evidenceReducer,
  InsightSummary,
  SourceView,
  type EvidenceState,
} from "./evidence-view.tsx";
import { INSIGHT_GONE, SOURCE_GONE, UNTRUSTED_BADGE } from "./evidence-text.ts";

const malicious = readFileSync(
  resolve(import.meta.dirname, "../../../fixtures/v02-malicious.jsonl"),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as { title: string; content: string });

describe("SourceView", () => {
  it.each(malicious.map((r) => [r.title, r] as const))(
    "draws %s as text, never as elements",
    (_, record) => {
      const quote = "악성 변형";
      expect(record.content).toContain(quote);
      const start = Array.from(record.content.slice(0, record.content.indexOf(quote))).length;
      const end = start + Array.from(quote).length;
      const html = renderToStaticMarkup(
        <SourceView
          source={{
            evidenceId: 1,
            quote,
            start,
            end,
            locator: null,
            sourceVersion: {
              id: 1,
              version: 1,
              latestVersion: 1,
              title: record.title,
              body: record.content,
            },
          }}
        />,
      );
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/<img/i);
      expect(html).not.toMatch(/\son\w+=/i);
      expect(html).toContain("&lt;script&gt;");
      expect(html).toContain(UNTRUSTED_BADGE);
      expect(html).toContain(`<mark>${quote}</mark>`);
    },
  );

  it("marks the code point span after emoji, and only it", () => {
    const body = "합성 🙂 📅 미리내 프로젝트의 완료 목표는 2026-12-05입니다. <b>굵게</b>";
    const quote = "미리내 프로젝트의 완료 목표는 2026-12-05입니다";
    const start = Array.from(body).indexOf("미");
    const html = renderToStaticMarkup(
      <SourceView
        source={{
          evidenceId: 7,
          quote,
          start,
          end: start + Array.from(quote).length,
          locator: null,
          sourceVersion: { id: 3, version: 2, latestVersion: 2, title: "제목", body },
        }}
      />,
    );
    expect([...html.matchAll(/<mark>(.*?)<\/mark>/g)].map((m) => m[1])).toEqual([quote]);
    expect(html).toContain("&lt;b&gt;굵게&lt;/b&gt;");
    expect(html).toContain("version 2");
  });

  it("shows the body unmarked with an alert when the span cannot be shown", () => {
    const html = renderToStaticMarkup(
      <SourceView
        source={{
          evidenceId: 7,
          quote: "x",
          start: 5,
          end: 99,
          locator: null,
          sourceVersion: { id: 3, version: 1, latestVersion: 1, title: "제목", body: "짧은 본문" },
        }}
      />,
    );
    expect(html).not.toContain("<mark>");
    expect(html).toContain("짧은 본문");
    expect(html).toMatch(/role="alert"[^>]*>위치를 표시할 수 없습니다/);
  });
});

describe("InsightSummary", () => {
  it("labels the Insight as an inference and never as confirmed", () => {
    const html = renderToStaticMarkup(
      <InsightSummary
        insight={{
          id: 1,
          epistemic: "inferred",
          summary: "<img src=x>위험(추론)",
          evidenceCount: 3,
        }}
      />,
    );
    expect(html).toContain(">추론<");
    expect(html).toContain("확정 사실이 아닙니다");
    expect(html).not.toMatch(/>확정</);
    expect(html).not.toMatch(/<img/);
  });
});

const source = (version: number, latestVersion: number) => ({
  evidenceId: 7,
  quote: "가",
  start: 0,
  end: 1,
  locator: null,
  sourceVersion: { id: 3, version, latestVersion, title: "\u202e제목", body: "가나" },
});

describe("SourceView labels", () => {
  it("says when the evidence points to a past version, naming the latest", () => {
    expect(renderToStaticMarkup(<SourceView source={source(1, 3)} />)).toContain(
      "<p>version 1 · 지난 version(최신 3)</p>",
    );
    expect(renderToStaticMarkup(<SourceView source={source(2, 2)} />)).toContain(
      "<p>version 2</p>",
    );
  });

  it("isolates the imported title's direction; the quote is marked with no extra text", () => {
    const html = renderToStaticMarkup(<SourceView source={source(1, 1)} />);
    expect(html).toContain("<h4><bdi>\u202e제목</bdi></h4>");
    // the screen-reader words are CSS generated content, outside the copyable text
    expect(html).toContain('<pre class="source-text"><mark>가</mark>나</pre>');
  });
});

describe("bidi isolation of imported text", () => {
  const RLO = "\u202e";
  it("wraps the Insight summary in <bdi>", () => {
    const html = renderToStaticMarkup(
      <InsightSummary
        insight={{ id: 1, epistemic: "inferred", summary: `${RLO}위험(추론)`, evidenceCount: 3 }}
      />,
    );
    expect(html).toContain(`<strong>추론</strong> <bdi>${RLO}위험(추론)</bdi>`);
  });

  it("wraps the evidence list's source title in <bdi>, before the product's label", () => {
    const html = renderToStaticMarkup(
      <EvidenceEntry
        evidence={{
          id: 7,
          target: "fact",
          status: "candidate",
          quote: "가",
          sourceTitle: `${RLO}제목`,
          sourceVersionId: 3,
          version: 2,
          current: true,
          locator: null,
        }}
        onOpen={() => undefined}
      />,
    );
    expect(html).toContain(`<p><bdi>${RLO}제목</bdi> · version 2</p>`);
  });
});

describe("evidenceReducer", () => {
  const entry = (id: number) => ({
    id,
    target: "fact" as const,
    status: "candidate" as const,
    quote: `인용 ${id}`,
    sourceTitle: `제목 ${id}`,
    sourceVersionId: 3,
    version: 1,
    current: true,
    locator: null,
  });
  const evidence = [entry(7), entry(8)];
  const insight = (id: number) => ({
    id,
    epistemic: "inferred" as const,
    summary: `위험 ${id}(추론)`,
    evidenceCount: 2,
  });
  const open: EvidenceState = {
    insights: [insight(1), insight(2)],
    opened: { insightId: 1, evidence },
    source: source(1, 1),
    opens: 2,
  };
  const notFound = new ApiError("not-found", 404);

  it("drops the shown source and that evidence entry on 404, in plain words", () => {
    const next = evidenceReducer(open, { type: "failed", what: "source", id: 7, error: notFound });
    expect(next.source).toBeUndefined();
    expect(next.opened).toEqual({ insightId: 1, evidence: [entry(8)] });
    expect(next.insights).toEqual(open.insights);
    expect(next.notice).toBe(SOURCE_GONE);
    expect(next.notice).not.toMatch(/404|not-found/);
  });

  it("drops the Insight from the list, with its evidence and source, when it is gone", () => {
    const next = evidenceReducer(open, { type: "failed", what: "insight", id: 1, error: notFound });
    expect(next).toEqual({ insights: [insight(2)], opens: 2, notice: INSIGHT_GONE });
  });

  it("keeps what is shown on another failure", () => {
    const next = evidenceReducer(open, {
      type: "failed",
      what: "source",
      id: 7,
      error: new ApiError("internal-error", 500),
    });
    expect(next.source).toEqual(open.source);
    expect(next.opened).toEqual(open.opened);
    expect(next.notice).toContain("불러오지 못했습니다");
  });

  it("counts every open, the same one again included, and clears the notice", () => {
    const failed = { ...open, notice: SOURCE_GONE };
    const again = evidenceReducer(failed, { type: "source-opened", source: source(1, 1) });
    expect(again.opens).toBe(3);
    expect(again.notice).toBeUndefined();
    expect(again.opened).toEqual(open.opened);
    const reopened = evidenceReducer(again, { type: "insight-opened", insightId: 1, evidence });
    expect(reopened).toEqual({
      insights: open.insights,
      opened: { insightId: 1, evidence },
      opens: 4,
    });
  });

  it("keeps the loaded list", () => {
    expect(
      evidenceReducer({ opens: 0 }, { type: "insights-loaded", insights: [insight(1)] }),
    ).toEqual({ insights: [insight(1)], opens: 0 });
  });
});
