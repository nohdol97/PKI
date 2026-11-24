// P01-C2c (R5): the `insight-interpret` task through the real Broker. The answer is strict at every level:
// a key outside the schema or a reason summary over 500 characters fails with `invalid-output`, nothing else is accepted.
import {
  leaseNextJob,
  migrate,
  registerConnectorInstance,
  registerJob,
  saveSourceRecord,
} from "@pki/storage";
import type { SqlDriver } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { FakeProvider, memoryDbTemplate } from "@pki/testkit";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createBroker, type CandidateItem } from "./broker.ts";
import { createUserActionLedger } from "./user-actions.ts";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);

const listed = readFileSync(
  resolve(import.meta.dirname, "../../fixtures/test-connector.jsonl"),
  "utf8",
)
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as { title: string; body: string; malicious?: boolean })
  .find((f) => !f.malicious) as { title: string; body: string };

const valid = {
  reasoningSummary: "합성 요약",
  impact: 60,
  actionability: 40,
  opportunity: null,
};

let db: SqlDriver;
let provider: FakeProvider;
let broker: ReturnType<typeof createBroker>;
const candidates = new Map<string, CandidateItem>();

beforeEach(() => {
  db = freshDb();
  registerConnectorInstance(db, "c1", "test-fixtures");
  provider = new FakeProvider({ answer: () => valid });
  candidates.clear();
  broker = createBroker({
    db,
    provider: () => provider,
    userActions: createUserActionLedger().redeemer,
    candidates: { lookup: (id) => candidates.get(id) },
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
});

let seq = 0;
function store(record: { title: string; body: string }): string {
  saveSourceRecord(db, "c1", { externalId: `ext-${++seq}`, ...record });
  return String(db.all("SELECT max(id) AS id FROM source_versions")[0]?.id);
}

/** A running sourceless job of `kind`, leased: the shape of a page's summary job. */
function running(kind: string): string {
  const r = registerJob(db, { kind, target: `1#${++seq}`, priority: "maintenance" });
  if (!r.registered) throw new Error("expected a new job");
  const leased = leaseNextJob(db, { kinds: [kind], now: new Date(), leaseMs: 60_000 });
  if (!leased) throw new Error("expected a lease");
  return String(leased.id) + ":" + String(leased.leaseToken);
}

const interpret = (ids: string[]) => {
  const [jobId, leaseToken] = running("insight-interpret").split(":") as [string, string];
  return broker.call({
    taskKind: "insight-interpret",
    sourceVersionIds: ids,
    candidateItemIds: ["1"],
    origin: { jobId, leaseToken },
    schemaVersion: 1,
    budget: { timeoutMs: 1000 },
    retryable: false,
  });
};

describe("broker.insight-interpret: strict answer (P01-C2c)", () => {
  async function answerWith(answer: unknown) {
    const a = store(listed);
    candidates.set("1", { name: "항목", evidenceSourceVersionIds: [a] });
    provider = new FakeProvider({ answer: () => answer });
    return interpret([a]);
  }

  it("accepts a valid answer", async () => {
    expect((await answerWith(valid)).status).toBe("ok");
  });

  it("rejects an extra key", async () => {
    expect(await answerWith({ ...valid, thinking: "x" })).toMatchObject({
      status: "failed",
      error: "invalid-output",
    });
  });

  it("rejects a reason summary over 500 characters", async () => {
    expect(await answerWith({ ...valid, reasoningSummary: "가".repeat(501) })).toMatchObject({
      status: "failed",
      error: "invalid-output",
    });
  });
});
