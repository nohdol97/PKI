// K02-C4 (R16, R17): the `reflection-refine` task through the real Broker. The answer is strict: a verdict
// outside same/related/unrelated or a key outside the schema is `invalid-output`. Without consent the Broker
// asks no Provider.
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
import { beforeEach, describe, expect, it } from "vitest";
import { createBroker, type CandidateItem } from "./broker.ts";
import { createUserActionLedger } from "./user-actions.ts";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);

let db: SqlDriver;
let provider: FakeProvider;
let consent = true;
const candidates = new Map<string, CandidateItem>();
let seq = 0;

const broker = () =>
  createBroker({
    db,
    provider: () => provider,
    userActions: createUserActionLedger().redeemer,
    candidates: { lookup: (id) => candidates.get(id) },
    egress: {
      decide: () =>
        consent
          ? { allowed: true, destination: "fake", policyVersion: "pv" }
          : { allowed: false, reason: "consent-missing" },
    },
    execution: { decide: () => ({ run: true }) },
    recorder: {
      record: () => undefined,
      begin: () => () => undefined,
      attemptTimes: () => [],
      interruptStarted: () => 0,
    },
    clock: { now: () => 0, sleep: async () => undefined },
  });

beforeEach(() => {
  db = freshDb();
  registerConnectorInstance(db, "c1", "test-fixtures");
  consent = true;
  candidates.clear();
});

/** One stored document, two candidate items resting on it, and a running sourceless job of the kind. */
function ask(answer: unknown) {
  saveSourceRecord(db, "c1", { externalId: `ext-${++seq}`, title: "제목", body: "합성 본문" });
  const id = String(db.all("SELECT max(id) AS id FROM source_versions")[0]?.id);
  candidates.set("1", { name: "항목 가", evidenceSourceVersionIds: [id] });
  candidates.set("2", { name: "항목 나", evidenceSourceVersionIds: [id] });
  provider = new FakeProvider({ answer: () => answer });
  const queued = registerJob(db, {
    kind: "reflection-refine",
    target: `1#${seq}`,
    priority: "maintenance",
  });
  if (!queued.registered) throw new Error("expected a new job");
  const leased = leaseNextJob(db, {
    kinds: ["reflection-refine"],
    now: new Date(),
    leaseMs: 60_000,
  });
  if (!leased) throw new Error("expected a lease");
  return broker().call({
    taskKind: "reflection-refine",
    sourceVersionIds: [id],
    candidateItemIds: ["1", "2"],
    origin: { jobId: String(leased.id), leaseToken: String(leased.leaseToken) },
    schemaVersion: 1,
    budget: { timeoutMs: 1000 },
    retryable: false,
  });
}

const valid = { verdict: "same", documentId: "1", quote: "합성 본문" };

describe("broker.reflection-refine: strict answer and consent (K02-C4)", () => {
  it("accepts a valid answer", async () => {
    expect((await ask(valid)).status).toBe("ok");
  });

  it("rejects a verdict outside the three", async () => {
    expect(await ask({ ...valid, verdict: "maybe" })).toMatchObject({
      status: "failed",
      error: "invalid-output",
    });
  });

  it("rejects an extra key", async () => {
    expect(await ask({ ...valid, thinking: "x" })).toMatchObject({
      status: "failed",
      error: "invalid-output",
    });
  });

  it("asks no Provider without consent", async () => {
    consent = false;
    expect(await ask(valid)).toMatchObject({ status: "blocked", reason: "consent-missing" });
    expect(provider.requests).toEqual([]);
  });
});
