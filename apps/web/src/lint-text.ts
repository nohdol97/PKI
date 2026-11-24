// Words for the 점검 screen (K02-R15). The API sends codes, ids and the rows' own text; each code gets a fixed
// Korean text here, and a code this file does not know is shown as itself.
import { EXPLORE_QUERY_MAX, type RouteResponse } from "@pki/contracts";

type Lint = RouteResponse<"lint">;
export type LintRuleName = Lint["findings"][number]["rule"];
export type LintStatusName = Lint["findings"][number]["status"];

const RULE: Readonly<Record<string, string>> = {
  synonym: "같은 대상일 수 있는 항목",
  stale: "근거가 낡은 사실·관계",
  "overdue-work": "목표일이 지난 업무",
  "missing-link": "관계가 없는 함께 나온 항목",
};
export const ruleText = (rule: string): string => RULE[rule] ?? rule;

const RULE_HINT: Readonly<Record<string, string>> = {
  synonym: "받아들이면 두 항목을 하나로 합칩니다.",
  stale: "받아들이면 이 사실·관계를 틀린 것으로 거절합니다.",
  "overdue-work": "알림입니다. 완료일을 고쳐 넣으면 저절로 풀립니다.",
  "missing-link": "받아들이면 고른 유형으로 두 항목을 잇습니다.",
};
export const ruleHint = (rule: string): string => RULE_HINT[rule] ?? "";

const STATUS: Readonly<Record<string, string>> = {
  open: "열림",
  accepted: "받아들임",
  dismissed: "닫음",
  resolved: "풀림",
  oscillating: "반복됨",
};
export const statusText = (status: string): string => STATUS[status] ?? status;

/** The per-rule counts line (K02-R12). */
export const countsText = (c: Lint["counts"][number]): string =>
  `열림 ${c.open} · 받아들임 ${c.accepted} · 오탐 ${c.falsePositive} · 미탐 ${c.missed} · 반복됨 ${c.oscillating}`;

export const LINT_NOT_FACT =
  "점검 결과는 고쳐 볼 만한 곳을 알리는 후보이며, 그 자체는 지식이 아닙니다.";
export const LINT_EMPTY = "지금 보여 줄 점검 결과가 없습니다.";
export const LINT_OSCILLATING =
  "같은 지적이 여러 번 열렸다 닫혀 멈췄습니다. 받아들이거나 닫아야 끝납니다.";
export const LINT_NO_EVIDENCE = "보여 줄 수 있는 근거가 없습니다.";
const OPINION: Readonly<Record<string, string>> = {
  same: "같은 대상으로 보임",
  related: "관련은 있으나 같지 않음",
  unrelated: "관련 없어 보임",
};
/** The LLM opinion line (K02-R17): a hint beside the finding, never a decision. */
export const opinionText = (verdict: string): string => `LLM 의견: ${OPINION[verdict] ?? verdict}`;
export const LINT_RELATION_TYPE = "관계 유형";
export const LINT_PICK_TYPE = "유형을 고르세요";
export const LINT_NO_TYPES = "고를 수 있는 관계 유형이 없습니다.";

/** The last run's line: when and how many bundles it looked at; empty before the first run. */
export const lastRunText = (run: Lint["lastRun"], dirty: number): string =>
  run === null
    ? `아직 재검토를 하지 않았습니다. 다음에 볼 항목 ${dirty}개`
    : `마지막 재검토 ${run.at} · 본 묶음 ${run.counts.bundles ?? 0}개 · 다음에 볼 항목 ${dirty}개`;

/** What a refused decision says: the entry's own code, worded. */
const REFUSAL: Readonly<Record<string, string>> = {
  "type-mismatch": "두 항목의 유형이 달라 합칠 수 없습니다.",
  "already-merged": "이미 한 대상으로 묶여 있습니다.",
  "scope-refused": "접근 범위 정책이 두 항목을 함께 두는 것을 허용하지 않습니다.",
  "value-exists": "이미 있는 관계입니다.",
  "not-found": "대상이 더 이상 없습니다.",
  "invalid-state": "지금 상태에서는 할 수 없는 조작입니다.",
  "no-entry": "받아들일 수 있는 조작이 없는 알림입니다.",
  "relation-type-required": "관계 유형을 고르세요.",
};
export const refusalText = (reason: string | undefined): string =>
  (reason === undefined ? undefined : REFUSAL[reason]) ?? `받아들이지 못했습니다: ${reason ?? ""}`;

// CUF-R1: the "놓친 것 알리기" form. Only the three rules whose target is an item are offered (CUF-D1).
export const REPORT_HEADING = "놓친 것 알리기";
export const REPORT_HINT = `규칙이 찾지 못한 것을 알립니다. 규칙을 고르고, 항목을 이름으로 찾아 그 규칙이 받는 수만큼 고르세요. 이름은 ${EXPLORE_QUERY_MAX}자까지 찾습니다.`;
export const REPORT_RULE = "규칙";
export const REPORT_SEARCH = "항목 이름";
export const REPORT_SEARCH_SUBMIT = "찾기";
export const REPORT_SUBMIT = "알리기";
export const REPORT_LOADING = "찾는 중입니다.";
export const REPORT_NONE = "찾은 항목이 없습니다.";
export const REPORT_PICKED = "고른 항목";
export const REPORT_RESULTS = "찾은 항목";
export const REPORT_APPLIED = "알렸습니다. 점검 목록을 다시 읽었습니다.";
export const REPORT_EXISTS = "이미 점검 목록에 있는 것입니다.";
export const REPORT_NOT_FOUND = "대상이 없거나 볼 수 없거나, 두 항목이 이미 한 묶음입니다.";
export const reportSearchFailedText = (message: string): string => `찾지 못했습니다: ${message}`;
export const reportFailedText = (message: string): string => `알리지 못했습니다: ${message}`;
