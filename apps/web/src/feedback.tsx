// Feedback on Home's Insights (P03-R15): a button for each kind the table allows on an Insight, and the
// "최근 피드백" list where a line is cancelled. Both tell the caller after each change so the Insight list is
// read again. Labels are the Insights' own text (imported data), so they reach the page as React text nodes
// inside <bdi> only (V02-R15). A correction (wrong info, wrong relation, confirmed) is offered on an evidence row
// through `RowFeedback`, by the row's `targetId` (P5F-R6).
import {
  FEEDBACK_KINDS,
  feedbackClass,
  INSIGHT_FEEDBACK_KINDS,
  rowFeedbackKinds,
  type FeedbackLine,
  type FeedbackKind,
  type FeedbackTarget,
} from "@pki/contracts";
import { useEffect, useMemo, useState } from "react";
import { ApiError, type ApiClient } from "./api.ts";
import { createBusy, createLatest } from "./latest.ts";
import {
  FEEDBACK_EMPTY,
  FEEDBACK_GONE,
  FEEDBACK_HEADING,
  feedbackButtonName,
  feedbackLabel,
  feedbackRefusalText,
  insightHint,
  ITEM_FEEDBACK_HEADING,
  ITEM_FEEDBACK_LINES,
  ITEM_FEEDBACK_NONE,
  itemFeedbackGroupName,
  itemHint,
  undoButtonName,
} from "./feedback-text.ts";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const gone = (error: unknown) => error instanceof ApiError && error.status === 404;

/** A notice held with the target it was made for; it is shown only while that target is the one on screen. */
export const scopedNotice = (
  held: { id: number; text: string | undefined } | undefined,
  id: number,
): string | undefined => (held?.id === id ? held.text : undefined);

type Reason = Parameters<typeof feedbackRefusalText>[0];

/**
 * The record and undo calls of one component (UIF2-R4). They share one lock: while a call is out the next is not
 * sent and answers `undefined`. A sent call never rejects; it says what to tell and whether the lists changed.
 */
export function createFeedbackCalls(api: ApiClient) {
  const busy = createBusy();
  type Outcome = { text: string | undefined; changed: boolean };
  const settle = (
    call: Promise<{ status: string; reason?: Reason | undefined }>,
    failed: string,
  ): Promise<Outcome> =>
    call.then(
      (r) => ({
        text: r.status === "refused" ? feedbackRefusalText(r.reason as Reason) : undefined,
        changed: true,
      }),
      (error: unknown) => ({
        text: gone(error) ? FEEDBACK_GONE : `${failed}: ${message(error)}`,
        changed: gone(error),
      }),
    );
  return {
    record: (target: FeedbackTarget, kind: FeedbackKind) =>
      busy(() => settle(api("feedbackRecord", { target, kind }), "보내지 못했습니다")),
    undo: (id: number) => busy(() => settle(api("feedbackUndo", { id }), "취소하지 못했습니다")),
  };
}

/** The record call every button makes: the refusal or failure text it leaves, and the press itself. */
function useRecord(
  calls: ReturnType<typeof createFeedbackCalls>,
  target: FeedbackTarget,
  onChange: () => void,
) {
  const [held, setHeld] = useState<{ id: number; text: string | undefined }>();
  const press = async (kind: FeedbackKind) => {
    const id = target.id;
    const done = await calls.record(target, kind);
    if (!done) return;
    setHeld({ id, text: done.text });
    if (done.changed) onChange();
  };
  return { notice: scopedNotice(held, target.id), press };
}

/** The record call of one Insight, shared by the head bar's and the action bar's buttons of its detail pane. */
export const useInsightRecord = (api: ApiClient, insightId: number, onChange: () => void) =>
  useRecord(
    useMemo(() => createFeedbackCalls(api), [api]),
    { kind: "insight", id: insightId },
    onChange,
  );

/**
 * The Insight's feedback in its detail pane: "확인 완료" in the head bar (part "head"), the other kinds in the action
 * bar (part "bar"), where the first of them (유용함) is the main action and a refusal or failure is told.
 */
export function InsightFeedback({
  insight,
  record,
  part,
}: {
  insight: { id: number; summary: string };
  record: ReturnType<typeof useInsightRecord>;
  part: "head" | "bar";
}) {
  const { notice, press } = record;
  const kinds = INSIGHT_FEEDBACK_KINDS.filter(
    (kind) => (kind === "confirmed") === (part === "head"),
  );
  const buttons = kinds.map((kind) => (
    <button
      key={kind}
      type="button"
      className={part === "head" ? "btn-text" : kind === "useful" ? "btn-primary" : undefined}
      title={insightHint(kind)}
      aria-label={feedbackButtonName(kind, insight.summary)}
      onClick={() => void press(kind)}
    >
      {feedbackLabel(kind)}
    </button>
  ));
  if (part === "head") return <>{buttons}</>;
  return (
    <>
      {notice && <p role="alert">{notice}</p>}
      <div className="actions" role="group" aria-label={`피드백: ${insight.summary}`}>
        {buttons}
      </div>
    </>
  );
}

/** The corrections the table allows on an evidence row's fact or relation; `label` (its quote) names each button. */
export function RowFeedback({
  api,
  target,
  label,
  onChange,
}: {
  api: ApiClient;
  target: { kind: "fact" | "relation"; id: number };
  label: string;
  onChange: () => void;
}) {
  const calls = useMemo(() => createFeedbackCalls(api), [api]);
  const { notice, press } = useRecord(calls, target, onChange);
  return (
    <>
      <div className="row-actions" role="group" aria-label={`교정: ${label}`}>
        {rowFeedbackKinds(target.kind).map((kind) => (
          <button
            key={kind}
            type="button"
            aria-label={feedbackButtonName(kind, label)}
            onClick={() => void press(kind)}
          >
            {feedbackLabel(kind)}
          </button>
        ))}
      </div>
      {notice && <p role="alert">{notice}</p>}
    </>
  );
}

/** The live lines, newest first; `version` changes when a feedback was given elsewhere on the screen. */
export function RecentFeedback({
  api,
  version,
  onChange,
}: {
  api: ApiClient;
  version: number;
  onChange: () => void;
}) {
  const [lines, setLines] = useState<FeedbackLine[]>();
  const [notice, setNotice] = useState<string>();
  useEffect(() => {
    void api("feedbackList").then(
      (r) => setLines(r.feedback),
      (error: unknown) => setNotice(`불러오지 못했습니다: ${message(error)}`),
    );
  }, [api, version]);
  const calls = useMemo(() => createFeedbackCalls(api), [api]);
  const undo = async (line: FeedbackLine) => {
    const done = await calls.undo(line.id);
    if (!done) return;
    setNotice(done.text);
    if (done.changed) onChange();
  };
  return (
    <section aria-labelledby="feedback-heading">
      <h3 id="feedback-heading">{FEEDBACK_HEADING}</h3>
      {notice && <p role="alert">{notice}</p>}
      {lines?.length === 0 && <p>{FEEDBACK_EMPTY}</p>}
      {lines && lines.length > 0 && (
        <ul className="plain-list" aria-label="최근 피드백 목록">
          {lines.map((line) => (
            <li key={line.id}>
              <strong>{feedbackLabel(line.kind)}</strong> <bdi>{line.label}</bdi>{" "}
              <button
                type="button"
                aria-label={undoButtonName(line.label)}
                onClick={() => void undo(line)}
              >
                취소
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const ITEM_PREFERENCE_KINDS = FEEDBACK_KINDS.filter(
  (kind) => feedbackClass(kind, "item") === "preference",
);

/** The live lines that are preferences on one of `ids` (the item and the members of its bundle). */
export const itemPreferenceLines = (
  lines: readonly FeedbackLine[],
  ids: ReadonlySet<number>,
): FeedbackLine[] =>
  lines.filter((l) => l.class === "preference" && l.target.kind === "item" && ids.has(l.target.id));

/**
 * An item's preferences in 탐색 (CUF-R2): a button for each kind the table allows on an item, and below them the
 * lines left on the item (and its bundle's members) with a cancel each. The caller mounts it with the item's id as
 * its `key`, so a read or an answer that was out when another item was opened has nothing to land on.
 */
export function ItemFeedback({
  api,
  item,
  memberIds,
}: {
  api: ApiClient;
  item: { id: number; name: string };
  memberIds: readonly number[];
}) {
  const [lines, setLines] = useState<FeedbackLine[]>();
  const [notice, setNotice] = useState<string>();
  const [version, setVersion] = useState(0);
  const [latest] = useState(createLatest);
  const calls = useMemo(() => createFeedbackCalls(api), [api]);
  const { notice: recordNotice, press } = useRecord(calls, { kind: "item", id: item.id }, () =>
    setVersion((v) => v + 1),
  );
  useEffect(() => {
    const current = latest.begin();
    void api("feedbackList").then(
      (r) => current() && setLines(r.feedback),
      (error: unknown) => current() && setNotice(`불러오지 못했습니다: ${message(error)}`),
    );
  }, [api, latest, version]);
  const undo = async (line: FeedbackLine) => {
    const done = await calls.undo(line.id);
    if (!done) return;
    setNotice(done.text);
    if (done.changed) setVersion((v) => v + 1);
  };
  const mine = lines && itemPreferenceLines(lines, new Set([item.id, ...memberIds]));
  return (
    <section aria-label={ITEM_FEEDBACK_HEADING}>
      <h3>{ITEM_FEEDBACK_HEADING}</h3>
      {recordNotice && <p role="alert">{recordNotice}</p>}
      <div className="row-actions" role="group" aria-label={itemFeedbackGroupName(item.name)}>
        {ITEM_PREFERENCE_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            title={itemHint(kind)}
            aria-label={feedbackButtonName(kind, item.name)}
            onClick={() => void press(kind)}
          >
            {feedbackLabel(kind)}
          </button>
        ))}
      </div>
      <h4>{ITEM_FEEDBACK_LINES}</h4>
      {notice && <p role="alert">{notice}</p>}
      {mine?.length === 0 && <p>{ITEM_FEEDBACK_NONE}</p>}
      {mine && mine.length > 0 && (
        <ul className="plain-list" aria-label="남긴 선호 목록">
          {mine.map((line) => (
            <li key={line.id}>
              <strong>{feedbackLabel(line.kind)}</strong> <bdi>{line.label}</bdi>{" "}
              <button
                type="button"
                aria-label={undoButtonName(line.label)}
                onClick={() => void undo(line)}
              >
                취소
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
