// The `notify` job (P02-R3, R4, R5): it finds what to tell and writes lines. It reads the DB only, calls no
// Provider and has no source. `scan` decides every active Insight that has no line for its current content
// (at most NOTIFY_SCAN_LIMIT) and returns the deferred lines whose time has come; `daily` and `weekly` make one
// line holding the window since the last digest, none when the window is empty. The reads, the decisions and the
// writes are one `notification` item of commitDerived, so they see one state and commit with the job.
// A rerun, or a run that failed before it committed, makes no second line: the key of a line is its Insight and
// content (P02-R1), a digest's its kind and window start.
import {
  countInsightLinesIn,
  dueDeferredNotifications,
  firstInsightLineAt,
  immediateLinesSince,
  insertDigestNotification,
  insertInsightNotification,
  lastDigestEnd,
  listFindings,
  readInsightById,
  recordResultCounts,
  returnNotification,
  unnotifiedActiveInsightIds,
  withdrawNotification,
  type DerivedItem,
  type DerivativeRegistry,
  type SqlDriver,
} from "@pki/storage";
import { derivativeRegistry } from "./canonical-kinds.ts";
import { mayDeliver } from "./notify-gate.ts";
import { NOTIFICATION_KIND_NAME } from "./notify-kind.ts";
import { decideNotification, NOTIFY_REPEAT_WINDOW_MS, NOTIFY_SCAN_LIMIT } from "./notify-rules.ts";

export type NotifyTarget = "scan" | "daily" | "weekly";

export interface NotifyOptions {
  /** The registry that judges scopes; default the product's. */
  registry?: Pick<DerivativeRegistry, "visible">;
  /** Insights one scan decides; default NOTIFY_SCAN_LIMIT. */
  limit?: number;
  /** The job the counts are written onto, in the result's transaction. */
  jobId?: number;
}

export interface NotifyPlan {
  items: DerivedItem[];
  /** Filled by the write: what the run did. */
  counts: Record<string, number>;
}

const DAY_MS = 86_400_000;

/** Hands back one `notification` item whose write does the run. */
export function planNotify(
  db: SqlDriver,
  target: NotifyTarget,
  at: Date,
  options: NotifyOptions = {},
): NotifyPlan {
  void db; // the reads happen in the write, inside the committing transaction
  const registry = options.registry ?? derivativeRegistry;
  const counts: Record<string, number> = {};
  const item: DerivedItem = {
    kind: NOTIFICATION_KIND_NAME,
    itemKey: `notify:${target}`,
    lineage: [],
    write: (tx) => {
      Object.assign(
        counts,
        target === "scan"
          ? scan(tx, registry, at, options.limit ?? NOTIFY_SCAN_LIMIT)
          : digest(tx, target, at),
      );
      if (options.jobId !== undefined) recordResultCounts(tx, options.jobId, counts);
    },
  };
  return { items: [item], counts };
}

function scan(
  tx: SqlDriver,
  registry: Pick<DerivativeRegistry, "visible">,
  at: Date,
  limit: number,
): Record<string, number> {
  const now = at.toISOString();
  const counts = { sent: 0, digest: 0, withdrawn: 0, returned: 0 };
  const since = new Date(at.getTime() - NOTIFY_REPEAT_WINDOW_MS).toISOString();
  for (const id of unnotifiedActiveInsightIds(tx, limit)) {
    const insight = readInsightById(tx, id);
    if (insight?.state !== "active") continue;
    const changedAt = insight.changedAt ?? "";
    const decision = decideNotification(
      {
        insightId: id,
        type: insight.rule,
        confidence: insight.confidence,
        urgencyDate: insight.urgencyDate,
        changedAt: insight.changedAt,
        userInputCount: insight.userInputs.length,
        impact: insight.interpretation?.impact ?? null,
        actionability: insight.interpretation?.actionability ?? null,
      },
      immediateLinesSince(tx, id, since),
      at,
    );
    // R7: a line goes to the feed only through the check that stands before every delivery
    const sent =
      decision.status === "sent" &&
      mayDeliver(tx, registry, { insightId: id, insightChangedAt: changedAt });
    const status = decision.status === "digest" ? "digest" : sent ? "sent" : "withdrawn";
    insertInsightNotification(tx, {
      insightId: id,
      changedAt,
      status,
      reason: decision.status === "digest" ? decision.reason : null,
      at: now,
    });
    counts[status]++;
  }
  for (const line of dueDeferredNotifications(tx, now)) {
    const ok = mayDeliver(tx, registry, {
      insightId: line.insightId as number,
      insightChangedAt: line.insightChangedAt,
    });
    if (ok ? returnNotification(tx, line.id) : withdrawNotification(tx, line.id)) {
      counts[ok ? "returned" : "withdrawn"]++;
    }
  }
  return counts;
}

function digest(tx: SqlDriver, kind: "daily" | "weekly", at: Date): Record<string, number> {
  const end = at.toISOString();
  const start =
    lastDigestEnd(tx, kind) ??
    firstInsightLineAt(tx) ??
    new Date(at.getTime() - (kind === "daily" ? 1 : 7) * DAY_MS).toISOString();
  const lines = start < end ? countInsightLinesIn(tx, start, end) : 0;
  // the weekly report also has K02's counts and open findings to show (R5): it is made while any finding is open
  const open = kind === "weekly" && listFindings(tx).some((f) => f.status === "open");
  if (start >= end || (lines === 0 && !open)) return { created: 0 };
  const made = insertDigestNotification(tx, { kind, windowStart: start, windowEnd: end, at: end });
  return { created: made === undefined ? 0 : 1, lines };
}

export interface NotifyHandlerOptions {
  db: SqlDriver;
  now?: () => Date;
  registry?: Pick<DerivativeRegistry, "visible">;
  limit?: number;
}

/** What the handler hands the runner (a subset of backend job-outcomes.ts JobResult). */
export type NotifyResult = { status: "succeeded"; items: readonly DerivedItem[] };

export function createNotifyHandler(options: NotifyHandlerOptions) {
  const { db, registry, limit } = options;
  const now = options.now ?? (() => new Date());
  return async (job: { id: number; target: string }): Promise<NotifyResult> => {
    const target = job.target === "daily" || job.target === "weekly" ? job.target : "scan";
    const plan = planNotify(db, target, now(), {
      jobId: job.id,
      ...(registry ? { registry } : {}),
      ...(limit === undefined ? {} : { limit }),
    });
    return { status: "succeeded", items: plan.items };
  };
}
