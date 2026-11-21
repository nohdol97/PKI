// Words and span cutting for the evidence screens (V02-R14, R15; spec "T10이 넘기는 것" 3, 4).
import type { InsightSummary } from "@pki/contracts";

/** The label of each epistemic type an Insight can have: only an inference (V02-R9). */
export const INSIGHT_EPISTEMIC: Record<InsightSummary["epistemic"], string> = { inferred: "추론" };

/** Provisional wording: an Insight is never shown as a confirmed fact (V02-C2). */
export const INSIGHT_NOT_CONFIRMED = "규칙이 근거에서 이끌어 낸 추론이며 확정 사실이 아닙니다.";

export const UNTRUSTED_BADGE = "가져온 자료(신뢰하지 않음)";

/** Provisional wording (spec "T10이 넘기는 것" 7): shown instead of the API's 404 code. */
export const INSIGHT_GONE =
  "이 Insight는 더 이상 표시되지 않습니다. 해소되었거나 근거가 삭제되었습니다.";
export const SOURCE_GONE = "이 근거의 원본은 더 이상 없습니다. 삭제되었을 수 있습니다.";

export const SPAN_UNAVAILABLE = "위치를 표시할 수 없습니다. 본문 전체를 강조 없이 보입니다.";

/** "version N", and the latest when the evidence points to an older version (reachable by evidence id). */
export function evidenceVersionText(v: { version: number; latestVersion: number }): string {
  return v.version === v.latestVersion
    ? `version ${v.version}`
    : `version ${v.version} · 지난 version(최신 ${v.latestVersion})`;
}

/**
 * Cuts `body` at the code point offsets [start, end) — the stored span's unit
 * (spec "T05가 넘기는 것" 12) — so emoji before the quote do not shift it, as
 * UTF-16 string indices would. Undefined when the span is not within the body.
 */
export function splitAtCodePoints(
  body: string,
  start: number,
  end: number,
): { before: string; marked: string; after: string } | undefined {
  const points = Array.from(body);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return undefined;
  if (start < 0 || end < start || end > points.length) return undefined;
  return {
    before: points.slice(0, start).join(""),
    marked: points.slice(start, end).join(""),
    after: points.slice(end).join(""),
  };
}
