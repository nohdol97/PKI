// Test support (a `*.test-support.ts` file: refused in product code by lint and the bundle). Builders for the
// backend's notification tests (P02): an active Insight on one synthetic source, a `notify` run the way the
// runner does it, and a fake shell channel that keeps what it was sent. Not exported from the package.
import { planNotify, type NotifyOptions, type NotifyTarget } from "@pki/knowledge-engine";
import {
  addEvidence,
  commitDerived,
  insertItem,
  saveFact,
  saveInsight,
  saveSourceRecord,
  type SqlDriver,
} from "@pki/storage";
import type { NotifyChannel, NotifyMessage } from "./notify-outbox.ts";

export const NOW = "2026-11-23T09:00:00.000Z";

const attrs = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
} as const;

export interface SeedInsight {
  name: string;
  confidence?: number | null;
  urgencyDate?: string | null;
  changedAt?: string;
}

/** One active Insight on its own source (a dependency delay due in two days, verified, unless told otherwise). */
export function seedInsight(db: SqlDriver, o: SeedInsight) {
  const body = `${o.name}의 본문`;
  const saved = saveSourceRecord(db, "c1", { externalId: o.name, title: `제목 ${o.name}`, body });
  if (saved.status !== "created") throw new Error(saved.status);
  const versionId = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
  const x = insertItem(db, { type: "Task", name: `${o.name}-x`, ...attrs });
  const y = insertItem(db, { type: "Task", name: `${o.name}-y`, ...attrs });
  const fact = saveFact(db, { itemId: x, kind: "memo", value: `${o.name} 값`, ...attrs });
  const evidenceId = addEvidence(db, {
    target: { factId: fact.id },
    sourceVersionId: versionId,
    start: 0,
    end: [...body].length,
    quote: body,
  });
  const key = { rule: "dependency_delay", xItemId: x, yItemId: y };
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
  return { insightId, key, evidenceId, sourceId: saved.sourceId, version: saved.version };
}

/** One `notify` run as the runner does it. */
export function notifyNow(
  db: SqlDriver,
  target: NotifyTarget,
  at: string = NOW,
  options: NotifyOptions = {},
) {
  const plan = planNotify(db, target, new Date(at), options);
  db.transaction(() => commitDerived(db, { source: null, items: plan.items }));
  return plan.counts;
}

/** A shell channel that keeps every message; `onSend` runs before it is kept (a test that cuts the send throws there). */
export function fakeChannel(onSend?: (message: NotifyMessage) => void) {
  const sent: NotifyMessage[] = [];
  const channel: NotifyChannel = {
    send: (message) => {
      onSend?.(message);
      sent.push(message);
    },
  };
  return { channel, sent };
}
