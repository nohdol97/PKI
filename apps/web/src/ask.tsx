// The 질문 screen (X01-R11): the user asks, and the answer arrives in steps as the backend streams it (the
// chosen route, the hits, then the confirmed sentences). The screen holds labels only; every value shown comes
// from the stream. Titles and quotes are imported text, so they reach the page as React text nodes inside <bdi>
// only (V02-R15). Nothing is stored here: the question and the answer live in this component until the user
// leaves the screen (X01-R15). Cancel closes the connection; what already arrived stays on screen.
import type { AskEvent, AskRequest, EvidenceSource, RouteResponse } from "@pki/contracts";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { connectionOf, type ApiClient } from "./api.ts";
import { readAskEvents } from "./ask-stream.ts";
import { createLatest } from "./latest.ts";
import { citationSource, SourceView } from "./evidence-view.tsx";
import { useNav, type Nav } from "./nav.tsx";
import { PaneHead } from "./panes.tsx";
import {
  answerText,
  ASK_ALL_CONNECTORS,
  ASK_CANCEL,
  ASK_CANCELLED,
  ASK_CONFLICT,
  ASK_CONNECTOR,
  ASK_FROM,
  ASK_INTRO,
  ASK_NO_HITS,
  ASK_NO_SENTENCES,
  ASK_QUESTION,
  ASK_SUBMIT,
  ASK_TO,
  ASK_UNVERIFIED_ACK,
  ASK_WAITING,
  ASK_WANT_ANSWER,
  droppedText,
  failureText,
  progressText,
  questionLimitText,
  sourceFailureText,
  routeStatusText,
  strategyText,
} from "./ask-text.ts";

type Of<T extends AskEvent["type"]> = Extract<AskEvent, { type: T }>;
type Citation = Of<"sentence">["citation"];
type Related = Of<"hits">["hits"][number]["related"][number];

/** What a related-knowledge entry opens: its item in 탐색, and its page in 위키 when it has one (X02-R5). */
export const relatedActions = (go: Nav["go"], related: Related) => ({
  openItem: () => go("explore", { itemId: related.itemId }),
  openWiki:
    related.wikiKey === null ? undefined : () => go("wiki", { wikiKey: related.wikiKey as string }),
});

/** The version a citation points to, as the source view takes it: read by its version number and the citation's start, the span marked, the attachment and position shown (X02B-R12). */
export async function openCitation(api: ApiClient, c: Citation): Promise<EvidenceSource> {
  const { sourceVersion, locator, attachment } = await api("exploreSource", {
    versionId: c.versionId,
    start: c.start,
  });
  return citationSource(sourceVersion, c, { locator, attachment });
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Opens the source a citation points to. `reset()` (a new question) drops a read still out, so an old source never
 * shows under a new answer (X02F-R7); a failed read is told as a source that could not be loaded.
 */
export function sourceOpener(
  api: ApiClient,
  show: (index: number, source: EvidenceSource) => void,
  fail: (text: string) => void,
) {
  const reads = createLatest();
  return {
    open(citation: Citation, index: number) {
      const current = reads.begin();
      openCitation(api, citation).then(
        (source) => current() && show(index, source),
        (error: unknown) => current() && fail(sourceFailureText(message(error))),
      );
    },
    reset() {
      reads.begin();
    },
  };
}

export interface AskState {
  route?: Of<"route">["route"];
  hits?: Of<"hits">;
  answer?: Of<"answer">;
  sentences: Of<"sentence">[];
  done?: Of<"done">;
}
export const INITIAL_ASK: AskState = { sentences: [] };

/** Folds one event of the stream into the state. */
export function applyEvent(state: AskState, event: AskEvent): AskState {
  switch (event.type) {
    case "route":
      return { ...state, route: event.route };
    case "hits":
      return { ...state, hits: event };
    case "answer":
      return { ...state, answer: event };
    case "sentence":
      return { ...state, sentences: [...state.sentences, event] };
    case "done":
      return { ...state, done: event };
  }
}

export interface AskForm {
  question: string;
  answer: boolean;
  connectorId: string;
  from: string;
  to: string;
  acknowledgeUnverified?: boolean;
}

/** The start of a day (`from`) or its last millisecond (`to`) as the user's local clock reads it, as an instant. */
const localDay = (day: string, end: boolean): string => {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return (
    end ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d, 0, 0, 0, 0)
  ).toISOString();
};

/** The request of a form: an empty filter is left out, and a day is the whole day on the user's clock (CUF-R3). */
export function buildRequest(form: AskForm): AskRequest {
  return {
    question: form.question.trim(),
    answer: form.answer,
    ...(form.connectorId ? { connectorIds: [form.connectorId] } : {}),
    ...(form.from ? { from: localDay(form.from, false) } : {}),
    ...(form.to ? { to: localDay(form.to, true) } : {}),
    ...(form.acknowledgeUnverified ? { acknowledgeUnverified: true } : {}),
  };
}

export interface OpenedCitation {
  /** The index of the sentence whose source is shown. */
  index: number;
  source: EvidenceSource;
}

export function AskResults({
  state,
  running,
  question,
  opened,
  onOpenSource,
}: {
  state: AskState;
  running: boolean;
  /** The question that was asked, shown as the title (UI01-D16). */
  question?: string | undefined;
  opened?: OpenedCitation | undefined;
  onOpenSource?: ((index: number) => void) | undefined;
}) {
  const { go } = useNav();
  const { route, hits, answer, sentences, done } = state;
  const marked = (kind: "stale" | "conflict", versionId: number) =>
    hits?.notes.some((n) => n.kind === kind && "versionId" in n && n.versionId === versionId);
  const titleOf = (versionId: number) => hits?.hits.find((h) => h.versionId === versionId)?.title;
  const said = answer ? answerText(answer.status, answer.reason) : null;
  return (
    <>
      {question !== undefined && (
        <h2 className="detail-title">
          <bdi>{question}</bdi>
        </h2>
      )}
      {route && (
        <section className="ask-route" aria-label="고른 길">
          <span className="ask-label">고른 길</span>
          <ul aria-label="전략별 상태">
            {Object.entries(route).map(([name, entry]) => (
              <li key={name}>
                {strategyText(name)}:{" "}
                {routeStatusText(entry.status, "reason" in entry ? entry.reason : undefined)}
              </li>
            ))}
          </ul>
        </section>
      )}
      {running && hits && !answer && <p role="status">{ASK_WAITING}</p>}
      {(answer?.status === "started" || sentences.length > 0) && (
        <section className="ask-answer" aria-label="답">
          {done && sentences.length === 0 && <p role="status">{ASK_NO_SENTENCES}</p>}
          {sentences.length > 0 && (
            <ol aria-label="답 문장">
              {sentences.map((s, i) => (
                <li key={i}>
                  {s.text}
                  <sup>{`[${i + 1}]`}</sup>
                </li>
              ))}
            </ol>
          )}
          {done !== undefined && done.dropped > 0 && (
            <p role="status">{droppedText(done.dropped)}</p>
          )}
        </section>
      )}
      {said !== null && <p role="status">{said}</p>}
      {sentences.length > 0 && (
        <section className="ask-cites" aria-label="인용한 원본">
          <h3 className="ask-label">인용한 원본 {sentences.length}건</h3>
          <ol aria-label="인용한 원본">
            {sentences.map((s, i) => (
              <li key={i} className="cite-card">
                <p className="cite-quote">
                  <strong>{`[${i + 1}]`}</strong> <bdi>{s.citation.quote}</bdi>
                </p>
                <p className="src">
                  <bdi>{titleOf(s.citation.versionId) ?? ""}</bdi> (version {s.citation.version},
                  위치 {s.citation.start}–{s.citation.end})
                </p>
                <button type="button" onClick={() => onOpenSource?.(i)}>
                  원본 보기
                </button>
                {opened?.index === i && (
                  <section aria-label="인용 원본">
                    <SourceView source={opened.source} />
                  </section>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
      {hits && (
        <section className="ask-hits" aria-label="적중">
          <h3 className="ask-label">적중</h3>
          {hits.notes.some((n) => n.kind === "insufficient") && <p role="status">{ASK_NO_HITS}</p>}
          {hits.notes.some((n) => n.kind === "conflict") && <p role="status">{ASK_CONFLICT}</p>}
          {hits.hits.length > 0 && (
            <ol aria-label="적중 목록">
              {hits.hits.map((h) => (
                <li key={h.versionId}>
                  <bdi>{h.title}</bdi> (version {h.version}){" "}
                  {marked("stale", h.versionId) && <strong>낡음</strong>}{" "}
                  {marked("conflict", h.versionId) && <strong>충돌</strong>}
                  <br />
                  <span>찾은 전략: {h.strategies.map(strategyText).join(", ")}</span>
                  {h.related.length > 0 && (
                    <ul aria-label="관련 지식">
                      {h.related.map((r) => {
                        const actions = relatedActions(go, r);
                        return (
                          <li key={r.itemId}>
                            <button type="button" onClick={actions.openItem}>
                              <bdi>{r.name}</bdi>
                            </button>
                            {r.wikiTitle !== null && (
                              <>
                                {" "}
                                · 위키:{" "}
                                <button type="button" onClick={actions.openWiki}>
                                  <bdi>{r.wikiTitle}</bdi>
                                </button>
                              </>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </>
  );
}

export function Ask({ api }: { api: ApiClient }) {
  const [form, setForm] = useState<AskForm>({
    question: "",
    answer: true,
    connectorId: "",
    from: "",
    to: "",
  });
  const [connectors, setConnectors] = useState<RouteResponse<"connectors">["connectors"]>([]);
  const [state, setState] = useState<AskState>(INITIAL_ASK);
  const [running, setRunning] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [opened, setOpened] = useState<OpenedCitation>();
  /** The question that was last sent, shown as the title (UI01-D16): display only, nothing is stored. */
  const [asked, setAsked] = useState<string>();
  const controller = useRef<AbortController>(undefined);

  useEffect(() => {
    void api("connectors").then(
      (r) => setConnectors(r.connectors),
      () => undefined,
    );
    // leaving the screen closes the connection too: the answer is not wanted any more
    return () => controller.current?.abort();
  }, [api]);

  const connection = connectionOf(api);
  const needsAck =
    state.answer?.status === "blocked" && state.answer.reason === "unverified-ack-required";

  const opener = useMemo(
    () =>
      sourceOpener(
        api,
        (index, source) => setOpened({ index, source }),
        (text) => setFailure(text),
      ),
    [api],
  );
  const limitNotice = questionLimitText(form.question);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!connection || running || form.question.trim() === "" || limitNotice !== null) return;
    const mine = new AbortController();
    controller.current = mine;
    setState(INITIAL_ASK);
    setAsked(form.question.trim());
    setCancelled(false);
    setFailure(undefined);
    setOpened(undefined);
    opener.reset();
    setRunning(true);
    const request = buildRequest(form);
    setForm((f) => ({ ...f, acknowledgeUnverified: false })); // consent covers this one call only
    try {
      for await (const e of readAskEvents(connection, request, mine.signal)) {
        setState((s) => applyEvent(s, e));
      }
    } catch (error) {
      if (mine.signal.aborted) setCancelled(true);
      else
        setFailure(
          failureText(
            error instanceof Error && "code" in error ? String(error.code) : message(error),
          ),
        );
    } finally {
      setRunning(false);
    }
  };

  const openSource = (index: number) => {
    const citation = state.sentences[index]?.citation;
    if (citation) opener.open(citation, index);
  };

  return (
    <div className="pane-wide pane-read">
      <PaneHead title="질문" as="h1" />
      <div className="pane-body">
        <p role="status" className="sr-only">
          {progressText(state, running)}
        </p>
        {asked === undefined && <p>{ASK_INTRO}</p>}
        {failure && <p role="alert">{failure}</p>}
        {cancelled && <p role="status">{ASK_CANCELLED}</p>}
        <AskResults
          state={state}
          running={running}
          question={asked}
          opened={opened}
          onOpenSource={openSource}
        />
      </div>
      <form className="ask-bar" onSubmit={(e) => void submit(e)}>
        <div className="ask-filters">
          <label>
            {ASK_CONNECTOR}{" "}
            <select
              value={form.connectorId}
              onChange={(e) => setForm({ ...form, connectorId: e.target.value })}
            >
              <option value="">{ASK_ALL_CONNECTORS}</option>
              {connectors.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            {ASK_FROM}{" "}
            <input
              type="date"
              value={form.from}
              onChange={(e) => setForm({ ...form, from: e.target.value })}
            />
          </label>
          <label>
            {ASK_TO}{" "}
            <input
              type="date"
              value={form.to}
              onChange={(e) => setForm({ ...form, to: e.target.value })}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={form.answer}
              onChange={(e) => setForm({ ...form, answer: e.target.checked })}
            />
            {ASK_WANT_ANSWER}
          </label>
          {needsAck && (
            <label>
              <input
                type="checkbox"
                checked={form.acknowledgeUnverified === true}
                onChange={(e) => setForm({ ...form, acknowledgeUnverified: e.target.checked })}
              />
              {ASK_UNVERIFIED_ACK}
            </label>
          )}
        </div>
        <div className="ask-compose">
          <label>
            <span className="sr-only">{ASK_QUESTION}</span>
            <textarea
              rows={2}
              placeholder="다음 질문을 입력하세요"
              value={form.question}
              aria-describedby={limitNotice === null ? undefined : "ask-limit"}
              onChange={(e) => setForm({ ...form, question: e.target.value })}
            />
          </label>
          <div className="ask-buttons">
            <button
              type="submit"
              className="btn-primary"
              disabled={running || form.question.trim() === "" || limitNotice !== null}
            >
              {ASK_SUBMIT}
            </button>
            {running && (
              <button type="button" onClick={() => controller.current?.abort()}>
                {ASK_CANCEL}
              </button>
            )}
          </div>
        </div>
        {limitNotice !== null && <p id="ask-limit">{limitNotice}</p>}
      </form>
    </div>
  );
}
