// V02-R15: imported text is untrusted data. The source view draws it as text nodes
// only, so markup in it (the malicious fixture's <script> and remote <img>) never
// becomes an element; the badge says it is untrusted. V02-R14: the span is marked.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InsightSummary, SourceView } from "./evidence-view.tsx";
import { UNTRUSTED_BADGE } from "./evidence-text.ts";

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
