// P02-C3b ①② (R7): `mayDeliver` is the one check before a line is delivered. After the decision, an Insight that
// no longer holds, or changed, or whose source was deleted, sends nothing and leaves no sent line; a scope
// policy that refuses the purpose `notify` makes the line `withdrawn` and sends nothing. Mutation evidence:
// remove the active/changed check and ① goes red; remove the scope check and ② goes red.
import { createProductRegistry, derivativeRegistry } from "@pki/knowledge-engine";
import {
  defaultScopePolicy,
  listNotifications,
  migrate,
  registerConnectorInstance,
  saveInsight,
  type ScopePolicy,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { seedLegacyTombstone } from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeChannel, NOW, notifyNow, seedInsight } from "./notify.test-support.ts";
import { createNotifyOutbox } from "./notify-outbox.ts";

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

const AT = "2026-11-23T12:00:00.000Z";
const flush = (registry = derivativeRegistry) => {
  const { channel, sent } = fakeChannel();
  createNotifyOutbox({ db, registry, channel, now: () => new Date(AT), zone: () => "UTC" }).flush();
  return sent;
};
const states = () => listNotifications(db).map((n) => `${n.status}/${n.osState}`);

describe("notify.gate ①: the Insight is deleted, no longer holds or changed after the decision", () => {
  it("an Insight resolved after the decision sends nothing and its line is withdrawn", () => {
    const a = seedInsight(db, { name: "하나" });
    notifyNow(db, "scan", AT);
    expect(states()).toEqual(["sent/queued"]);

    saveInsight(db, a.key, { state: "resolved" });

    expect(flush()).toEqual([]);
    expect(states()).toEqual(["withdrawn/cancelled"]);
  });

  it("an Insight whose content changed after the decision sends nothing: the new content is a new line", () => {
    const a = seedInsight(db, { name: "하나" });
    notifyNow(db, "scan", AT);

    saveInsight(db, a.key, {
      state: "active",
      summary: "바뀐 요약",
      evidenceIds: [a.evidenceId],
      confidence: 100,
      urgencyDate: "2026-11-25",
      changedAt: "2026-11-23T11:00:00.000Z",
    });

    expect(flush()).toEqual([]);
    expect(states()).toEqual(["withdrawn/cancelled"]);
  });

  it("the source the Insight rested on deleted between the decision and the send: no message, no sent line", () => {
    const a = seedInsight(db, { name: "하나" });
    notifyNow(db, "scan", AT);

    db.transaction(() => {
      seedLegacyTombstone(db, {
        sourceId: a.sourceId,
        version: a.version,
        at: NOW,
        reason: "source-deleted",
      });
      derivativeRegistry.propagate(db, {
        kind: "source-deleted",
        sourceId: a.sourceId,
        coversVersion: a.version,
        lastRevision: null,
      });
    });

    expect(flush()).toEqual([]);
    expect(listNotifications(db).filter((n) => n.status === "sent")).toEqual([]);
  });
});

describe("notify.gate ②: a scope policy that refuses the purpose notify", () => {
  const refusing: ScopePolicy = {
    ...defaultScopePolicy,
    allows: (scopes, purpose) => purpose !== "notify" && defaultScopePolicy.allows(scopes, purpose),
  };

  it("makes the line withdrawn at the scan and sends no message", () => {
    seedInsight(db, { name: "하나" });
    const registry = createProductRegistry({ policy: refusing });

    notifyNow(db, "scan", AT, { registry });

    expect(states()).toEqual(["withdrawn/none"]);
    expect(flush(registry)).toEqual([]);
  });

  it("withdraws a line the policy turned against after the decision, before the message goes", () => {
    seedInsight(db, { name: "하나" });
    notifyNow(db, "scan", AT);
    expect(states()).toEqual(["sent/queued"]);

    expect(flush(createProductRegistry({ policy: refusing }))).toEqual([]);
    expect(states()).toEqual(["withdrawn/cancelled"]);
  });
});
