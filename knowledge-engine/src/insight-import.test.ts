// P01-T05 `insight.import` (P01-C1a, import path): fixtures/p01-status.jsonl through the real extraction (the
// fixture double, the real Broker, SQLite): the status and target date of a Request and the status of an Issue
// are written as candidates, and the Insight rules the extraction runs give exactly one `pending_request` and
// one `open_issue`, with the fact lines and quotes fixtures/p01-expected.json states. All data is synthetic.
import { createBroker, createUserActionLedger } from "@pki/providers";
import {
  closeJob,
  leaseNextJob,
  migrate,
  readInsight,
  registerConnectorInstance,
  registerJob,
  saveSourceRecord,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { FakeProvider, fixtureExtraction } from "@pki/testkit";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExtractHandler } from "./extraction.ts";
import { knowledgeCandidates } from "./linking.ts";

const T0 = new Date("2026-11-23T00:00:00.000Z");
const fixtures = (name: string) => resolve(import.meta.dirname, "../../fixtures", name);
const records = readFileSync(fixtures("p01-status.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as { id: string; external_id: string; title: string; content: string });
interface ExpectedInsight {
  rule: string;
  x: string;
  y: string;
  evidence: { quote: string }[];
}
const expected = JSON.parse(readFileSync(fixtures("p01-expected.json"), "utf8")) as {
  entities: Record<string, { name: string }>;
  sets: { base: { insights: ExpectedInsight[] } };
};

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "imported", "jsonl-import");
});
afterEach(() => db.close());

async function importRecord(record: (typeof records)[number]) {
  const provider = new FakeProvider({ answer: fixtureExtraction() });
  const broker = createBroker({
    db,
    provider: () => provider,
    userActions: createUserActionLedger().redeemer,
    candidates: knowledgeCandidates(db),
    egress: { decide: () => ({ allowed: true, destination: "fake", policyVersion: "pv" }) },
    execution: { decide: () => ({ run: true }) },
    recorder: {
      record: () => undefined,
      begin: () => () => undefined,
      attemptTimes: () => [],
      interruptStarted: () => 0,
    },
    clock: { now: () => 0, sleep: async () => undefined },
  });
  db.transaction(() => {
    const saved = saveSourceRecord(db, "imported", {
      externalId: record.external_id,
      title: record.title,
      body: record.content,
    });
    if (saved.status !== "created") throw new Error("expected a new version");
    registerJob(db, {
      kind: "extract",
      sourceId: saved.sourceId,
      fenceVersion: saved.version,
      at: T0,
    });
  });
  const job = leaseNextJob(db, { kinds: ["extract"], now: T0, leaseMs: 60_000 });
  if (!job) throw new Error("no job");
  const handler = createExtractHandler({ db, now: () => T0 });
  const result = await handler(job, { broker: { call: (raw) => broker.call(raw) } });
  if (result.status !== "succeeded") throw new Error(result.status);
  closeJob(db, job, result);
}

describe("insight.import: fixtures/p01-status.jsonl", () => {
  it("gives one pending_request and one open_issue, each citing the quotes the fixture states", async () => {
    for (const record of records) await importRecord(record);
    const active = db.all(
      "SELECT rule, x_item_id, y_item_id FROM insights WHERE state = 'active' ORDER BY rule",
    );
    expect(active.map((r) => r.rule)).toEqual(["open_issue", "pending_request"]);
    for (const want of expected.sets.base.insights) {
      const name = expected.entities[want.x]?.name as string;
      const item = db.all("SELECT id FROM items WHERE name = ?", [name])[0]?.id as number;
      const insight = readInsight(db, { rule: want.rule, xItemId: item, yItemId: item });
      expect(insight?.state).toBe("active");
      const quotes = (insight?.evidenceIds ?? []).map(
        (id) => db.all("SELECT quote FROM evidence WHERE id = ?", [id])[0]?.quote as string,
      );
      expect(quotes.sort()).toEqual(want.evidence.map((e) => e.quote).sort());
    }
    const request = db.all("SELECT id FROM items WHERE type = 'Request'")[0]?.id as number;
    expect(
      readInsight(db, { rule: "pending_request", xItemId: request, yItemId: request })?.urgencyDate,
    ).toBe("2026-12-10");
  });
});
