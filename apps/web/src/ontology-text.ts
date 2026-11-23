// Words for the 유형 정의 screen (X02B-R11). The API sends codes and counts; each code gets a fixed Korean text.
// The refusal record is exhaustive over the contract's list, so a code added there fails the typecheck here until
// it has words. Names and type lists are imported text and are drawn by the screen inside <bdi> only.
import {
  DATA_CHECK_NAMES,
  FACT_VALUE_TYPES,
  ONTOLOGY_REFUSALS,
  type OntologyChangeRequest,
  type RouteResponse,
} from "@pki/contracts";

type Element = RouteResponse<"ontology">["elements"][number];
type Outcome = RouteResponse<"ontologyChange">;
type Check = RouteResponse<"ontologyCheck">;
type History = RouteResponse<"ontologyHistory">["lines"][number];
type Refusal = (typeof ONTOLOGY_REFUSALS)[number];
export type ElementKind = Element["elementKind"];

export const ONTOLOGY_INTRO =
  "항목 종류·사실 종류·관계 종류와 그 규칙을 봅니다. 더하거나 고치기 전에 미리 확인해 영향을 볼 수 있습니다.";
export const ONTOLOGY_LOADING = "유형 정의를 불러오는 중입니다.";
export const ONTOLOGY_EMPTY = "정의가 없습니다.";
export const ONTOLOGY_HISTORY_EMPTY = "이력이 없습니다.";
export const ONTOLOGY_HISTORY_LOADING = "이력을 불러오는 중입니다.";

export const KIND_ORDER: readonly ElementKind[] = ["item-type", "fact-kind", "relation-type"];
export const KIND_TEXT: Record<ElementKind, string> = {
  "item-type": "항목 종류",
  "fact-kind": "사실 종류",
  "relation-type": "관계 종류",
};
export const STATUS_TEXT: Record<Element["status"], string> = {
  candidate: "후보",
  verified: "확정",
  disputed: "이의 있음",
  superseded: "대체됨",
  rejected: "기각",
};
export const ORIGIN_TEXT: Record<Element["origin"], string> = {
  seed: "기본 제공",
  user: "사용자",
  "source-proposed": "원본이 제안",
};
export const ACTOR_TEXT: Record<History["actor"], string> = {
  user: "사용자",
  extraction: "추출",
  propagation: "전파",
  policy: "정책",
};
export const CARDINALITY_TEXT = { one: "하나", many: "여러 개" } as const;
export const VALUE_TYPES: readonly string[] = FACT_VALUE_TYPES;
export const DATA_CHECKS: readonly string[] = DATA_CHECK_NAMES;

export const REFUSAL_TEXT: Record<Refusal, string> = {
  duplicate: "같은 이름의 정의가 이미 있습니다.",
  "schema-invalid": "규칙의 모양이 맞지 않습니다.",
  "existing-data-violation": "이미 저장된 지식이 이 규칙에 어긋납니다.",
  "basis-required": "근거가 있어야 승인할 수 있습니다.",
  "invalid-transition": "지금 상태에서는 할 수 없는 조치입니다.",
  "not-found": "찾을 수 없는 정의입니다.",
  "not-latest": "최신 근거가 아니라서 승인할 수 없습니다.",
  "nothing-to-undo": "되돌릴 사용자 조치가 없습니다.",
};

/** The rule in a line: what the user reads instead of the rule's JSON. Type names are imported text. */
export function ruleSummary(rule: Element["rule"]): string {
  if (rule.elementKind === "item-type") return "항목 종류";
  if (rule.elementKind === "fact-kind")
    return `값 형식 ${rule.valueType} · 적용 항목 ${rule.itemTypes.join(", ") || "제한 없음"} · ${CARDINALITY_TEXT[rule.cardinality]}${
      rule.dataChecks?.length ? ` · 데이터 점검 ${rule.dataChecks.join(", ")}` : ""
    }`;
  return `주어 ${rule.subjectTypes.join(", ") || "제한 없음"} → 대상 ${rule.objectTypes.join(", ") || "제한 없음"}${
    rule.symmetric ? " · 대칭" : ""
  }`;
}

/** A refusal in words, with the counts that explain it (never a bare code). */
export function outcomeRefusalText(outcome: Outcome): string | undefined {
  if (outcome.status !== "refused" || outcome.reason === undefined) return undefined;
  const parts = [REFUSAL_TEXT[outcome.reason]];
  if (outcome.duplicates) parts.push(`겹치는 정의 ${outcome.duplicates}개`);
  if (outcome.schemaErrors?.length) parts.push(`규칙 오류: ${outcome.schemaErrors.join(", ")}`);
  if (
    outcome.impact &&
    (outcome.impact.violations > 0 || outcome.reason === "existing-data-violation")
  )
    parts.push(
      `영향: 남은 줄 ${outcome.impact.liveRows}개 중 어긋남 ${outcome.impact.violations}개`,
    );
  return parts.join(" · ");
}

export const checkText = (check: Check): string =>
  [
    `겹치는 정의 ${check.duplicates}개`,
    `규칙 오류 ${check.schemaErrors.length}개${check.schemaErrors.length ? `(${check.schemaErrors.join(", ")})` : ""}`,
    `영향: 남은 줄 ${check.impact.liveRows}개, 어긋남 ${check.impact.violations}개`,
    check.applicable ? "적용할 수 있습니다." : "이대로는 적용할 수 없습니다.",
  ].join(" · ");

export interface Draft {
  mode: "add" | "change-rule";
  name: string;
  elementKind: ElementKind;
  itemTypes: string;
  valueType: string;
  cardinality: "one" | "many";
  subjectTypes: string;
  objectTypes: string;
  symmetric: boolean;
  /** Not editable here: sent back as it was stored (X02B-D10). */
  dataChecks: readonly string[] | undefined;
}
export const EMPTY_DRAFT: Draft = {
  mode: "add",
  name: "",
  elementKind: "fact-kind",
  itemTypes: "",
  valueType: "text",
  cardinality: "one",
  subjectTypes: "",
  objectTypes: "",
  symmetric: false,
  dataChecks: undefined,
};

const list = (text: string) =>
  text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

/** The edit form of a stored definition: its rule's values, its `dataChecks` kept as they are. */
export const draftOf = (e: Element): Draft => ({
  ...EMPTY_DRAFT,
  mode: "change-rule",
  name: e.name,
  elementKind: e.elementKind,
  ...(e.rule.elementKind === "fact-kind"
    ? {
        itemTypes: e.rule.itemTypes.join(", "),
        valueType: e.rule.valueType,
        cardinality: e.rule.cardinality,
        dataChecks: e.rule.dataChecks,
      }
    : {}),
  ...(e.rule.elementKind === "relation-type"
    ? {
        subjectTypes: e.rule.subjectTypes.join(", "),
        objectTypes: e.rule.objectTypes.join(", "),
        symmetric: e.rule.symmetric,
      }
    : {}),
});

/** The request an add/edit form stands for; the same request is checked and applied. */
export function changeOf(d: Draft): OntologyChangeRequest {
  const rule: Extract<OntologyChangeRequest["rule"], object> =
    d.elementKind === "item-type"
      ? { elementKind: "item-type" }
      : d.elementKind === "fact-kind"
        ? {
            elementKind: "fact-kind",
            itemTypes: list(d.itemTypes),
            valueType: d.valueType as (typeof FACT_VALUE_TYPES)[number],
            cardinality: d.cardinality,
            ...(d.dataChecks
              ? { dataChecks: [...d.dataChecks] as (typeof DATA_CHECK_NAMES)[number][] }
              : {}),
          }
        : {
            elementKind: "relation-type",
            subjectTypes: list(d.subjectTypes),
            objectTypes: list(d.objectTypes),
            symmetric: d.symmetric,
          };
  return d.mode === "add"
    ? { op: "add", name: d.name.trim(), rule }
    : { op: "change-rule", name: d.name.trim(), elementKind: d.elementKind, rule };
}
