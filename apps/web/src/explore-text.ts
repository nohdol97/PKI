// Words for the 탐색 screen (X02-R6, R8). The API sends codes and the rows' own text; the screen holds labels only.
export const EXPLORE_INTRO =
  "관심 있는 항목을 이름으로 찾아 이웃 관계와 시간순 사실을 보고, 근거 원본까지 내려갑니다. 아무것도 저장하지 않습니다.";
export const EXPLORE_SEARCH = "항목 이름";
export const EXPLORE_SEARCH_SUBMIT = "찾기";
export const EXPLORE_LOADING = "불러오는 중입니다.";
export const EXPLORE_EMPTY = "찾은 항목이 없습니다.";
export const EXPLORE_MORE = "더 보기";
export const EXPLORE_NO_NEIGHBOURS = "이 깊이에서 이어진 항목이 없습니다.";
export const EXPLORE_TRUNCATED = "이웃이 많아 일부만 보입니다.";
export const EXPLORE_GONE = "이 항목은 더 이상 볼 수 없습니다.";
export const EXPLORE_EVIDENCE_NONE = "이 줄의 근거를 찾지 못했습니다.";
export const TIMELINE_NONE = "시점 없음";
export const OPEN_WIKI = "위키 페이지 열기";

const DIRECTION = {
  forward: "나감 (이 항목 → 상대)",
  backward: "들어옴 (상대 → 이 항목)",
} as const;
export const directionText = (direction: "forward" | "backward"): string => DIRECTION[direction];

/** A valid interval in words; empty when the row states none. */
export function intervalText(validAt: string | null, validUntil: string | null): string {
  if (validAt && validUntil) return `${validAt} ~ ${validUntil}`;
  if (validAt) return `${validAt}부터`;
  if (validUntil) return `${validUntil}까지`;
  return "";
}

export const GRAPH_NOTE_CUT =
  "이웃이 많아 그림에는 60개까지만 그렸습니다. 표에서 전부 볼 수 있습니다.";
export const graphSummary = (items: number, relations: number): string =>
  `이웃 그림: 항목 ${items}개, 관계 ${relations}개`;
