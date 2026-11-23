// K01-C4 ① (R12): the `wiki-summary` task through the real Broker. A request from a leased `wiki-summary` job
// carries the version row IDs of a page's lineage and the item's ID; the Broker reads and grades them
// (strictest over every version and the item's name), and a job of another kind cannot make the call.
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

let db: SqlDriver;
let provider: FakeProvider;
let broker: ReturnType<typeof createBroker>;
const candidates = new Map<string, CandidateItem>();

beforeEach(() => {
  db = freshDb();
  registerConnectorInstance(db, "c1", "test-fixtures");
  provider = new FakeProvider({ answer: () => ({ sentences: [] }) });
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
  const r = registerJob(db, { kind, target: "projects/1#h", priority: "maintenance" });
  if (!r.registered) throw new Error("expected a new job");
  const leased = leaseNextJob(db, { kinds: [kind], now: new Date(), leaseMs: 60_000 });
  if (!leased) throw new Error("expected a lease");
  return String(leased.id) + ":" + String(leased.leaseToken);
}

const summary = (kind: string, ids: string[]) => {
  const [jobId, leaseToken] = running(kind).split(":") as [string, string];
  return broker.call({
    taskKind: "wiki-summary",
    sourceVersionIds: ids,
    candidateItemIds: ["1"],
    origin: { jobId, leaseToken },
    schemaVersion: 1,
    budget: { timeoutMs: 1000 },
    retryable: false,
  });
};

describe("broker.wiki-summary: task kind and grade (K01-C4 ①)", () => {
  it("sends every lineage version and grades by the strictest: one unlisted version makes it general", async () => {
    const a = store(listed);
    const b = store({ title: "일반 자료", body: "합성 목록에 없는 본문" });
    candidates.set("1", { name: "항목", evidenceSourceVersionIds: [a, b] });
    expect((await summary("wiki-summary", [a, b])).status).toBe("ok");
    const sent = provider.requests[0];
    expect(sent?.taskKind).toBe("wiki-summary");
    expect(sent?.input.untrustedDocuments.map((d) => d.id)).toEqual([a, b]);
    expect(sent?.dataClassification).toBe("general");
  });

  it("refuses the call from a job of another kind", async () => {
    const a = store(listed);
    candidates.set("1", { name: "항목", evidenceSourceVersionIds: [a] });
    expect(await summary("wiki-build", [a])).toEqual({
      status: "rejected",
      reason: "origin-mismatch",
    });
    expect(provider.requests).toEqual([]);
  });
});
