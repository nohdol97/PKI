// The one check before a line is delivered (P02-R7). It stands at every road to the screen's feed and the OS
// channel: the scan before it writes a `sent` line, the return of a deferred line, the outbox before it marks a
// line handed. A line that does not pass is withdrawn by the caller and is never shown.
import type { FeedbackTarget } from "@pki/contracts";
import {
  preferenceSignals,
  readInsightById,
  type DerivativeRegistry,
  type SqlDriver,
} from "@pki/storage";
import { isAutoNotifyExcluded } from "./insight-rules.ts";

/** What of a line the check reads: the Insight it was made for, as it was. */
export interface DeliveryLine {
  insightId: number;
  /** The Insight's `changed_at` when the line was made ("" when it had none). */
  insightChangedAt: string | null;
}

/**
 * ① The line's Insight is active and has the content the line was made for, and ② the registry's scope policy
 * allows it for the purpose `notify`. What a digest line is counted and shown by: a line that went to the digest
 * because its confidence is low is still one of the day's changes. A registry that cannot judge throws.
 */
export function insightHolds(
  db: SqlDriver,
  registry: Pick<DerivativeRegistry, "visible">,
  line: DeliveryLine,
): boolean {
  const insight = readInsightById(db, line.insightId);
  if (insight?.state !== "active" || (insight.changedAt ?? "") !== (line.insightChangedAt ?? "")) {
    return false;
  }
  return registry
    .visible(db, [{ kind: "insight", id: String(line.insightId) }], "notify")
    .some((r) => r.id === String(line.insightId));
}

/**
 * What the user's feedback says of the Insight (P03-R7), read for the purpose `notify`: a target the registry
 * does not show for it counts for nothing.
 */
export function insightPreference(
  db: SqlDriver,
  registry: Pick<DerivativeRegistry, "visible">,
  insightId: number,
): { hidden: boolean; muted: boolean } {
  const usable = (t: FeedbackTarget) =>
    registry.visible(db, [{ kind: t.kind, id: String(t.id) }], "notify").length === 1;
  const signal = preferenceSignals(db, [{ kind: "insight", id: insightId }], { usable })[0];
  return { hidden: signal?.hidden ?? false, muted: signal?.muted ?? false };
}

/** Whether a line is shown at all: it holds and the user did not hide the Insight (digest counts, unread count). */
export const lineShown = (
  db: SqlDriver,
  registry: Pick<DerivativeRegistry, "visible">,
  line: DeliveryLine,
): boolean =>
  insightHolds(db, registry, line) && !insightPreference(db, registry, line.insightId).hidden;

export type DeliveryVerdict = "ok" | "digest" | "withdraw";

/**
 * The one check before a line is delivered: `ok` when it holds (`insightHolds`), the user neither hid nor muted
 * the Insight (P03) and it is not marked out of automatic notification; `digest` when it holds and is merely
 * muted (told in the digest only); `withdraw` otherwise. The caller acts on the answer.
 */
export function deliveryVerdict(
  db: SqlDriver,
  registry: Pick<DerivativeRegistry, "visible">,
  line: DeliveryLine,
): DeliveryVerdict {
  if (!insightHolds(db, registry, line)) return "withdraw";
  const preference = insightPreference(db, registry, line.insightId);
  if (preference.hidden) return "withdraw";
  if (preference.muted) return "digest";
  return isAutoNotifyExcluded(readInsightById(db, line.insightId)?.confidence ?? null)
    ? "withdraw"
    : "ok";
}

/** Whether the line may be delivered now (`deliveryVerdict` is `ok`). */
export const mayDeliver = (
  db: SqlDriver,
  registry: Pick<DerivativeRegistry, "visible">,
  line: DeliveryLine,
): boolean => deliveryVerdict(db, registry, line) === "ok";
