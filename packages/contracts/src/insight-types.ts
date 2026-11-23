// The 13 Insight types (P01-R1): one table says which are supported, who judges them and why the
// rest are not. A type that is not supported makes no Insight. `impact` and `actionability` are the
// ranking's two per-type axes (P01-R4); the values are provisional constants, not measured (P01-D6).
export const INSIGHT_TYPE_NAMES = [
  "important_change",
  "schedule_conflict",
  "dependency_delay",
  "decision_change",
  "conflict",
  "pending_request",
  "open_issue",
  "similar_resolution",
  "related_document",
  "opportunity",
  "policy_change",
  "new_relation",
  "missed_information",
] as const;
export type InsightTypeName = (typeof INSIGHT_TYPE_NAMES)[number];

export interface InsightTypeInfo {
  type: InsightTypeName;
  /** Korean display name */
  label: string;
  judgedBy: "code" | "llm";
  status: "supported" | "unsupported";
  /** Why the type is unsupported; null when supported. */
  reason: string | null;
  /** 0..100 */
  impact: number;
  /** 0..100 */
  actionability: number;
}

const supported = (
  type: InsightTypeName,
  label: string,
  impact: number,
  actionability: number,
): InsightTypeInfo => ({
  type,
  label,
  judgedBy: "code",
  status: "supported",
  reason: null,
  impact,
  actionability,
});
const unsupported = (
  type: InsightTypeName,
  label: string,
  judgedBy: "code" | "llm",
  reason: string,
): InsightTypeInfo => ({
  type,
  label,
  judgedBy,
  status: "unsupported",
  reason,
  impact: 50,
  actionability: 50,
});

export const INSIGHT_TYPES: readonly InsightTypeInfo[] = [
  supported("important_change", "중요 변경", 60, 40),
  supported("schedule_conflict", "일정 충돌", 70, 70),
  supported("dependency_delay", "의존 업무 지연", 80, 70),
  unsupported(
    "decision_change",
    "의사결정 변경",
    "code",
    "결정의 진술(statement)은 여러 값 종류라 대체 연결이 없다",
  ),
  supported("conflict", "충돌", 60, 80),
  unsupported("pending_request", "미처리 요청", "code", "요청의 상태 종류가 없다"),
  unsupported("open_issue", "미해결 이슈", "code", "이슈의 상태 종류가 없다"),
  unsupported("similar_resolution", "유사 해결", "code", "유사도 검색이 없다"),
  unsupported("related_document", "관련 문서", "code", "검색이 없다"),
  // judged by the interpretation job (P01-T04, D19): supported although it appears only while `insight.interpret` is on
  { ...supported("opportunity", "기회", 50, 50), judgedBy: "llm" },
  unsupported(
    "policy_change",
    "정책 변화",
    "code",
    "업무 규칙의 진술은 여러 값 종류라 대체 연결이 없다",
  ),
  unsupported("new_relation", "새 관계", "code", "최근에 처음 관측된 관계를 가려내는 판정이 없다"),
  unsupported("missed_information", "놓친 정보", "code", "열람·피드백 기록이 없다"),
];

export const insightType = (name: string): InsightTypeInfo | undefined =>
  INSIGHT_TYPES.find((t) => t.type === name);
