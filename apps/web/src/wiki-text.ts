// Words for the Wiki screen (K01-R16). The API sends codes, ids and the knowledge rows' own text;
// each code gets a fixed Korean text here, and a code this file does not know is shown as itself.
import type { WikiClaim } from "@pki/contracts";

const PAGE_KIND: Readonly<Record<string, string>> = {
  concepts: "개념",
  projects: "프로젝트",
  people: "사람",
  organizations: "조직",
  systems: "시스템",
  decisions: "결정",
  "business-rules": "업무 규칙",
  metrics: "지표",
  tasks: "할 일",
  issues: "이슈",
  topics: "주제",
  syntheses: "종합",
};
export const pageKindText = (kind: string): string => PAGE_KIND[kind] ?? kind;

const CLAIM_STATUS: Readonly<Record<string, string>> = {
  candidate: "후보",
  verified: "확인됨",
  disputed: "이의 있음",
  superseded: "지난 값",
};
export const claimStatusText = (status: string): string => CLAIM_STATUS[status] ?? status;

const EPISTEMIC: Readonly<Record<string, string>> = {
  explicit: "원문에 명시",
  "user-approved": "사용자 승인",
  inferred: "추론",
  hypothesis: "가설",
};
export const epistemicText = (epistemic: string): string => EPISTEMIC[epistemic] ?? epistemic;

const LOG_ACTION: Readonly<Record<string, string>> = {
  created: "생성",
  changed: "변경",
  removed: "삭제",
};
export const logActionText = (action: string): string => LOG_ACTION[action] ?? action;

/** One history line: what happened and how many claims came and went. */
export const historyText = (line: { action: string; added: number; removed: number; at: string }) =>
  `${line.at} ${logActionText(line.action)} (주장 +${line.added} −${line.removed})`;

/** The period a claim holds for; empty when it states none. */
export function validityText(claim: Pick<WikiClaim, "validAt" | "validUntil">): string {
  if (claim.validAt && claim.validUntil) return `${claim.validAt} ~ ${claim.validUntil}`;
  if (claim.validAt) return `${claim.validAt}부터`;
  if (claim.validUntil) return `${claim.validUntil}까지`;
  return "";
}

/** A claim's marks: the status always, and a conflict or replacement marker when it has one. */
export function claimMarks(claim: WikiClaim): string[] {
  return [
    claimStatusText(claim.status),
    ...(claim.contradicts.length > 0 ? [`충돌 ${claim.contradicts.length}건`] : []),
    ...(claim.supersedes.length > 0 ? [`이전 값을 대체함 ${claim.supersedes.length}건`] : []),
  ];
}

export const WIKI_EMPTY = "아직 만들어진 페이지가 없습니다.";
export const WIKI_STALE =
  "지식이 바뀌어 페이지를 다시 만드는 중이거나 곧 만듭니다. 보이는 내용이 최신이 아닐 수 있습니다.";
export const WIKI_BUILD_DEAD =
  "페이지를 만드는 작업이 실패해 멈췄습니다. 지식이 다시 바뀌거나 '다시 만들기'를 누르면 다시 시도합니다.";
export const WIKI_PAGE_GONE = "이 페이지는 더 이상 없습니다. 근거 원본이 지워졌을 수 있습니다.";
export const WIKI_CLAIM_NO_EVIDENCE = "보여 줄 수 있는 근거가 없습니다.";
export const WIKI_NOT_FACT = "페이지는 정본에서 모아 만든 사본이며, 그 자체는 근거가 아닙니다.";
export const rebuildText = (status: "queued" | "open"): string =>
  status === "queued"
    ? "다시 만들기를 요청했습니다."
    : "이미 만드는 작업이 있어 그 작업이 처리합니다.";

/** The LLM summary's label and its held state (K01-R13, R14): the sentences come from a model, not from a row. */
export const WIKI_SUMMARY_LABEL = "LLM 요약";
export const WIKI_SUMMARY_HELD = "LLM 요약은 동의나 전송 조건을 기다리는 중입니다.";
