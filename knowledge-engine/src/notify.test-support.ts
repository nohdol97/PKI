// Test support (a `*.test-support.ts` file: refused in product code by lint and the bundle). Builders for the
// notification tests (P02): an active Insight resting on one synthetic source, and a `notify` run the way the
// runner does it (plan, then the result in one commitDerived transaction). Not exported from the package.
import { commitDerived, saveInsight, type SqlDriver } from "@pki/storage";
import { planNotify, type NotifyOptions, type NotifyTarget } from "./notify-job.ts";
import { addFact, addItem, addSource, cite } from "./wiki.test-support.ts";

export const NOW = "2026-11-23T09:00:00.000Z";

export interface SeedInsight {
  /** Names the source, the two items and the text; a fixed canary per Insight. */
  name: string;
  rule?: string;
  /** `undefined` is 100 (a verified row); `null` is none. */
  confidence?: number | null;
  /** `undefined` is two days after NOW, which makes a dependency delay rank above the threshold. */
  urgencyDate?: string | null;
  changedAt?: string;
}

/** One active Insight on its own source; the ids the tests name. */
export function seedInsight(db: SqlDriver, o: SeedInsight) {
  const source = addSource(db, o.name, `${o.name}의 본문`);
  const x = addItem(db, "Task", `${o.name}-x`);
  const y = addItem(db, "Task", `${o.name}-y`);
  const evidenceId = cite(db, { factId: addFact(db, x, "memo", `${o.name} 값`) }, source.id);
  const key = { rule: o.rule ?? "dependency_delay", xItemId: x, yItemId: y };
  const insightId = saveInsight(db, key, {
    state: "active",
    summary: `${o.name} 요약`,
    evidenceIds: [evidenceId],
    factLines: [`${o.name} 줄`],
    reasoningSummary: `${o.name} 이유`,
    confidence: o.confidence === undefined ? 100 : o.confidence,
    urgencyDate: o.urgencyDate === undefined ? "2026-11-25" : o.urgencyDate,
    changedAt: o.changedAt ?? NOW,
  });
  return { insightId, key, evidenceId, ...source };
}

/** One `notify` run as the runner does it; the counts it left. */
export function notifyNow(
  db: SqlDriver,
  target: NotifyTarget,
  at: string = NOW,
  options: NotifyOptions = {},
) {
  const plan = planNotify(db, target, new Date(at), options);
  const committed = db.transaction(() => commitDerived(db, { source: null, items: plan.items }));
  return { plan, committed, counts: plan.counts };
}
