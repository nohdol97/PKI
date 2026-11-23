// S03-T07 `conflict.fixtures` (S03-R9, C2; X-C5): the four conflicts the issue names, through the real
// extraction of the synthetic metric pages (fixtures/s03-analytical.jsonl). A base page gives a Metric its
// calculation, unit, currency, period and version and says it is measured on a Dataset; a one-line page gives
// the same Metric another unit, currency, period or version. Both values stay as rows (nothing picks one), the
// conflict read names the other row, and the user's approval of the Metric's calculation is refused with
// `spec-conflict` while every other condition holds; after the user rejects one value it passes. The table's
// binding and its passing check lines are seeded (the jobs that write them are tested in T04 and T05). All
// data is synthetic.
import { createBroker, createUserActionLedger } from "@pki/providers";
import {
  closeJob,
  dataChecksUnmet,
  findSourceVersionId,
  insertItem,
  leaseNextJob,
  migrate,
  otherValidValues,
  registerConnectorInstance,
  registerJob,
  saveCheckLine,
  saveDatasetTable,
  saveSourceRecord,
  userDecisions,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { csvVersion, FakeProvider, fixtureExtraction } from "@pki/testkit";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExtractHandler } from "./extraction.ts";
import { knowledgeCandidates } from "./linking.ts";

const T0 = new Date("2026-11-23T00:00:00.000Z");
let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "imported", "jsonl-import");
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

const records = readFileSync(
  resolve(import.meta.dirname, "../../fixtures/s03-analytical.jsonl"),
  "utf8",
)
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as { id: string; external_id: string; title: string; content: string });

/** Imports a fixture record and runs its extract job once, through the real Broker and the fixture double. */
async function importRecord(id: string) {
  const record = records.find((r) => r.id === id);
  if (!record) throw new Error(`no record ${id}`);
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

/** The Dataset the base page names, bound to a stored table version whose checks passed. */
function boundTable() {
  const v = csvVersion([
    ["매출액", "지역"],
    ["10", "서울"],
  ]);
  const saved = saveSourceRecord(db, "c1", {
    namespace: "",
    externalId: "sales-table",
    title: "sales-table",
    body: v.body,
    blocks: v.blocks,
  } as Parameters<typeof saveSourceRecord>[2]);
  if (saved.status !== "created") throw new Error("not stored");
  const dataset = insertItem(db, {
    type: "Dataset",
    name: "월별 매출표",
    epistemic: "explicit",
    status: "candidate",
    validAt: null,
    observedAt: T0.toISOString(),
  });
  saveDatasetTable(db, { itemId: dataset, sourceId: saved.sourceId, key: "", rowCount: 1 });
  return findSourceVersionId(db, saved.sourceId, saved.version) as number;
}
const factId = (kind: string, rival: boolean) =>
  db.all("SELECT id FROM facts WHERE kind = ? ORDER BY id", [kind])[rival ? 1 : 0]?.id as number;

describe("conflict.fixtures", () => {
  it.each([
    ["unit", "metric.unit", "wiki-s03-0002"],
    ["currency", "metric.currency", "wiki-s03-0003"],
    ["period", "metric.period", "wiki-s03-0004"],
    ["version", "metric.version", "wiki-s03-0005"],
  ])(
    "%s: both values stay, the conflict names the other, the approval is refused with spec-conflict only, and passes once one value is rejected",
    async (_name, kind, rivalRecord) => {
      const tableVersion = boundTable();
      await importRecord("wiki-s03-0001");
      const calc = factId("metric.calculation", false);
      for (const check of ["schema", "aggregation"] as const) {
        saveCheckLine(db, {
          factId: calc,
          check,
          passed: true,
          failure: null,
          examined: 1,
          violations: 0,
          skipped: 0,
          versionId: tableVersion,
          otherVersionId: null,
          at: T0.toISOString(),
        });
      }
      // before the rival page every other condition holds
      expect(dataChecksUnmet(db, { kind: "fact", id: calc })).toEqual([]);

      await importRecord(rivalRecord);
      const [first, second] = [factId(kind, false), factId(kind, true)];
      expect(db.all("SELECT id FROM facts WHERE kind = ?", [kind])).toHaveLength(2);
      expect(otherValidValues(db, first, "item")).toEqual([second]);
      expect(otherValidValues(db, second, "item")).toEqual([first]);

      expect(userDecisions.decide(db, { kind: "fact", id: calc }, "approve")).toEqual({
        status: "refused",
        reason: "data-check-unmet",
        unmet: ["spec-conflict"],
      });
      expect(userDecisions.decide(db, { kind: "fact", id: second }, "reject").status).toBe(
        "applied",
      );
      expect(userDecisions.decide(db, { kind: "fact", id: calc }, "approve").status).toBe(
        "applied",
      );
    },
  );
});
