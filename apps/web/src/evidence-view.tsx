// Home's Insight section (V02-R14, R15; spec "T10이 넘기는 것" 3): the active
// Insights labelled as inferences, an Insight's evidence, and the source version
// an evidence row points to with its span marked. Imported text is untrusted data:
// it reaches the page only as React text nodes, never as markup.
import type { EvidenceSource, EvidenceSummary, InsightSummary as InsightRow } from "@pki/contracts";
import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "./api.ts";
import {
  evidenceVersionText,
  INSIGHT_EPISTEMIC,
  INSIGHT_NOT_CONFIRMED,
  SPAN_UNAVAILABLE,
  splitAtCodePoints,
  SUPERSEDED_BADGE,
  UNTRUSTED_BADGE,
} from "./evidence-text.ts";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function InsightSummary({ insight }: { insight: InsightRow }) {
  return (
    <>
      <p>
        <strong>{INSIGHT_EPISTEMIC[insight.epistemic]}</strong> {insight.summary}
      </p>
      <p>{INSIGHT_NOT_CONFIRMED}</p>
    </>
  );
}

export function SourceView({ source }: { source: EvidenceSource }) {
  const { sourceVersion: v } = source;
  const parts = splitAtCodePoints(v.body, source.start, source.end);
  return (
    <>
      <p>
        <strong>{UNTRUSTED_BADGE}</strong>
      </p>
      <h4>{v.title}</h4>
      <p>{evidenceVersionText(v)}</p>
      {parts === undefined && <p role="alert">{SPAN_UNAVAILABLE}</p>}
      <pre>
        {parts === undefined ? (
          v.body
        ) : (
          <>
            {parts.before}
            <mark>{parts.marked}</mark>
            {parts.after}
          </>
        )}
      </pre>
    </>
  );
}

/** Moves keyboard focus to the heading of a section that just opened. */
function useFocusOnChange(key: unknown) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (key !== undefined) ref.current?.focus();
  }, [key]);
  return ref;
}

export function Insights({ api }: { api: ApiClient }) {
  const [insights, setInsights] = useState<InsightRow[]>();
  const [opened, setOpened] = useState<{ insightId: number; evidence: EvidenceSummary[] }>();
  const [source, setSource] = useState<EvidenceSource>();
  const [error, setError] = useState<string>();
  const fail = (e: unknown) => setError(message(e));
  const evidenceHeading = useFocusOnChange(opened?.insightId);
  const sourceHeading = useFocusOnChange(source?.evidenceId);

  useEffect(() => {
    api("insights").then((r) => setInsights(r.insights), fail);
  }, [api]);

  const openInsight = (insightId: number) =>
    api("insightEvidence", { insightId }).then((r) => {
      setSource(undefined);
      setOpened({ insightId, evidence: r.evidence });
    }, fail);
  const openSource = (evidenceId: number) =>
    api("evidenceSource", { evidenceId }).then(setSource, fail);

  return (
    <section aria-labelledby="insights-heading">
      <h2 id="insights-heading">Insight</h2>
      {error && <p role="alert">불러오지 못했습니다: {error}</p>}
      {insights?.length === 0 && <p>보여 줄 Insight가 없습니다.</p>}
      {insights && insights.length > 0 && (
        <ul aria-label="Insight 목록">
          {insights.map((insight) => (
            <li key={insight.id}>
              <InsightSummary insight={insight} />
              <button type="button" onClick={() => openInsight(insight.id)}>
                근거 보기 ({insight.evidenceCount})
              </button>
            </li>
          ))}
        </ul>
      )}
      {opened && (
        <section aria-labelledby="evidence-heading">
          <h3 id="evidence-heading" tabIndex={-1} ref={evidenceHeading}>
            근거
          </h3>
          <ol aria-label="근거 목록">
            {opened.evidence.map((e) => (
              <li key={e.id}>
                <p>
                  {e.sourceTitle} · version {e.version}
                  {!e.current && " · 지난 version"}
                  {e.status === "superseded" && <strong> {SUPERSEDED_BADGE}</strong>}
                </p>
                <blockquote>{e.quote}</blockquote>
                <button
                  type="button"
                  aria-label={`원본 보기: ${e.sourceTitle}`}
                  onClick={() => openSource(e.id)}
                >
                  원본 보기
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}
      {source && (
        <section aria-labelledby="source-heading">
          <h3 id="source-heading" tabIndex={-1} ref={sourceHeading}>
            원본 보기
          </h3>
          <SourceView source={source} />
        </section>
      )}
    </section>
  );
}
