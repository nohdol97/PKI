// Feedback on Home's Insights (P03-R15): a button for each kind the table allows on an Insight, and the
// "최근 피드백" list where a line is cancelled. Both tell the caller after each change so the Insight list is
// read again. Labels are the Insights' own text (imported data), so they reach the page as React text nodes
// inside <bdi> only (V02-R15). A correction (wrong info, wrong relation, confirmed) is offered on an evidence row
// through `RowFeedback`, by the row's `targetId` (P5F-R6).
import {
  INSIGHT_FEEDBACK_KINDS,
  rowFeedbackKinds,
  type FeedbackLine,
  type FeedbackKind,
  type FeedbackTarget,
} from "@pki/contracts";
import { useEffect, useState } from "react";
import { ApiError, type ApiClient } from "./api.ts";
import {
  FEEDBACK_EMPTY,
  FEEDBACK_GONE,
  FEEDBACK_HEADING,
  feedbackButtonName,
  feedbackLabel,
  feedbackRefusalText,
  insightHint,
  undoButtonName,
} from "./feedback-text.ts";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const gone = (error: unknown) => error instanceof ApiError && error.status === 404;

/** The record call every button makes: the refusal or failure text it leaves, and the press itself. */
function useRecord(api: ApiClient, target: FeedbackTarget, onChange: () => void) {
  const [notice, setNotice] = useState<string>();
  const press = (kind: FeedbackKind) =>
    api("feedbackRecord", { target, kind }).then(
      (r) => {
        setNotice(r.status === "refused" ? feedbackRefusalText(r.reason) : undefined);
        onChange();
      },
      (error: unknown) => {
        setNotice(gone(error) ? FEEDBACK_GONE : `보내지 못했습니다: ${message(error)}`);
        if (gone(error)) onChange();
      },
    );
  return { notice, press };
}

/** The record call of one Insight, shared by the head bar's and the action bar's buttons of its detail pane. */
export const useInsightRecord = (api: ApiClient, insightId: number, onChange: () => void) =>
  useRecord(api, { kind: "insight", id: insightId }, onChange);

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
  const { notice, press } = useRecord(api, target, onChange);
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
  const undo = (line: FeedbackLine) =>
    api("feedbackUndo", { id: line.id }).then(
      (r) => {
        setNotice(r.status === "refused" ? feedbackRefusalText(r.reason) : undefined);
        onChange();
      },
      (error: unknown) => {
        setNotice(gone(error) ? FEEDBACK_GONE : `취소하지 못했습니다: ${message(error)}`);
        if (gone(error)) onChange();
      },
    );
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
