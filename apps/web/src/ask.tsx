// The 질문 screen (X01-R11): the user asks, and the answer arrives in steps as the backend streams it (the
// chosen route, the hits, then the confirmed sentences). The screen holds labels only; every value shown comes
// from the stream. Titles and quotes are imported text, so they reach the page as React text nodes inside <bdi>
// only (V02-R15). Nothing is stored here: the question and the answer live in this component until the user
// leaves the screen (X01-R15). Cancel closes the connection; what already arrived stays on screen.
import type { AskEvent, AskRequest, RouteResponse } from "@pki/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { connectionOf, type ApiClient } from "./api.ts";
import { readAskEvents } from "./ask-stream.ts";
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
  ASK_RELATED_PENDING,
  ASK_SUBMIT,
  ASK_TO,
  ASK_UNVERIFIED_ACK,
  ASK_WAITING,
  ASK_WANT_ANSWER,
  droppedText,
  failureText,
  routeStatusText,
  strategyText,
} from "./ask-text.ts";

type Of<T extends AskEvent["type"]> = Extract<AskEvent, { type: T }>;

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

/** The request of a form: an empty filter is left out, and a day is the whole day in UTC. */
export function buildRequest(form: AskForm): AskRequest {
  return {
    question: form.question.trim(),
    answer: form.answer,
    ...(form.connectorId ? { connectorIds: [form.connectorId] } : {}),
    ...(form.from ? { from: `${form.from}T00:00:00.000Z` } : {}),
    ...(form.to ? { to: `${form.to}T23:59:59.999Z` } : {}),
    ...(form.acknowledgeUnverified ? { acknowledgeUnverified: true } : {}),
  };
}

export function AskResults({ state, running }: { state: AskState; running: boolean }) {
  const { route, hits, answer, sentences, done } = state;
  const marked = (kind: "stale" | "conflict", versionId: number) =>
    hits?.notes.some((n) => n.kind === kind && "versionId" in n && n.versionId === versionId);
  const titleOf = (versionId: number) => hits?.hits.find((h) => h.versionId === versionId)?.title;
  const said = answer ? answerText(answer.status, answer.reason) : null;
  const anyRelated = hits?.hits.some((h) => h.related.length > 0);
  return (
    <>
      {route && (
        <section aria-label="고른 길">
          <h2>고른 길</h2>
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
      {hits && (
        <section aria-label="적중">
          <h2>적중</h2>
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
                      {h.related.map((r) => (
                        <li key={r.itemId}>
                          <bdi>{r.name}</bdi>
                          {r.wikiTitle !== null && (
                            <>
                              {" "}
                              · 위키: <bdi>{r.wikiTitle}</bdi>
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          )}
          {anyRelated && <p>{ASK_RELATED_PENDING}</p>}
        </section>
      )}
      {running && hits && !answer && <p role="status">{ASK_WAITING}</p>}
      {(answer?.status === "started" || sentences.length > 0) && (
        <section aria-label="답">
          <h2>답</h2>
          {done && sentences.length === 0 && <p role="status">{ASK_NO_SENTENCES}</p>}
          {sentences.length > 0 && (
            <ol aria-label="답 문장">
              {sentences.map((s, i) => (
                <li key={i}>
                  <p>{s.text}</p>
                  <blockquote>
                    <bdi>{s.citation.quote}</bdi>
                  </blockquote>
                  <small>
                    출처: <bdi>{titleOf(s.citation.versionId) ?? ""}</bdi> (version{" "}
                    {s.citation.version}, 위치 {s.citation.start}–{s.citation.end})
                  </small>
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
    </>
  );
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

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

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!connection || running || form.question.trim() === "") return;
    const mine = new AbortController();
    controller.current = mine;
    setState(INITIAL_ASK);
    setCancelled(false);
    setFailure(undefined);
    setRunning(true);
    try {
      for await (const e of readAskEvents(connection, buildRequest(form), mine.signal)) {
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

  return (
    <>
      <p>{ASK_INTRO}</p>
      <form onSubmit={(e) => void submit(e)}>
        <p>
          <label>
            {ASK_QUESTION}
            <br />
            <textarea
              rows={3}
              cols={60}
              value={form.question}
              onChange={(e) => setForm({ ...form, question: e.target.value })}
            />
          </label>
        </p>
        <p>
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
          </label>{" "}
          <label>
            {ASK_FROM}{" "}
            <input
              type="date"
              value={form.from}
              onChange={(e) => setForm({ ...form, from: e.target.value })}
            />
          </label>{" "}
          <label>
            {ASK_TO}{" "}
            <input
              type="date"
              value={form.to}
              onChange={(e) => setForm({ ...form, to: e.target.value })}
            />
          </label>
        </p>
        <p>
          <label>
            <input
              type="checkbox"
              checked={form.answer}
              onChange={(e) => setForm({ ...form, answer: e.target.checked })}
            />{" "}
            {ASK_WANT_ANSWER}
          </label>
          {needsAck && (
            <label>
              {" "}
              <input
                type="checkbox"
                checked={form.acknowledgeUnverified === true}
                onChange={(e) => setForm({ ...form, acknowledgeUnverified: e.target.checked })}
              />{" "}
              {ASK_UNVERIFIED_ACK}
            </label>
          )}
        </p>
        <p>
          <button type="submit" disabled={running || form.question.trim() === ""}>
            {ASK_SUBMIT}
          </button>
          {running && (
            <button type="button" onClick={() => controller.current?.abort()}>
              {ASK_CANCEL}
            </button>
          )}
        </p>
      </form>
      {failure && <p role="alert">{failure}</p>}
      {cancelled && <p role="status">{ASK_CANCELLED}</p>}
      <AskResults state={state} running={running} />
    </>
  );
}
