// The eight kinds of feedback (P03-R1): one table says each kind's screen name, class, the targets it
// may be given to and its effect. Storage, the API and the screen read this table and nothing else, so a
// combination that is not in it (a relation marked "useful") is refused everywhere alike. The weights are
// provisional constants, not measured on use (P03-D6).
export const FEEDBACK_KINDS = [
  "useful",
  "important",
  "irrelevant",
  "already_known",
  "mute",
  "confirmed",
  "wrong_info",
  "wrong_relation",
] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export type FeedbackTargetKind = "insight" | "item" | "fact" | "relation";
export interface FeedbackTarget {
  kind: FeedbackTargetKind;
  id: number;
}

/** A correction changes a knowledge row's review state; a preference never touches knowledge (P03-R6). */
export type FeedbackClass = "preference" | "correction";

/** What a correction asks of the user's entry: a dispute (a rejection of a candidate) or an approval (P03-R4). */
export type CorrectionAction = "refute" | "approve";

export interface FeedbackKindInfo {
  kind: FeedbackKind;
  /** Korean screen name */
  label: string;
  /** Targets on which the kind is a preference. */
  preference: readonly FeedbackTargetKind[];
  /** Targets on which the kind is a correction. */
  correction: readonly FeedbackTargetKind[];
  /** The kind's direct weight; 0 for a kind that is not a like or dislike. */
  weight: number;
  /** Set for the kinds whose correction goes through the user's entry. */
  action: CorrectionAction | null;
}

const kindInfo = (
  kind: FeedbackKind,
  label: string,
  rest: Omit<FeedbackKindInfo, "kind" | "label">,
): FeedbackKindInfo => ({ kind, label, ...rest });

export const FEEDBACK_TABLE: Readonly<Record<FeedbackKind, FeedbackKindInfo>> = {
  useful: kindInfo("useful", "유용함", {
    preference: ["insight", "item"],
    correction: [],
    weight: 50,
    action: null,
  }),
  important: kindInfo("important", "중요함", {
    preference: ["insight", "item"],
    correction: [],
    weight: 100,
    action: null,
  }),
  irrelevant: kindInfo("irrelevant", "관련 없음", {
    preference: ["insight", "item"],
    correction: [],
    weight: -100,
    action: null,
  }),
  already_known: kindInfo("already_known", "이미 알고 있음", {
    preference: ["insight"],
    correction: [],
    weight: 0,
    action: null,
  }),
  mute: kindInfo("mute", "다시 알리지 않기", {
    preference: ["insight", "item"],
    correction: [],
    weight: 0,
    action: null,
  }),
  confirmed: kindInfo("confirmed", "확인 완료", {
    preference: ["insight"],
    correction: ["item", "fact", "relation"],
    weight: 0,
    action: "approve",
  }),
  wrong_info: kindInfo("wrong_info", "잘못된 정보", {
    preference: [],
    correction: ["item", "fact"],
    weight: 0,
    action: "refute",
  }),
  wrong_relation: kindInfo("wrong_relation", "잘못된 관계", {
    preference: [],
    correction: ["relation"],
    weight: 0,
    action: "refute",
  }),
};

export const isFeedbackKind = (value: string): value is FeedbackKind =>
  (FEEDBACK_KINDS as readonly string[]).includes(value);

/** The class of `kind` on `target`, or undefined when the table does not allow that combination. */
export function feedbackClass(
  kind: FeedbackKind,
  target: FeedbackTargetKind,
): FeedbackClass | undefined {
  const info = FEEDBACK_TABLE[kind];
  return info.preference.includes(target)
    ? "preference"
    : info.correction.includes(target)
      ? "correction"
      : undefined;
}

/** The kinds the screen offers on an Insight, in the table's order (P03-R15). */
export const INSIGHT_FEEDBACK_KINDS: readonly FeedbackKind[] = FEEDBACK_KINDS.filter(
  (kind) => feedbackClass(kind, "insight") !== undefined,
);
