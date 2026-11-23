// Words for the item-curation controls of the 탐색 and 지식 검토 screens (X02B-R7, R8, R10). The API sends codes;
// each refusal gets a fixed Korean text, exhaustive over the contract's code lists so a new code fails the
// typecheck here until it has words.
import { ENTITY_MERGE_REFUSALS, ENTITY_SPLIT_REFUSALS } from "@pki/contracts";

type MergeRefusal = (typeof ENTITY_MERGE_REFUSALS)[number];
type SplitRefusal = (typeof ENTITY_SPLIT_REFUSALS)[number];

export const MERGE_REFUSAL_TEXT: Record<MergeRefusal, string> = {
  "type-mismatch": "항목 종류가 달라 합칠 수 없습니다.",
  "already-merged": "이미 같은 묶음입니다.",
  "scope-refused": "범위 정책이 허용하지 않아 합칠 수 없습니다.",
};
export const SPLIT_REFUSAL_TEXT: Record<SplitRefusal, string> = {
  "row-not-on-item": "고른 줄이 이 항목의 것이 아니라서 나눌 수 없습니다.",
  "nothing-selected": "나눌 줄을 하나 이상 고르세요.",
  "nothing-left": "이 항목에 남는 줄이 없어서 모두 나눌 수는 없습니다.",
};

export const CURATE_HEADING = "항목 정리";
export const CURATE_MERGE_SEARCH = "합칠 항목 이름";
export const CURATE_MERGE_SEARCH_SUBMIT = "합칠 항목 찾기";
export const CURATE_MERGE_NONE = "합칠 만한 항목을 찾지 못했습니다.";
export const CURATE_MEMBERS = "구성원";
export const CURATE_MEMBERS_NONE = "합쳐진 항목이 없습니다.";
export const CURATE_KEEP_DISTINCT = "합치기를 되돌리면 다른 것으로 남기기";
export const CURATE_SPLIT = "나누기";
export const CURATE_SPLIT_NAME = "새 항목 이름";
export const CURATE_SPLIT_SUBMIT = "나누기";
export const CURATE_SPLIT_NONE = "나눌 사실·관계가 없습니다.";
export const CURATE_SPLIT_OPEN = "만들어진 항목 열기";
export const CURATE_DISTINCT_UNDO = "다른 것 표시 풀기";
export const CURATE_FAILED = "조치하지 못했습니다";
export const CURATE_LOADING = "찾는 중입니다.";

export const DETAIL_VALIDITY_FROM = "시작 날짜";
export const DETAIL_VALIDITY_UNTIL = "끝 날짜";
export const DETAIL_VALIDITY_HINT = "YYYY-MM-DD, 비우면 없음";
export const DETAIL_VALIDITY_SAVE = "기간 고치기";
export const DETAIL_VALIDITY_REVERT = "이전 기간으로 되돌리기";
export const DETAIL_VALIDITY_BAD =
  "기간을 저장하지 못했습니다. 날짜가 YYYY-MM-DD 형식의 실제 날짜이고 시작이 끝보다 앞인지 확인하세요.";
export const DETAIL_HISTORY_OPEN = "이력 보기";
export const DETAIL_HISTORY_NONE = "기록된 조치가 없습니다.";
export const DETAIL_HISTORY_LOADING = "이력을 불러오는 중입니다.";

const ACTION_TEXT: Record<string, string> = {
  created: "만들어짐",
  extract: "추출",
  approve: "승인",
  reject: "기각",
  dispute: "이의",
  undo: "되돌리기",
  replace: "값 고치기",
  supersede: "대체",
  merge: "합치기",
  unmerge: "합치기 되돌리기",
  split: "나누기",
  "set-validity": "유효 기간 고치기",
};
/** A known action code in words; an unknown one as the code itself. */
export const actionText = (action: string): string => ACTION_TEXT[action] ?? action;

export const ACTOR_TEXT = {
  user: "사용자",
  extraction: "추출",
  propagation: "전파",
  policy: "정책",
} as const;
