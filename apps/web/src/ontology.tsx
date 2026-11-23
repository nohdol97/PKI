// The 유형 정의 screen (X02B-R11): the type definitions by kind, with approve/reject/dispute/undo, history and
// retire on every line, and one form for adding and for changing a rule. "미리 확인" shows the counts first; an
// action goes to the existing route and the list is read again. Names and type lists are imported text: React
// text nodes inside <bdi> only (V02-R15). A rule's `dataChecks` is not edited here; it is sent back as stored.
import type { OntologyChangeRequest, RouteResponse } from "@pki/contracts";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { ApiClient } from "./api.ts";
import { createBusy } from "./latest.ts";
import {
  ACTOR_TEXT,
  CARDINALITY_TEXT,
  changeOf,
  checkText,
  draftOf,
  EMPTY_DRAFT,
  KIND_ORDER,
  KIND_TEXT,
  ONTOLOGY_EMPTY,
  ONTOLOGY_HISTORY_EMPTY,
  ONTOLOGY_HISTORY_LOADING,
  ONTOLOGY_INTRO,
  ONTOLOGY_LOADING,
  ORIGIN_TEXT,
  outcomeRefusalText,
  ruleSummary,
  STATUS_TEXT,
  VALUE_TYPES,
  type Draft,
  type ElementKind,
} from "./ontology-text.ts";

type Element = RouteResponse<"ontology">["elements"][number];
type HistoryLines = RouteResponse<"ontologyHistory">["lines"];
export type OntologyAction =
  | { type: "decide"; id: number; action: "approve" | "reject" | "dispute" }
  | { type: "undo"; id: number }
  | { type: "change"; change: OntologyChangeRequest };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** An action and then the list read again: the list as stored now, with the refusal's words if there was one. */
export async function perform(
  api: ApiClient,
  action: OntologyAction,
): Promise<{ elements: Element[]; refusal: string | undefined }> {
  const outcome =
    action.type === "decide"
      ? await api("ontologyDecide", { id: action.id, action: action.action })
      : action.type === "undo"
        ? await api("ontologyUndo", { id: action.id })
        : await api("ontologyChange", action.change);
  const { elements } = await api("ontology");
  return { elements, refusal: outcomeRefusalText(outcome) };
}

/** What the form's request would do, without doing it. */
export const preview = (api: ApiClient, draft: Draft) => api("ontologyCheck", changeOf(draft));

export function OntologyView({
  elements,
  history,
  onAct,
  onEdit,
  onHistory,
}: {
  elements: Element[];
  /** The history lines read so far, by element id; `undefined` while being read. */
  history: Record<number, HistoryLines | undefined>;
  onAct: (action: OntologyAction) => void;
  onEdit: (element: Element) => void;
  onHistory: (id: number) => void;
}) {
  if (elements.length === 0) return <p>{ONTOLOGY_EMPTY}</p>;
  return (
    <>
      {KIND_ORDER.map((kind) => {
        const rows = elements.filter((e) => e.elementKind === kind);
        return (
          <section key={kind} aria-label={KIND_TEXT[kind]}>
            <h2>{KIND_TEXT[kind]}</h2>
            {rows.length === 0 && <p>{ONTOLOGY_EMPTY}</p>}
            {rows.length > 0 && (
              <ul>
                {rows.map((e) => {
                  const act = (label: string, action: OntologyAction) => (
                    <button
                      type="button"
                      aria-label={`${label}: ${e.name}`}
                      onClick={() => onAct(action)}
                    >
                      {label}
                    </button>
                  );
                  return (
                    <li key={e.id}>
                      <strong>
                        <bdi>{e.name}</bdi>
                      </strong>{" "}
                      — {STATUS_TEXT[e.status]} · {e.edition}판 · {ORIGIN_TEXT[e.origin]}
                      <br />
                      <bdi>{ruleSummary(e.rule)}</bdi>
                      <br />
                      {act("승인", { type: "decide", id: e.id, action: "approve" })}{" "}
                      {act("기각", { type: "decide", id: e.id, action: "reject" })}{" "}
                      {act("이의", { type: "decide", id: e.id, action: "dispute" })}{" "}
                      {act("되돌리기", { type: "undo", id: e.id })}{" "}
                      {e.elementKind !== "item-type" && (
                        <>
                          <button
                            type="button"
                            aria-label={`규칙 고치기: ${e.name}`}
                            onClick={() => onEdit(e)}
                          >
                            규칙 고치기
                          </button>{" "}
                        </>
                      )}
                      {act("물리기", {
                        type: "change",
                        change: { op: "retire", name: e.name, elementKind: e.elementKind },
                      })}{" "}
                      <button
                        type="button"
                        aria-label={`이력: ${e.name}`}
                        onClick={() => onHistory(e.id)}
                      >
                        이력
                      </button>
                      {e.id in history && <HistoryList lines={history[e.id]} name={e.name} />}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </>
  );
}

function HistoryList({ lines, name }: { lines: HistoryLines | undefined; name: string }) {
  if (lines === undefined) return <p role="status">{ONTOLOGY_HISTORY_LOADING}</p>;
  if (lines.length === 0) return <p>{ONTOLOGY_HISTORY_EMPTY}</p>;
  return (
    <ol aria-label={`이력 목록: ${name}`}>
      {lines.map((l) => (
        <li key={l.seq}>
          {l.at} · {ACTOR_TEXT[l.actor]} · {l.action} ·{" "}
          {l.fromStatus ? STATUS_TEXT[l.fromStatus] : "—"} → {STATUS_TEXT[l.toStatus]}
        </li>
      ))}
    </ol>
  );
}

/** The add / change-rule form; the same draft is checked and applied. */
export function ChangeForm({
  draft,
  onDraft,
  onCheck,
  onApply,
  onCancel,
}: {
  draft: Draft;
  onDraft: (draft: Draft) => void;
  onCheck: () => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const set = (patch: Partial<Draft>) => onDraft({ ...draft, ...patch });
  const editing = draft.mode === "change-rule";
  return (
    <form
      aria-label={editing ? "규칙 고치기" : "정의 더하기"}
      onSubmit={(e: FormEvent) => e.preventDefault()}
    >
      <h2>{editing ? "규칙 고치기" : "정의 더하기"}</h2>
      <p>
        <label>
          종류{" "}
          <select
            value={draft.elementKind}
            disabled={editing}
            onChange={(e) => set({ elementKind: e.target.value as ElementKind })}
          >
            {KIND_ORDER.map((k) => (
              <option key={k} value={k}>
                {KIND_TEXT[k]}
              </option>
            ))}
          </select>
        </label>{" "}
        <label>
          이름{" "}
          <input
            value={draft.name}
            readOnly={editing}
            maxLength={200}
            onChange={(e) => set({ name: e.target.value })}
          />
        </label>
      </p>
      {draft.elementKind === "fact-kind" && (
        <p>
          <label>
            적용 항목 종류(쉼표로 구분){" "}
            <input value={draft.itemTypes} onChange={(e) => set({ itemTypes: e.target.value })} />
          </label>{" "}
          <label>
            값 형식{" "}
            <select value={draft.valueType} onChange={(e) => set({ valueType: e.target.value })}>
              {VALUE_TYPES.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>{" "}
          <label>
            개수{" "}
            <select
              value={draft.cardinality}
              onChange={(e) => set({ cardinality: e.target.value as "one" | "many" })}
            >
              {(Object.keys(CARDINALITY_TEXT) as (keyof typeof CARDINALITY_TEXT)[]).map((c) => (
                <option key={c} value={c}>
                  {CARDINALITY_TEXT[c]}
                </option>
              ))}
            </select>
          </label>
        </p>
      )}
      {draft.elementKind === "relation-type" && (
        <p>
          <label>
            주어 종류(쉼표로 구분){" "}
            <input
              value={draft.subjectTypes}
              onChange={(e) => set({ subjectTypes: e.target.value })}
            />
          </label>{" "}
          <label>
            대상 종류(쉼표로 구분){" "}
            <input
              value={draft.objectTypes}
              onChange={(e) => set({ objectTypes: e.target.value })}
            />
          </label>{" "}
          <label>
            <input
              type="checkbox"
              checked={draft.symmetric}
              onChange={(e) => set({ symmetric: e.target.checked })}
            />{" "}
            대칭
          </label>
        </p>
      )}
      <p>
        <button type="button" disabled={draft.name.trim() === ""} onClick={onCheck}>
          미리 확인
        </button>{" "}
        <button type="button" disabled={draft.name.trim() === ""} onClick={onApply}>
          적용
        </button>{" "}
        {editing && (
          <button type="button" onClick={onCancel}>
            고치기 취소
          </button>
        )}
      </p>
    </form>
  );
}

export function Ontology({ api }: { api: ApiClient }) {
  const [elements, setElements] = useState<Element[]>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [checked, setChecked] = useState<string>();
  const [history, setHistory] = useState<Record<number, HistoryLines | undefined>>({});
  // the latest request of each kind wins: an answer to an earlier one is dropped
  const listSeq = useRef(0);
  const checkSeq = useRef(0);

  const reload = useCallback(() => {
    const mine = ++listSeq.current;
    api("ontology").then(
      (r) => mine === listSeq.current && (setElements(r.elements), setError(undefined)),
      (e: unknown) => mine === listSeq.current && setError(message(e)),
    );
  }, [api]);
  useEffect(() => {
    reload();
    return () => {
      listSeq.current++;
      checkSeq.current++;
    };
  }, [reload]);

  const edit = (next: Draft) => {
    checkSeq.current++; // a check of an earlier form is no answer to this one
    setChecked(undefined);
    setDraft(next);
  };
  // one action out at a time: a second press before the answer is not sent (X02F-R6)
  const [busy] = useState(createBusy);
  const act = (action: OntologyAction) => {
    const work = busy(() => perform(api, action));
    if (!work) return;
    const mine = ++listSeq.current;
    setNotice(undefined);
    work.then(
      ({ elements: list, refusal }) => {
        if (mine !== listSeq.current) return;
        setElements(list);
        setError(undefined);
        setNotice(refusal);
        if (action.type === "change" && refusal === undefined && action.change.op !== "retire")
          edit(EMPTY_DRAFT);
        setHistory({});
      },
      (e: unknown) => mine === listSeq.current && setError(message(e)),
    );
  };
  const check = () => {
    const mine = ++checkSeq.current;
    preview(api, draft).then(
      (r) => mine === checkSeq.current && setChecked(checkText(r)),
      (e: unknown) => mine === checkSeq.current && setError(message(e)),
    );
  };
  const showHistory = (id: number) => {
    setHistory((h) => ({ ...h, [id]: undefined }));
    api("ontologyHistory", { id }).then(
      (r) => setHistory((h) => (id in h ? { ...h, [id]: r.lines } : h)),
      (e: unknown) => setError(message(e)),
    );
  };

  return (
    <>
      <p>{ONTOLOGY_INTRO}</p>
      {error && <p role="alert">불러오지 못했습니다: {error}</p>}
      {notice && <p role="alert">{notice}</p>}
      {elements === undefined && !error && <p role="status">{ONTOLOGY_LOADING}</p>}
      {elements && (
        <OntologyView
          elements={elements}
          history={history}
          onAct={act}
          onEdit={(e) => edit(draftOf(e))}
          onHistory={showHistory}
        />
      )}
      <ChangeForm
        draft={draft}
        onDraft={edit}
        onCheck={check}
        onApply={() => act({ type: "change", change: changeOf(draft) })}
        onCancel={() => edit(EMPTY_DRAFT)}
      />
      {checked && <p role="status">{checked}</p>}
    </>
  );
}
