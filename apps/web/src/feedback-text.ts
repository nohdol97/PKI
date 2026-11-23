// Words for the feedback buttons and the "최근 피드백" list (P03-R15). The kinds' screen names come from the
// contracts' kind table; the API sends codes and each code gets a fixed Korean text here, and a code this file
// does not know is shown as itself.
import { FEEDBACK_TABLE, type FeedbackKind } from "@pki/contracts";

export const feedbackLabel = (kind: FeedbackKind): string => FEEDBACK_TABLE[kind].label;

/** What the kind does to an Insight, shown as the button's hint. */
const INSIGHT_HINT: Readonly<Record<string, string>> = {
  useful: "순위를 조금 올립니다.",
  important: "순위를 올립니다.",
  irrelevant: "내 피드에서 숨기고 알리지 않습니다.",
  already_known: "내용이 바뀔 때까지 피드에서 숨기고 알리지 않습니다.",
  mute: "다시 알리지 않습니다. 피드와 순위는 그대로입니다.",
  confirmed: "봤고 처리했다는 표시입니다. 내용이 바뀔 때까지 숨깁니다.",
};
export const insightHint = (kind: FeedbackKind): string => INSIGHT_HINT[kind] ?? "";

/** The button's accessible name: the kind and the Insight it is for. */
export const feedbackButtonName = (kind: FeedbackKind, summary: string): string =>
  `${feedbackLabel(kind)}: ${summary}`;
export const undoButtonName = (label: string): string => `취소: ${label}`;

export const FEEDBACK_HEADING = "최근 피드백";
export const FEEDBACK_EMPTY = "최근 피드백이 없습니다.";
export const FEEDBACK_GONE = "대상이 더 이상 없거나 볼 수 없습니다.";

const REFUSAL: Readonly<Record<string, string>> = {
  "not-latest": "그 뒤에 다른 조치가 있어 되돌리지 않았습니다.",
  "nothing-to-undo": "이미 취소된 피드백입니다.",
  "data-check-unmet": "데이터 검사를 통과하지 못해 확인할 수 없습니다.",
  "invalid-transition": "지금 상태에서는 할 수 없는 조작입니다.",
};
export const feedbackRefusalText = (reason: string | undefined): string =>
  (reason === undefined ? undefined : REFUSAL[reason]) ?? `처리하지 못했습니다: ${reason ?? ""}`;
