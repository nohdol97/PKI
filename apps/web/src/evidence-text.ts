// Words and span cutting for the evidence screens (V02-R14, R15; spec "T10이 넘기는 것" 3, 4).
import type { InsightSummary, NativeLocator } from "@pki/contracts";

/** The label of each epistemic type an Insight can have: only an inference (V02-R9). */
export const INSIGHT_EPISTEMIC: Record<InsightSummary["epistemic"], string> = { inferred: "추론" };

/** Provisional wording: an Insight is never shown as a confirmed fact (V02-C2). */
export const INSIGHT_NOT_CONFIRMED = "규칙이 근거에서 이끌어 낸 추론이며 확정 사실이 아닙니다.";

/** Who wrote an Insight's reason text (P01-R13, D31). */
export const REASONING_BY: Record<"code" | "llm", string> = {
  code: "이유(코드 판정)",
  llm: "해석(LLM)",
};

export const AUTO_NOTIFY_EXCLUDED = "자동 알림 제외(신뢰도 낮음)";

/** Provisional wording (P01-R17, D33): the switch is a dark launch, off by default. */
export const INSIGHT_INTERPRET_TEXT =
  "켜면 활성 Insight마다 LLM 해석 작업이 생깁니다. Provider와 전송 동의가 없으면 작업은 대기합니다. 기본은 꺼짐입니다.";

/** "순위 72 · 관련 50 · 영향 80 · 시급 100 · 신규 100 · 신뢰 50 · 행동 70" */
export function rankingText(r: InsightSummary["ranking"]): string {
  return `순위 ${r.score} · 관련 ${r.relevance} · 영향 ${r.impact} · 시급 ${r.urgency} · 신규 ${r.novelty} · 신뢰 ${r.confidence} · 행동 ${r.actionability}`;
}

/** "지원" or "미지원: <reason>" (P01-R16). */
export function typeStatusText(t: {
  status: "supported" | "unsupported";
  reason: string | null;
}): string {
  return t.status === "supported" ? "지원" : `미지원: ${t.reason ?? ""}`;
}

/** "application/pdf, 1024바이트": what the origin system said of an attachment (I02C-R6), shown as it came. */
export function attachmentDetailText(a: { mediaType: string; size: number }): string {
  return `${a.mediaType}, ${a.size}바이트`;
}

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

/**
 * The position table's shapes as words (I02B-R39). Blocks are counted from 0 in the contract; the reader counts
 * from 1, so a docx paragraph and a table's row and cell show one more. A docx memo (`comment`) names its
 * paragraph, then its thread and the entry in it (I02F-R6).
 */
export function locatorText(locator: NativeLocator): string {
  switch (locator.format) {
    case "pdf":
      return `${locator.page}쪽`;
    case "docx": {
      const { table, comment } = locator;
      if (table) return `표 ${table.index + 1}의 ${table.row + 1}행 ${table.cell + 1}열`;
      return comment
        ? `문단 ${locator.paragraph + 1} · 메모 ${comment.thread + 1}의 ${comment.index + 1}번째 글(${comment.part === "head" ? "머리" : "본문"})`
        : `문단 ${locator.paragraph + 1}`;
    }
    case "xlsx": {
      const sheet = `시트 '${locator.sheet}'`;
      if (locator.cell !== undefined) return `${sheet} ${locator.cell} 칸`;
      if (locator.row !== undefined) return `${sheet} ${locator.row}행`;
      if (locator.column !== undefined) return `${sheet} ${locator.column}열`;
      return sheet;
    }
    case "csv":
      return `레코드 ${locator.record} · ${locator.line}번째 줄 · 필드 ${locator.field}`;
    case "html":
      return `${locator.line}번째 줄 (${locator.path})`;
    case "markdown":
    case "txt":
    case "json":
      return `${locator.line}번째 줄`;
  }
}

export const LOCAL_NOT_FOUND_TEXT = "원본 파일을 찾을 수 없음";
export const LOCAL_PAUSED_TEXT = "이 위치는 일시 중지되어 파일을 다시 읽지 않습니다.";
export const REVEAL_FAILED_TEXT = "폴더를 열지 못했습니다. 파일이 옮겨졌거나 지워졌을 수 있습니다.";
