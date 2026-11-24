// Words for the 지식 검토 and 탐색 screens (X02-R7). The API sends codes; each gets a fixed Korean text. The
// records are exhaustive over the contract's code lists, so a code added there fails the typecheck here until it
// has words (the refusal list especially: the user reads a reason, never a bare code).
import { SEMANTIC_REFUSALS, DATA_CHECK_UNMET, type RouteResponse } from "@pki/contracts";

type Status = RouteResponse<"semantic">["items"][number]["status"];
type Epistemic = RouteResponse<"semantic">["items"][number]["epistemic"];
type Refusal = (typeof SEMANTIC_REFUSALS)[number];
type Unmet = (typeof DATA_CHECK_UNMET)[number];
type Conflict = RouteResponse<"conflicts">["links"][number];

export const STATUS_TEXT: Record<Status, string> = {
  candidate: "후보",
  verified: "확정",
  disputed: "이의 있음",
  superseded: "대체됨",
  rejected: "기각",
};
/** The dot colour of a status (UI01-R9); the word beside it says the same. */
export const STATUS_CLASS: Record<Status, string> = {
  candidate: "state-warn",
  verified: "state-ok",
  disputed: "state-attn",
  superseded: "state-none",
  rejected: "state-none",
};
export const STATUS_ORDER: readonly Status[] = [
  "candidate",
  "verified",
  "disputed",
  "superseded",
  "rejected",
];

export const EPISTEMIC_TEXT: Record<Epistemic, string> = {
  explicit: "원문에 명시",
  "user-approved": "사용자 승인",
  inferred: "추론",
  hypothesis: "가설",
};

export const REFUSAL_TEXT: Record<Refusal, string> = {
  "invalid-transition": "지금 상태에서는 할 수 없는 조치입니다.",
  "user-override": "사용자가 이미 정한 행이라 이 조치로 바꿀 수 없습니다.",
  "basis-required": "근거가 있어야 승인할 수 있습니다.",
  "not-latest": "원본의 최신 version에서 나온 근거가 아니라서 승인할 수 없습니다.",
  "nothing-to-undo": "되돌릴 사용자 조치가 없습니다.",
  "value-exists": "같은 값의 행이 이미 있습니다. 그 행을 승인하세요.",
  "existing-data-violation": "이 항목을 가리키는 데이터가 남아 있어 되돌릴 수 없습니다.",
  "data-check-unmet": "데이터 조건이 맞지 않아 승인할 수 없습니다.",
};
export const UNMET_TEXT: Record<Unmet, string> = {
  "no-dataset": "데이터셋 없음",
  "spec-conflict": "명세 충돌",
  "check-missing": "점검 없음",
  schema: "스키마",
  grain: "행 단위",
  "join-cardinality": "조인 대응 수",
  aggregation: "집계",
};

/** A refusal in words; the unmet data conditions follow the sentence that names them. */
export const refusalText = (reason: Refusal, unmet?: readonly Unmet[]): string =>
  unmet && unmet.length > 0
    ? `${REFUSAL_TEXT[reason]} (${unmet.map((u) => UNMET_TEXT[u]).join(", ")})`
    : REFUSAL_TEXT[reason];

export const CONFLICT_TYPE_TEXT: Record<Conflict["type"], string> = {
  SUPERSEDES: "대신함",
  CONTRADICTS: "어긋남",
};
export const CREATED_BY_TEXT: Record<Conflict["createdBy"], string> = {
  rule: "규칙",
  propagation: "전파",
  user: "사용자",
};

export const REVIEW_INTRO =
  "추출된 지식을 확인합니다. 승인·기각·이의·되돌리기와 값 고치기는 바로 저장되고, 목록은 다시 읽어 보여 줍니다.";
export const REVIEW_LOADING = "지식 목록을 불러오는 중입니다.";
export const REVIEW_EMPTY = "이 상태로 보여 줄 지식이 없습니다.";
export const REVIEW_MORE = "더 보기";
export const REVIEW_REREAD_FAILED =
  "조치는 반영됐지만 목록을 다시 읽지 못했습니다. 보이는 목록은 조치 전의 것입니다.";
export const PAIRS_HEADING = "합치기 후보";
export const PAIRS_EMPTY = "합치기 후보가 없습니다.";
export const CONFLICTS_EMPTY = "검토할 충돌이 없습니다.";
export const CONFLICTS_TRUNCATED = "충돌 목록이 잘렸습니다.";
export const FILTER_ALL = "전체";
