// V02-R15: imported text is untrusted data. The source view draws it as text nodes
// only, so markup in it (the malicious fixture's <script> and remote <img>) never
// becomes an element; the badge says it is untrusted. V02-R14: the span is marked.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type ApiClient } from "./api.ts";
import {
  citationSource,
  EvidenceEntry,
  evidenceReducer,
  InsightSummary,
  openThreadMessage,
  SameThread,
  SourceView,
  type EvidenceState,
} from "./evidence-view.tsx";
import {
  AUTO_NOTIFY_EXCLUDED,
  INSIGHT_GONE,
  rankingText,
  REASONING_BY,
  SOURCE_GONE,
  UNTRUSTED_BADGE,
} from "./evidence-text.ts";
import type { InsightSummary as InsightRow } from "@pki/contracts";

/** An Insight row as the API now gives it (P01-R13); a test overrides what it reads. */
const row = (over: Partial<InsightRow> = {}): InsightRow => ({
  id: 1,
  epistemic: "inferred",
  summary: "위험(추론)",
  evidenceCount: 3,
  type: "dependency_delay",
  factLines: [],
  reasoningSummary: null,
  reasoningBy: null,
  confidence: null,
  ranking: {
    relevance: 50,
    impact: 80,
    urgency: 100,
    novelty: 100,
    confidence: 50,
    actionability: 70,
    score: 72,
  },
  autoNotifyExcluded: false,
  ...over,
});

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
            attachment: null,
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
          attachment: null,
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
          attachment: null,
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
      <InsightSummary insight={row({ summary: "<img src=x>위험(추론)" })} />,
    );
    expect(html).toContain(">추론<");
    expect(html).toContain("확정 사실이 아닙니다");
    expect(html).not.toMatch(/>확정</);
    expect(html).not.toMatch(/<img/);
  });

  it("shows the type, fact lines in <bdi>, who wrote the reason, the ranking and the notification mark (P01-C2d)", () => {
    const insight = row({
      factLines: ["X 목표일: 2026-12-05", "<b>Y</b> 완료일: 2026-12-10"],
      reasoningSummary: "해석 이유",
      reasoningBy: "llm",
      autoNotifyExcluded: true,
    });
    const html = renderToStaticMarkup(<InsightSummary insight={insight} />);
    expect(html).toContain("의존 업무 지연");
    expect(html).toContain("<li><bdi>X 목표일: 2026-12-05</bdi></li>");
    expect(html).toContain("<li><bdi>&lt;b&gt;Y&lt;/b&gt; 완료일: 2026-12-10</bdi></li>");
    expect(html).toContain(`${REASONING_BY.llm}: <bdi>해석 이유</bdi>`);
    expect(html).toContain(rankingText(insight.ranking));
    expect(html).toContain(AUTO_NOTIFY_EXCLUDED);
    const plain = renderToStaticMarkup(<InsightSummary insight={row()} />);
    expect(plain).not.toContain(AUTO_NOTIFY_EXCLUDED);
    expect(plain).not.toContain("사실 줄");
  });
});

const source = (version: number, latestVersion: number) => ({
  evidenceId: 7,
  quote: "가",
  start: 0,
  end: 1,
  locator: null,
  attachment: null,
  sourceVersion: { id: 3, version, latestVersion, title: "\u202e제목", body: "가나" },
});

// I02C-C5: the attachment of the evidence's block is drawn as text before the locator line, and not at all for null
describe("SourceView attachment line", () => {
  const withAttachment = (
    attachment: { name: string; mediaType: string; size: number } | null,
  ) => ({
    ...source(1, 1),
    locator: { format: "pdf", page: 3 } as const,
    attachment,
  });

  it("shows the attachment's name, type and size before the locator, escaped as text", () => {
    const html = renderToStaticMarkup(
      <SourceView
        source={withAttachment({
          name: "<b>plan</b>.pdf",
          mediaType: "application/pdf",
          size: 1024,
        })}
      />,
    );
    expect(html).toContain("첨부:");
    expect(html).toContain("&lt;b&gt;plan&lt;/b&gt;.pdf");
    expect(html).toContain("application/pdf");
    expect(html).toContain("1024바이트");
    expect(html).not.toContain("<b>plan");
    expect(html.indexOf("첨부:")).toBeLessThan(html.indexOf("위치:"));
  });

  it("draws no attachment line for null", () => {
    expect(renderToStaticMarkup(<SourceView source={withAttachment(null)} />)).not.toContain(
      "첨부:",
    );
  });
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
      <InsightSummary insight={row({ summary: `${RLO}위험(추론)` })} />,
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
  const insight = (id: number) => row({ id, summary: `위험 ${id}(추론)`, evidenceCount: 2 });
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

  // P02-R16: a change reads the open evidence again; the focus is not moved, and a source whose evidence left the list goes
  it("replaces the evidence list without counting an open, and drops an open source whose evidence is gone", () => {
    const shown: EvidenceState = { ...open, source: { ...source(1, 1), evidenceId: 7 } };
    const kept = evidenceReducer(shown, {
      type: "evidence-refreshed",
      insightId: 1,
      evidence: [entry(7)],
    });
    expect(kept).toEqual({ ...shown, opened: { insightId: 1, evidence: [entry(7)] } });
    const gone = evidenceReducer(shown, {
      type: "evidence-refreshed",
      insightId: 1,
      evidence: [entry(8)],
    });
    expect(gone.source).toBeUndefined();
    expect(gone.opens).toBe(shown.opens);
    expect(gone.notice).toBe(SOURCE_GONE);
  });
});

// I02B-R39, C28 (evidence half): a local source shows its place in the folder; when the file is gone the
// screen says so and still shows the stored quote; the reveal button only where the shell offers it.
describe("SourceView of a local file", () => {
  const source = {
    evidenceId: 1,
    quote: "등대",
    start: 3,
    end: 5,
    locator: { format: "pdf", page: 3 } as const,
    attachment: null,
    sourceVersion: { id: 9, version: 1, latestVersion: 1, title: "제목", body: "합성 등대 문장" },
  };
  const here = (over: object) => ({
    local: true,
    relativePath: "docs/a.md",
    state: "active" as const,
    notFound: false,
    ...over,
  });

  it("shows the locator words, the current place and the reveal button", () => {
    const html = renderToStaticMarkup(
      <SourceView source={source} local={here({})} onReveal={() => undefined} />,
    );
    expect(html).toContain("3쪽");
    expect(html).toContain("docs/a.md");
    expect(html).toContain(">폴더에서 보기</button>");
    expect(html).not.toContain("원본 파일을 찾을 수 없음");
  });

  it("an unavailable location shows 'not found' and the stored quote, and no reveal button", () => {
    const html = renderToStaticMarkup(
      <SourceView
        source={source}
        local={here({ state: "unavailable", notFound: true })}
        onReveal={() => undefined}
      />,
    );
    expect(html).toContain("원본 파일을 찾을 수 없음");
    expect(html).toContain("<mark>등대</mark>");
    expect(html).not.toContain("폴더에서 보기");
  });

  it("a source that is not a local file shows no place", () => {
    const html = renderToStaticMarkup(
      <SourceView
        source={source}
        local={{ local: false, relativePath: null, state: null, notFound: false }}
      />,
    );
    expect(html).not.toContain("지금 위치");
  });
});

describe("citationSource (X02-R5)", () => {
  it("marks the cited span of a version read by its number, as text", () => {
    const out = renderToStaticMarkup(
      <SourceView
        source={citationSource(
          { id: 4, version: 1, latestVersion: 1, title: "<b>제목</b>", body: "가나다라" },
          { quote: "나다", start: 1, end: 3 },
        )}
      />,
    );
    expect(out).toContain("<mark>나다</mark>");
    expect(out).toContain("&lt;b&gt;제목");
    expect(out).not.toContain("<b>");
  });

  it("carries no locator and no attachment, since a citation has no evidence row", () => {
    const source = citationSource(
      { id: 4, version: 1, latestVersion: 1, title: "제목", body: "가나다라" },
      { quote: "나다", start: 1, end: 3 },
    );
    expect(source.locator).toBeNull();
    expect(source.attachment).toBeNull();
  });
});

describe("same-thread list (I02B-C56)", () => {
  const thread = {
    messages: [
      { versionId: 4, title: "<script>alert(1)</script>", author: "김" },
      { versionId: 5, title: "답장", createdAt: "2026-11-10T09:00:00+09:00" },
    ],
    participants: ["김"],
  };

  it("draws each message as bdi text, never as elements, and marks the open one", () => {
    const html = renderToStaticMarkup(
      <SameThread thread={thread} currentVersionId={4} onOpen={() => undefined} />,
    );
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("<bdi>&lt;script&gt;alert(1)&lt;/script&gt;</bdi>");
    expect(html).toContain("<bdi>답장</bdi>");
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  it("opens another message by its version number", async () => {
    const api = vi.fn(async () => ({
      sourceVersion: { id: 5, version: 1, latestVersion: 1, title: "답장", body: "본문" },
    }));
    const opened = await openThreadMessage(api as unknown as ApiClient, 5);
    expect(api).toHaveBeenCalledWith("exploreSource", { versionId: 5 });
    expect(opened.sourceVersion.id).toBe(5);
  });
});
