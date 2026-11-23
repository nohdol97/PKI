// The one check before a line is delivered (P02-R7). It stands at every road to the screen's feed and the OS
// channel: the scan before it writes a `sent` line, the return of a deferred line, the outbox before it marks a
// line handed. A line that does not pass is withdrawn by the caller and is never shown.
import { readInsightById, type DerivativeRegistry, type SqlDriver } from "@pki/storage";
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
 * Whether the line may be delivered now: it holds (`insightHolds`) and ③ the Insight is not marked out of
 * automatic notification. Nothing is delivered when it does not.
 */
export function mayDeliver(
  db: SqlDriver,
  registry: Pick<DerivativeRegistry, "visible">,
  line: DeliveryLine,
): boolean {
  if (!insightHolds(db, registry, line)) return false;
  return !isAutoNotifyExcluded(readInsightById(db, line.insightId)?.confidence ?? null);
}
