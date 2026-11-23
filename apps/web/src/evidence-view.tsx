// Home's Insight section (V02-R14, R15; spec "T10이 넘기는 것" 3, 7): the active
// Insights labelled as inferences, an Insight's evidence, and the source version
// an evidence row points to with its span marked. Imported text is untrusted data:
// it reaches the page only as React text nodes, never as markup, and inside <bdi>
// so its direction marks cannot reorder the product's own labels around it.
import {
  insightType,
  type EvidenceSource,
  type EvidenceSummary,
  type InsightSummary as InsightRow,
  type InsightTypeListResponse,
  type LocalSourceInfo,
  type SourceThreadResponse,
} from "@pki/contracts";
import { useEffect, useReducer, useRef, useState } from "react";
import { ApiError, type ApiClient } from "./api.ts";
import { InsightFeedback, RecentFeedback } from "./feedback.tsx";
import {
  AUTO_NOTIFY_EXCLUDED,
  evidenceVersionText,
  INSIGHT_EPISTEMIC,
  INSIGHT_GONE,
  INSIGHT_NOT_CONFIRMED,
  LOCAL_NOT_FOUND_TEXT,
  LOCAL_PAUSED_TEXT,
  attachmentDetailText,
  locatorText,
  rankingText,
  REASONING_BY,
  REVEAL_FAILED_TEXT,
  SOURCE_GONE,
  SPAN_UNAVAILABLE,
  splitAtCodePoints,
  typeStatusText,
  UNTRUSTED_BADGE,
} from "./evidence-text.ts";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function InsightSummary({ insight }: { insight: InsightRow }) {
  return (
    <>
      <p>{insightType(insight.type)?.label ?? insight.type}</p>
      <p>
        <strong>{INSIGHT_EPISTEMIC[insight.epistemic]}</strong> <bdi>{insight.summary}</bdi>
      </p>
      <p>{INSIGHT_NOT_CONFIRMED}</p>
      {insight.factLines.length > 0 && (
        <ul aria-label="사실 줄">
          {insight.factLines.map((line, i) => (
            <li key={i}>
              <bdi>{line}</bdi>
            </li>
          ))}
        </ul>
      )}
      {insight.reasoningSummary !== null && insight.reasoningBy !== null && (
        <p>
          {REASONING_BY[insight.reasoningBy]}: <bdi>{insight.reasoningSummary}</bdi>
        </p>
      )}
      <p>{rankingText(insight.ranking)}</p>
      {insight.autoNotifyExcluded && <p>{AUTO_NOTIFY_EXCLUDED}</p>}
    </>
  );
}

/** The part of the Electron preload's `window.pki` this view uses; absent in the browser (the path is only text there). */
export interface RevealBridge {
  revealSource?(sourceVersionId: number): Promise<{ revealed: boolean }>;
}

export function SourceView({
  source,
  local,
  onReveal,
  revealFailed,
}: {
  source: EvidenceSource;
  /** Where a local file is now (I02B-R39); undefined while unknown or for another kind of source. */
  local?: LocalSourceInfo | undefined;
  /** Given only where the shell can show a folder; the button is not drawn without it. */
  onReveal?: (() => void) | undefined;
  revealFailed?: boolean | undefined;
}) {
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
      {source.attachment && (
        <p>
          첨부: <bdi>{source.attachment.name}</bdi> ({attachmentDetailText(source.attachment)})
        </p>
      )}
      {source.locator && <p>위치: {locatorText(source.locator)}</p>}
      {local?.local && (
        <>
          <p>
            지금 위치: <bdi>{local.relativePath}</bdi>
          </p>
          {local.notFound && <p role="alert">{LOCAL_NOT_FOUND_TEXT}</p>}
          {local.state === "paused" && <p>{LOCAL_PAUSED_TEXT}</p>}
          {!local.notFound && onReveal && (
            <button type="button" onClick={onReveal}>
              폴더에서 보기
            </button>
          )}
          {revealFailed && <p role="alert">{REVEAL_FAILED_TEXT}</p>}
        </>
      )}
      {parts === undefined && <p role="alert">{SPAN_UNAVAILABLE}</p>}
      <pre className="source-text">
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

/**
 * A source version read by its number, with the span an Ask citation marks in it (X02-R5). There is no evidence
 * row, so the locator and the attachment are the ones the read answered for the citation's start (X02B-R5), if any.
 */
export const citationSource = (
  sourceVersion: EvidenceSource["sourceVersion"],
  span: { quote: string; start: number; end: number },
  found: Pick<EvidenceSource, "locator" | "attachment"> = { locator: null, attachment: null },
): EvidenceSource => ({ evidenceId: 0, ...span, ...found, sourceVersion });

/** Another message of the source's thread, read by its version number like an Ask citation's source. */
export async function openThreadMessage(
  api: ApiClient,
  versionId: number,
): Promise<EvidenceSource> {
  const { sourceVersion } = await api("exploreSource", { versionId });
  return citationSource(sourceVersion, { quote: "", start: 0, end: 0 });
}

/** The "같은 스레드" list of the open source (I02B-R55). Titles and names are imported text: text nodes inside <bdi>. */
export function SameThread({
  thread,
  currentVersionId,
  onOpen,
}: {
  thread: SourceThreadResponse;
  currentVersionId: number;
  onOpen: (versionId: number) => void;
}) {
  if (thread.messages.length < 2) return null;
  return (
    <>
      <h4>같은 스레드</h4>
      <ol aria-label="같은 스레드">
        {thread.messages.map((m) => (
          <li key={m.versionId}>
            <bdi>{m.title}</bdi>
            {m.author !== undefined && (
              <>
                {" "}
                · <bdi>{m.author}</bdi>
              </>
            )}
            {m.createdAt !== undefined && <> · {m.createdAt}</>}{" "}
            {m.versionId === currentVersionId ? (
              <span>(보는 중)</span>
            ) : (
              <button type="button" onClick={() => onOpen(m.versionId)}>
                열기
              </button>
            )}
          </li>
        ))}
      </ol>
    </>
  );
}

/** One entry of an Insight's evidence list. */
export function EvidenceEntry({
  evidence: e,
  onOpen,
}: {
  evidence: EvidenceSummary;
  onOpen: () => void;
}) {
  return (
    <>
      <p>
        <bdi>{e.sourceTitle}</bdi> · version {e.version}
      </p>
      <blockquote>{e.quote}</blockquote>
      <button type="button" aria-label={`원본 보기: ${e.sourceTitle}`} onClick={onOpen}>
        원본 보기
      </button>
    </>
  );
}

/**
 * What Home's Insight section shows. `opens` counts successful opens, so
 * reopening the same Insight or evidence moves focus to its heading again.
 */
export interface EvidenceState {
  insights?: InsightRow[];
  opened?: { insightId: number; evidence: EvidenceSummary[] };
  source?: EvidenceSource;
  notice?: string;
  opens: number;
}

export type EvidenceAction =
  | { type: "insights-loaded"; insights: InsightRow[] }
  | { type: "insight-opened"; insightId: number; evidence: EvidenceSummary[] }
  | { type: "source-opened"; source: EvidenceSource }
  /** The open Insight's evidence read again on a change (P02-R16): the list is replaced without moving focus. */
  | { type: "evidence-refreshed"; insightId: number; evidence: EvidenceSummary[] }
  | { type: "failed"; what: "insight" | "source"; id: number; error: unknown };

const gone = (error: unknown) => error instanceof ApiError && error.status === 404;

/**
 * A 404 means the Insight was hidden or the evidence's rows were deleted (T08
 * purge): what was shown from it is dropped, not kept on screen — the Insight
 * from the list, or the evidence entry (its quote and title) and the open source —
 * and the user reads a plain sentence instead of the API code.
 */
export function evidenceReducer(state: EvidenceState, action: EvidenceAction): EvidenceState {
  const { opens } = state;
  const insights = state.insights && { insights: state.insights };
  const opened = state.opened && { opened: state.opened };
  switch (action.type) {
    case "insights-loaded":
      return { ...state, insights: action.insights };
    case "insight-opened":
      return {
        ...insights,
        opened: { insightId: action.insightId, evidence: action.evidence },
        opens: opens + 1,
      };
    case "source-opened":
      return { ...insights, ...opened, source: action.source, opens: opens + 1 };
    case "evidence-refreshed": {
      if (state.opened?.insightId !== action.insightId) return state;
      const { source, ...rest } = state;
      // an open source whose evidence is no longer in the list is gone with it
      const keeps = source !== undefined && action.evidence.some((e) => e.id === source.evidenceId);
      return {
        ...rest,
        opened: { insightId: action.insightId, evidence: action.evidence },
        ...(keeps && { source }),
        ...(source !== undefined && !keeps && { notice: SOURCE_GONE }),
      };
    }
    case "failed": {
      if (!gone(action.error)) {
        return { ...state, notice: `불러오지 못했습니다: ${message(action.error)}` };
      }
      const { id } = action;
      if (action.what === "insight") {
        const left = state.insights?.filter((i) => i.id !== id);
        return { ...(left && { insights: left }), opens, notice: INSIGHT_GONE };
      }
      const evidence = state.opened?.evidence.filter((e) => e.id !== id);
      return {
        ...insights,
        ...(state.opened && evidence && { opened: { ...state.opened, evidence } }),
        opens,
        notice: SOURCE_GONE,
      };
    }
  }
}

/** Moves keyboard focus to the heading of the section the latest open showed. */
export function useFocusOn(opens: number, shown: boolean) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (opens > 0 && shown) ref.current?.focus();
  }, [opens, shown]);
  return ref;
}

/**
 * The evidence list of the Insight that was opened and the source view of the evidence that was opened (V02-R14),
 * each with its heading that takes the focus on an open. Home's Insights and the 알림 screen show it alike.
 */
export function EvidencePanel({
  state,
  onOpenSource,
  local,
  revealFailed,
  onReveal,
  thread,
  onOpenMessage,
}: {
  state: EvidenceState;
  onOpenSource: (evidenceId: number) => void;
  local?: LocalSourceInfo | undefined;
  revealFailed?: boolean | undefined;
  onReveal?: (() => void) | undefined;
  /** The other messages of the open source's thread (I02B), where the screen reads them. */
  thread?: SourceThreadResponse | undefined;
  onOpenMessage?: ((versionId: number) => void) | undefined;
}) {
  const { opened, source } = state;
  const evidenceHeading = useFocusOn(state.opens, opened !== undefined && source === undefined);
  const sourceHeading = useFocusOn(state.opens, source !== undefined);
  return (
    <>
      {opened && (
        <section aria-labelledby="evidence-heading">
          <h3 id="evidence-heading" tabIndex={-1} ref={evidenceHeading}>
            근거
          </h3>
          {/* An active Insight's evidence is always current (T07 item 3), so no past marker here. */}
          <ol aria-label="근거 목록">
            {opened.evidence.map((e) => (
              <li key={e.id}>
                <EvidenceEntry evidence={e} onOpen={() => onOpenSource(e.id)} />
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
          <SourceView
            source={source}
            local={local}
            revealFailed={revealFailed}
            onReveal={onReveal}
          />
          {thread && onOpenMessage && (
            <SameThread
              thread={thread}
              currentVersionId={source.sourceVersion.id}
              onOpen={onOpenMessage}
            />
          )}
        </section>
      )}
    </>
  );
}

export function Insights({
  api,
  bridge = (globalThis as { pki?: RevealBridge }).pki,
  refresh,
}: {
  api: ApiClient;
  bridge?: RevealBridge | undefined;
  /** Changes when the backend's data changed (`useChanges`, P02-R16): the list and the open evidence are read again. */
  refresh?: string | undefined;
}) {
  const [loadError, setLoadError] = useState<string>();
  const [types, setTypes] = useState<InsightTypeListResponse["types"]>();
  const [local, setLocal] = useState<LocalSourceInfo>();
  const [revealFailed, setRevealFailed] = useState(false);
  const [thread, setThread] = useState<SourceThreadResponse>();
  const [state, dispatch] = useReducer(evidenceReducer, { opens: 0 });
  const [feedbackVersion, setFeedbackVersion] = useState(0);
  const feedbackChanged = () => setFeedbackVersion((n) => n + 1);
  const { insights, opened, source, notice } = state;
  const openedId = opened?.insightId;

  useEffect(() => {
    api("insights").then(
      (r) => dispatch({ type: "insights-loaded", insights: r.insights }),
      (e: unknown) => setLoadError(message(e)),
    );
  }, [api, feedbackVersion, refresh]);
  // P02-R16: a change somewhere reads the open evidence again; an Insight or a source that is gone shows its plain sentence
  useEffect(() => {
    if (openedId === undefined) return;
    api("insightEvidence", { insightId: openedId }).then(
      (r) => dispatch({ type: "evidence-refreshed", insightId: openedId, evidence: r.evidence }),
      (error: unknown) => dispatch({ type: "failed", what: "insight", id: openedId, error }),
    );
    // only a change reads again: opening an Insight has just read it
  }, [api, refresh]);
  // a failed read only leaves the type list out: the Insight list does not depend on it
  useEffect(() => {
    api("insightTypes").then(
      (r) => setTypes(r.types),
      () => undefined,
    );
  }, [api]);

  const openInsight = (insightId: number) =>
    api("insightEvidence", { insightId }).then(
      (r) => dispatch({ type: "insight-opened", insightId, evidence: r.evidence }),
      (error: unknown) => dispatch({ type: "failed", what: "insight", id: insightId, error }),
    );
  const showThread = (versionId: number) => {
    setThread(undefined);
    // a failure or a source without a thread only leaves the list out
    api("sourceThread", { versionId }).then(setThread, () => undefined);
  };
  const openMessage = (versionId: number) =>
    openThreadMessage(api, versionId).then(
      (s) => {
        setLocal(undefined);
        dispatch({ type: "source-opened", source: s });
        showThread(versionId);
      },
      (error: unknown) =>
        // id 0 names no evidence entry, so only the notice changes
        dispatch({ type: "failed", what: "source", id: 0, error }),
    );
  const openSource = (evidenceId: number) =>
    api("evidenceSource", { evidenceId }).then(
      (s) => {
        setLocal(undefined);
        setRevealFailed(false);
        dispatch({ type: "source-opened", source: s });
        showThread(s.sourceVersion.id);
        // where the file is now: a failure only leaves this line out, the stored text is shown anyway
        api("localSourceInfo", { sourceVersionId: s.sourceVersion.id }).then(
          setLocal,
          () => undefined,
        );
      },
      (error: unknown) => dispatch({ type: "failed", what: "source", id: evidenceId, error }),
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
              <InsightFeedback api={api} insight={insight} onChange={feedbackChanged} />
            </li>
          ))}
        </ul>
      )}
      <RecentFeedback api={api} version={feedbackVersion} onChange={feedbackChanged} />
      {types && (
        <details>
          <summary>Insight 유형 지원 상태</summary>
          <ul aria-label="Insight 유형">
            {types.map((t) => (
              <li key={t.type}>
                {t.label} — {typeStatusText(t)}
              </li>
            ))}
          </ul>
        </details>
      )}
      {notice && <p role="alert">{notice}</p>}
      <EvidencePanel
        state={state}
        onOpenSource={openSource}
        local={local}
        revealFailed={revealFailed}
        onReveal={
          bridge?.revealSource && source
            ? () =>
                void bridge.revealSource?.(source.sourceVersion.id).then(
                  (r) => setRevealFailed(!r.revealed),
                  () => setRevealFailed(true),
                )
            : undefined
        }
        thread={thread}
        onOpenMessage={(id) => void openMessage(id)}
      />
    </section>
  );
}
