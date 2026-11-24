// The words of the 알림 screen (P02-R15). The Insight's own words come from the backend; these are the
// screen's labels and the way each line was told. A reason code is a code, never a sentence of the source.
import type { NotificationLine, NotificationReason } from "@pki/contracts";

export const NOTIFICATIONS_NOT_FACT =
  "알림은 규칙이 찾은 추론의 변화를 알리는 것이며 확정 사실이 아닙니다.";
export const FEED_ALWAYS = "피드는 이 설정과 상관없이 계속 쌓입니다.";
export const FEED_EMPTY = "지금 볼 알림이 없습니다.";
export const DIGEST_EMPTY = "받은 요약이 없습니다.";
export const TIMELINE_EMPTY = "아직 알림 기록이 없습니다.";
export const DIGEST_LINES_EMPTY = "이 구간에 보여 줄 알림이 없습니다.";

export const TABS = { feed: "피드", digest: "요약", timeline: "타임라인" } as const;
export type Tab = keyof typeof TABS;

const REASON: Record<NotificationReason, string> = {
  "low-confidence": "신뢰도 낮음",
  "below-threshold": "중요도 기준에 못 미침",
  repeat: "24시간 안에 이미 알림",
  muted: "다시 알리지 않기로 함",
};
export const reasonText = (reason: NotificationReason): string => REASON[reason];

export const DIGEST_KIND = { daily: "매일 요약", weekly: "주간 지식 리포트" } as const;

/** The three times a line can be put off, as the API's closed list gives them. */
export const SNOOZES = [
  { minutes: 60, label: "1시간" },
  { minutes: 240, label: "4시간" },
  { minutes: 1440, label: "하루" },
] as const;

export const dateText = (iso: string): string => new Date(iso).toLocaleDateString("ko-KR");
export const timeText = (iso: string): string =>
  new Date(iso).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });

/** How the line was told, for the timeline and the digest (P02-R15). */
export function wayText(line: Pick<NotificationLine, "status" | "reason" | "notBefore">): string {
  switch (line.status) {
    case "sent":
      return "즉시 알림";
    case "digest":
      return line.reason === null ? "요약으로만" : `요약으로만 · ${reasonText(line.reason)}`;
    case "deferred":
      return line.notBefore === null
        ? "다시 알림 예정"
        : `다시 알림 예정 · ${timeText(line.notBefore)}`;
    default:
      return "닫음";
  }
}
