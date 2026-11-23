// Words for the 질문 screen (X01-R11). The API sends codes and the rows' own text; each code gets a fixed Korean
// text here, and a code this file does not know is shown as itself.
import { blockReasonText } from "./connection-test-text.ts";

export const ASK_INTRO =
  "질문과 답은 저장하지 않습니다. 답은 근거가 확인된 문장만 보여 주며, 확정 사실이 아니라 원본에서 찾은 내용입니다.";
export const ASK_QUESTION = "질문 입력";
export const ASK_SUBMIT = "질문하기";
export const ASK_CANCEL = "취소";
export const ASK_WANT_ANSWER = "답 받기";
export const ASK_CONNECTOR = "수집기";
export const ASK_ALL_CONNECTORS = "전체";
export const ASK_FROM = "시작일";
export const ASK_TO = "종료일";
export const ASK_UNVERIFIED_ACK = "격리 미검증 경고를 확인했습니다(이번 질문에만 적용)";
export const ASK_WAITING = "답을 만드는 중입니다. 취소하면 연결을 끊고 답 만들기를 멈춥니다.";
export const ASK_CANCELLED = "질문을 취소했습니다. 이미 도착한 내용만 남아 있습니다.";
export const ASK_NO_HITS = "찾은 원본이 없어 근거가 부족합니다.";
export const ASK_NO_SENTENCES = "근거가 확인된 문장이 없습니다.";
export const ASK_INSUFFICIENT = "근거가 부족합니다. 찾은 원본으로는 답을 만들 수 없습니다.";
export const ASK_CONFLICT =
  "서로 어긋나는 사실에 기댄 원본이 함께 찾혔습니다. 어느 쪽이 맞는지 원본을 확인하세요.";

const STRATEGY: Readonly<Record<string, string>> = {
  keyword: "키워드",
  metadata: "수집기·기간",
  concept: "항목 이름",
  graph: "관계",
  temporal: "시간",
  wiki: "위키",
  vector: "벡터",
  rerank: "합치기",
};
export const strategyText = (name: string): string => STRATEGY[name] ?? name;

const ROUTE_STATUS: Readonly<Record<string, string>> = {
  used: "사용함",
  skipped: "질문이 부르지 않음",
  off: "꺼져 있음",
  unavailable: "사용할 수 없음",
};
export const routeStatusText = (status: string, reason?: string): string =>
  `${ROUTE_STATUS[status] ?? status}${reason ? `: ${reason}` : ""}`;

export const ANSWER_CANNOT = "답을 만들 수 없음";

/** The answer's state in words; `null` when there is nothing to say (an answer was not asked for, or it is coming). */
export function answerText(status: string, reason: string | null): string | null {
  switch (status) {
    case "started":
      return null;
    case "none":
      return reason === "insufficient" ? ASK_INSUFFICIENT : null;
    case "blocked":
      return `${ANSWER_CANNOT}: ${blockReasonText(reason ?? "")}`;
    case "failed":
      return `답을 만들지 못했습니다: ${reason ?? ""}`;
    case "cancelled":
      return ASK_CANCELLED;
    default:
      return status;
  }
}

export const droppedText = (n: number): string =>
  `원문에서 인용을 확인하지 못해 버린 문장이 ${n}개 있습니다.`;
export const failureText = (code: string): string => `질문을 처리하지 못했습니다: ${code}`;
export const sourceFailureText = (reason: string): string =>
  `원본을 불러오지 못했습니다: ${reason}`;
