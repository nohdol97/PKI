// Test-build-only seed (P02-T2): three synthetic Insights on three synthetic sources — two important ones (a date two
// days out, full confidence) and one of low confidence — then the notification scan and the daily digest, so the
// 알림 screen has lines to show. Run with `node` before an E2E starts the backend on that directory:
//   node backend/src/p02-seed.e2e.ts --data-dir DIR
// It adds no switch to the backend process; the `.e2e.ts` name keeps it a test module (product code cannot import it).
import { registerConnectorInstance } from "@pki/storage";
import { parseArgs } from "node:util";
import { openCanonicalDb } from "./composition.ts";
import { notifyNow, seedInsight } from "./notify.test-support.ts";

export const SEEDED = {
  first: "마감 임박 업무 가",
  second: "마감 임박 업무 나",
  weak: "낮은 신뢰 추정",
} as const;

if (import.meta.main) {
  const { values } = parseArgs({ options: { "data-dir": { type: "string" } } });
  const dir = values["data-dir"];
  if (!dir) throw new Error("--data-dir is required");
  const db = openCanonicalDb(dir);
  try {
    registerConnectorInstance(db, "c1", "test-fixtures");
    const now = new Date();
    const soon = new Date(now.getTime() + 2 * 86_400_000).toISOString().slice(0, 10);
    const changedAt = now.toISOString();
    seedInsight(db, { name: SEEDED.first, urgencyDate: soon, changedAt });
    seedInsight(db, { name: SEEDED.second, urgencyDate: soon, changedAt });
    seedInsight(db, { name: SEEDED.weak, confidence: 30, urgencyDate: soon, changedAt });
    notifyNow(db, "scan", changedAt);
    notifyNow(db, "daily", new Date(now.getTime() + 60_000).toISOString());
  } finally {
    db.close();
  }
}
