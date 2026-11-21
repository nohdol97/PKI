// Home's Insight section (V02-R14, R15; spec "T10이 넘기는 것" 3, 7): the active
// Insights labelled as inferences, an Insight's evidence, and the source version
// an evidence row points to with its span marked. Imported text is untrusted data:
// it reaches the page only as React text nodes, never as markup, and inside <bdi>
// so its direction marks cannot reorder the product's own labels around it.
import type { EvidenceSource, EvidenceSummary, InsightSummary as InsightRow } from "@pki/contracts";
import { useEffect, useReducer, useRef, useState } from "react";
import { ApiError, type ApiClient } from "./api.ts";
import {
  evidenceVersionText,
  INSIGHT_EPISTEMIC,
  INSIGHT_GONE,
  INSIGHT_NOT_CONFIRMED,
  MARK_END,
  MARK_START,
  SOURCE_GONE,
  SPAN_UNAVAILABLE,
  splitAtCodePoints,
  UNTRUSTED_BADGE,
} from "./evidence-text.ts";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function InsightSummary({ insight }: { insight: InsightRow }) {
  return (
    <>
      <p>
        <strong>{INSIGHT_EPISTEMIC[insight.epistemic]}</strong> <bdi>{insight.summary}</bdi>
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
      <h4>
        <bdi>{v.title}</bdi>
      </h4>
      <p>{evidenceVersionText(v)}</p>
      {parts === undefined && <p role="alert">{SPAN_UNAVAILABLE}</p>}
      <pre className="source-text">
        {parts === undefined ? (
          v.body
        ) : (
          <>
            {parts.before}
            <span className="visually-hidden">{MARK_START}</span>
            <mark>{parts.marked}</mark>
            <span className="visually-hidden">{MARK_END}</span>
            {parts.after}
          </>
        )}
      </pre>
    </>
  );
}

/**
 * What the evidence part of Home shows. `opens` counts successful opens, so
 * reopening the same Insight or evidence moves focus to its heading again.
 */
export interface EvidenceState {
  opened?: { insightId: number; evidence: EvidenceSummary[] };
  source?: EvidenceSource;
  notice?: string;
  opens: number;
}

export type EvidenceAction =
  | { type: "insight-opened"; insightId: number; evidence: EvidenceSummary[] }
  | { type: "source-opened"; source: EvidenceSource }
  | { type: "failed"; what: "insight" | "source"; error: unknown };

const gone = (error: unknown) => error instanceof ApiError && error.status === 404;

/**
 * A 404 means the Insight was hidden or the evidence's rows were deleted (T08
 * purge): what was shown from it is dropped, not kept on screen, and the user
 * reads a plain sentence instead of the API code.
 */
export function evidenceReducer(state: EvidenceState, action: EvidenceAction): EvidenceState {
  switch (action.type) {
    case "insight-opened":
      return {
        opened: { insightId: action.insightId, evidence: action.evidence },
        opens: state.opens + 1,
      };
    case "source-opened":
      return {
        ...(state.opened && { opened: state.opened }),
        source: action.source,
        opens: state.opens + 1,
      };
    case "failed":
      if (!gone(action.error)) {
        return { ...state, notice: `불러오지 못했습니다: ${message(action.error)}` };
      }
      return action.what === "insight"
        ? { opens: state.opens, notice: INSIGHT_GONE }
        : {
            ...(state.opened && { opened: state.opened }),
            opens: state.opens,
            notice: SOURCE_GONE,
          };
  }
}

/** Moves keyboard focus to the heading of the section the latest open showed. */
function useFocusOn(opens: number, shown: boolean) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (opens > 0 && shown) ref.current?.focus();
  }, [opens, shown]);
  return ref;
}

export function Insights({ api }: { api: ApiClient }) {
  const [insights, setInsights] = useState<InsightRow[]>();
  const [loadError, setLoadError] = useState<string>();
  const [state, dispatch] = useReducer(evidenceReducer, { opens: 0 });
  const { opened, source, notice } = state;
  const evidenceHeading = useFocusOn(state.opens, opened !== undefined && source === undefined);
  const sourceHeading = useFocusOn(state.opens, source !== undefined);

  useEffect(() => {
    api("insights").then(
      (r) => setInsights(r.insights),
      (e: unknown) => setLoadError(message(e)),
    );
  }, [api]);

  const openInsight = (insightId: number) =>
    api("insightEvidence", { insightId }).then(
      (r) => dispatch({ type: "insight-opened", insightId, evidence: r.evidence }),
      (error: unknown) => dispatch({ type: "failed", what: "insight", error }),
    );
  const openSource = (evidenceId: number) =>
    api("evidenceSource", { evidenceId }).then(
      (s) => dispatch({ type: "source-opened", source: s }),
      (error: unknown) => dispatch({ type: "failed", what: "source", error }),
    );

  return (
    <section aria-labelledby="insights-heading">
      <h2 id="insights-heading">Insight</h2>
      {loadError && <p role="alert">불러오지 못했습니다: {loadError}</p>}
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
      {notice && <p role="alert">{notice}</p>}
      {opened && (
        <section aria-labelledby="evidence-heading">
          <h3 id="evidence-heading" tabIndex={-1} ref={evidenceHeading}>
            근거
          </h3>
          {/* An active Insight's evidence is always current (T07 item 3), so no past marker here. */}
          <ol aria-label="근거 목록">
            {opened.evidence.map((e) => (
              <li key={e.id}>
                <p>
                  <bdi>{e.sourceTitle}</bdi> · version {e.version}
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
