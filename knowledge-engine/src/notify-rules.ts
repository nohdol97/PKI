// The decision of how a changed Insight is told (P02-R2): a pure function of the Insight's signals, the lines
// already made for it and the time. It calls no Provider and reads no database; the thresholds are constants
// (P02-D2), not measured on use.
import { isAutoNotifyExcluded } from "./insight-rules.ts";
import { rankInsight, type RankingSignals } from "./insight-ranking.ts";
import type { NotificationReason } from "@pki/storage";

/** An Insight whose rank score is below this goes to the digest. */
export const NOTIFY_THRESHOLD = 70;
/** An Insight told immediately is not told immediately again inside this. */
export const NOTIFY_REPEAT_WINDOW_MS = 24 * 3_600_000;
/** How many Insights one `scan` decides. */
export const NOTIFY_SCAN_LIMIT = 200;

export interface NotifySignal extends RankingSignals {
  insightId: number;
}

/** A line already made: whether it told the Insight immediately, and when. */
export interface PastLine {
  insightId: number;
  immediate: boolean;
  /** ISO time */
  at: string;
}

export type NotifyDecision = { status: "sent" } | { status: "digest"; reason: NotificationReason };

export function decideNotification(
  signal: NotifySignal,
  past: readonly PastLine[],
  now: Date,
): NotifyDecision {
  if (isAutoNotifyExcluded(signal.confidence))
    return { status: "digest", reason: "low-confidence" };
  if (rankInsight(signal, now).score < NOTIFY_THRESHOLD) {
    return { status: "digest", reason: "below-threshold" };
  }
  const since = now.getTime() - NOTIFY_REPEAT_WINDOW_MS;
  if (
    past.some((l) => l.insightId === signal.insightId && l.immediate && Date.parse(l.at) >= since)
  ) {
    return { status: "digest", reason: "repeat" };
  }
  return { status: "sent" };
}
