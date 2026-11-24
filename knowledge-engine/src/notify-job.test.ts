// P02-C1b (job part, R5) and P02-C3a ① (R1, R4): `scan` writes one line per (Insight, changed_at) and keeps
// no text; a rerun, a run that failed before it committed, and a changed Insight leave one line per content.
// `daily` and `weekly` make one line holding a window, none for an empty one.
import {
  insertFinding,
  listNotifications,
  migrate,
  registerConnectorInstance,
  saveInsight,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { notifyNow, NOW, seedInsight } from "./notify.test-support.ts";
import { addItem } from "./wiki.test-support.ts";
import { memoryDbTemplate } from "@pki/testkit";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);

let db: SqlDriver;
beforeEach(() => {
  db = freshDb();
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

const lines = () =>
  listNotifications(db).map((n) => ({
    insight: n.insightId,
    status: n.status,
    reason: n.reason,
    os: n.osState,
  }));

describe("notify.job scan: the decision of each Insight, written once and without text (P02-C1b, C3a ①)", () => {
  it("sends the important one (OS channel queued) and sends the others to the digest with the reason", () => {
    const high = seedInsight(db, { name: "높음" });
    const low = seedInsight(db, { name: "낮음", confidence: 30 });
    const quiet = seedInsight(db, { name: "미달", urgencyDate: null, confidence: 60 });

    const { counts } = notifyNow(db, "scan");

    expect(lines()).toEqual([
      { insight: high.insightId, status: "sent", reason: null, os: "queued" },
      { insight: low.insightId, status: "digest", reason: "low-confidence", os: "none" },
      { insight: quiet.insightId, status: "digest", reason: "below-threshold", os: "none" },
    ]);
    expect(counts).toMatchObject({ sent: 1, digest: 2, withdrawn: 0 });
    // a line holds ids and codes only: no name, sentence or quote of the Insight (R1)
    expect(JSON.stringify(db.all("SELECT * FROM notifications"))).not.toMatch(/높음|낮음|미달/);
  });

  it("① a rerun, and a run that failed before it committed, leave one line per Insight", () => {
    seedInsight(db, { name: "하나" });
    seedInsight(db, { name: "둘", confidence: 30 });

    notifyNow(db, "scan");
    notifyNow(db, "scan");
    expect(lines()).toHaveLength(2);

    seedInsight(db, { name: "셋" });
    expect(() =>
      db.transaction(() => {
        notifyNow(db, "scan");
        throw new Error("the run died before it committed");
      }),
    ).toThrow();
    expect(lines()).toHaveLength(2);
    notifyNow(db, "scan");
    expect(lines()).toHaveLength(3);
  });

  it("a changed Insight is a new line, and inside 24 hours of an immediate one it goes to the digest only", () => {
    const a = seedInsight(db, { name: "변경" });
    notifyNow(db, "scan");
    saveInsight(db, a.key, {
      state: "active",
      summary: "바뀐 요약",
      evidenceIds: [a.evidenceId],
      confidence: 100,
      urgencyDate: "2026-11-25",
      changedAt: "2026-11-23T10:00:00.000Z",
    });

    notifyNow(db, "scan", "2026-11-23T10:05:00.000Z");

    expect(lines()).toEqual([
      { insight: a.insightId, status: "sent", reason: null, os: "queued" },
      { insight: a.insightId, status: "digest", reason: "repeat", os: "none" },
    ]);
  });
});

describe("notify.job daily and weekly: one line holding a window, none for an empty one (P02-C1b)", () => {
  const digests = () =>
    db.all(
      "SELECT kind, window_start, window_end, status, os_state FROM notifications WHERE kind <> 'insight'",
    );

  it("daily makes a line from the last window's end to now, and a second run with nothing new makes none", () => {
    seedInsight(db, { name: "하나" });
    seedInsight(db, { name: "둘", confidence: 30 });
    notifyNow(db, "scan");

    notifyNow(db, "daily", "2026-11-23T10:00:00.000Z");
    expect(digests()).toEqual([
      {
        kind: "daily",
        window_start: NOW,
        window_end: "2026-11-23T10:00:00.000Z",
        status: "sent",
        os_state: "queued",
      },
    ]);

    notifyNow(db, "daily", "2026-11-24T10:00:00.000Z");
    expect(digests()).toHaveLength(1);
  });

  it("makes no line when the window holds no notification line, and weekly still makes one while a finding is open", () => {
    notifyNow(db, "daily");
    notifyNow(db, "weekly");
    expect(digests()).toEqual([]);

    const item = addItem(db, "Task", "열린 발견의 대상");
    insertFinding(db, {
      rule: "overdue-work",
      target: { kind: "item", a: item, b: null },
      origin: "rule",
      status: "open",
      lineage: [],
      at: NOW,
    });
    notifyNow(db, "daily");
    notifyNow(db, "weekly");
    expect(digests().map((d) => d.kind)).toEqual(["weekly"]);
  });
});
