// The derivative kind `notification` (P02-R13, P02-D6): layer delivery, run in the canonical transaction after
// the Insight kinds. A line's lineage is its Insight's; a digest line holds a time window only and has none. In
// the transaction that deletes a source (or prunes its earlier versions) every line whose Insight rests on a
// version it takes is looked at again after the Insight layer has rewritten the Insights: a line whose Insight is
// gone went with it (foreign key), one whose Insight no longer holds or changed is withdrawn, so it is never
// shown or delivered. A scope change or a new version takes nothing here: the read gate and the check before a
// delivery (notify-gate.ts) judge a line against what the Insight is when it is read or sent.
import {
  readInsightById,
  readNotification,
  withdrawNotification,
  type Affected,
  type DerivativeKind,
  type DerivedRef,
  type SourceChange,
  type SourceVersionRef,
  type SqlDriver,
} from "@pki/storage";

export const NOTIFICATION_KIND_NAME = "notification";

const takes = (change: SourceChange): { below: number } | "all" | undefined => {
  if (change.kind === "new-version" || change.kind === "scope-changed") return undefined;
  if (change.kind === "old-versions-pruned") return { below: change.version };
  return "all";
};

/**
 * `insightLineage` is the lineage of an Insight (the `insight` kind's): the registry builds this kind with it,
 * because the canonical kinds module that owns it imports this one.
 */
export function createNotificationKind(
  insightLineage: (db: SqlDriver, insightId: number) => SourceVersionRef[],
): DerivativeKind {
  const lineageOfLine = (db: SqlDriver, id: number): SourceVersionRef[] => {
    const insightId = readNotification(db, id)?.insightId;
    return insightId === null || insightId === undefined ? [] : insightLineage(db, insightId);
  };
  return {
    kind: NOTIFICATION_KIND_NAME,
    layer: "delivery",
    references: [],
    storage: "canonical",
    dataPaths: [],
    affected: (tx: SqlDriver, change: SourceChange): Affected => {
      const mode = takes(change);
      if (mode === undefined) return [];
      return tx
        .all(
          "SELECT id FROM notifications WHERE insight_id IS NOT NULL AND status <> 'withdrawn' ORDER BY id",
        )
        .flatMap((r) => {
          const lineage = lineageOfLine(tx, r.id as number);
          const hit = lineage.some(
            (v) => v.sourceId === change.sourceId && (mode === "all" || v.version < mode.below),
          );
          return hit ? [{ ref: { kind: NOTIFICATION_KIND_NAME, id: String(r.id) }, lineage }] : [];
        });
    },
    lineage: (db: SqlDriver, ref: DerivedRef) => lineageOfLine(db, Number(ref.id)),
    invalidate: (ctx, snapshot) => {
      const { tx } = ctx;
      let removed = 0;
      let recomputed = 0;
      for (const { ref } of snapshot) {
        const line = readNotification(tx, Number(ref.id));
        if (!line) {
          removed++;
          continue;
        }
        const insight = readInsightById(tx, line.insightId as number);
        const holds =
          insight?.state === "active" && (insight.changedAt ?? "") === line.insightChangedAt;
        if (!holds && withdrawNotification(tx, line.id)) recomputed++;
      }
      return { removed, recomputed };
    },
  };
}
