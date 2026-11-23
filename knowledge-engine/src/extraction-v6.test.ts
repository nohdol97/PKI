// P01-T05 `extract.v6` (P01-R11, C1a import path): the extract handler with schema 6 through the real Broker on a
// real SQLite database. A `Request` item with a `status` fact is written as a candidate with the status in its
// lower-case form; a `status` outside the four values is dropped; a `conclusion` that is not inside its quote, or
// is longer than 500 code points, is dropped (counted). The answers come from the Provider double. Synthetic data.
import { createBroker, createUserActionLedger } from "@pki/providers";
import {
  closeJob,
  isFenceCurrent,
  leaseNextJob,
  migrate,
  readExtractionDrops,
  registerConnectorInstance,
  registerJob,
  saveSourceRecord,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { FakeProvider, type FakeStep } from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExtractHandler } from "./extraction.ts";
import { knowledgeCandidates } from "./linking.ts";

const T0 = new Date("2026-11-23T00:00:00.000Z");
let db: SqlDriver;
let provider: FakeProvider;
let handler: ReturnType<typeof createExtractHandler>;
let externalIds = 0;

function setUp(script: FakeStep[]) {
  provider = new FakeProvider({
    answer: () => ({ items: [], facts: [], relations: [], terms: [], definitions: [] }),
    script,
  });
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
  handler = createExtractHandler({ db, now: () => T0 });
  return { call: (raw: unknown) => broker.call(raw) };
}
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "imported", "jsonl-import");
});
afterEach(() => db.close());

const answer = (o: object): FakeStep => ({
  output: { items: [], facts: [], relations: [], terms: [], definitions: [], ...o },
});
const item = (ref: string, type: string, name: string, existingItemId: string | null = null) => ({
  ref,
  type,
  name,
  existingItemId,
});
const fact = (
  itemRef: string,
  kind: string,
  value: string,
  quote: string,
  epistemic = "explicit",
) => ({
  item: itemRef,
  kind,
  value,
  epistemic,
  quote,
});

/** Stores `body` as a new source (a table source when `blocks` are given) and runs its extract job once. */
async function extract(
  step: FakeStep,
  doc: { title?: string; body: string; blocks?: readonly unknown[] },
): Promise<StoredJob> {
  const broker = setUp([step]);
  const job = db.transaction(() => {
    const saved = saveSourceRecord(db, "imported", {
      externalId: `doc-${externalIds++}`,
      title: doc.title ?? "t",
      body: doc.body,
      ...(doc.blocks ? { blocks: doc.blocks } : {}),
    } as Parameters<typeof saveSourceRecord>[2]);
    if (saved.status !== "created") throw new Error("expected a new version");
    const r = registerJob(db, {
      kind: "extract",
      sourceId: saved.sourceId,
      fenceVersion: saved.version,
      at: T0,
    });
    if (!r.registered) throw new Error("expected a new job");
    return r.job;
  });
  const leased = leaseNextJob(db, { kinds: ["extract"], now: T0, leaseMs: 60_000 });
  if (
    !leased ||
    !isFenceCurrent(db, {
      sourceId: leased.sourceId as number,
      fenceVersion: leased.fenceVersion as number,
    })
  ) {
    throw new Error("expected a current job");
  }
  const result = await handler(leased, { broker });
  if (result.status !== "succeeded") throw new Error(result.status);
  closeJob(db, leased, result);
  return job;
}

const facts = () =>
  db.all(
    `SELECT i.name AS item, f.kind, f.value, f.status FROM facts f
       JOIN items i ON i.id = f.item_id ORDER BY f.id`,
  );
const drops = (job: StoredJob) => readExtractionDrops(db, job.id);

describe("extract.v6: a request's status and a decision's conclusion (P01-R11)", () => {
  const Q = {
    status: "결제 연동 요청은 Open 상태다",
    badStatus: "정산 요청은 보류 상태다",
    conclusion: "결정: 정산은 월 단위로 마감한다",
    outside: "결정: 환불은 즉시 처리한다",
    long: `결정: ${"가".repeat(501)}`,
  };
  const BODY = Object.values(Q)
    .map((q) => `${q}.`)
    .join("\n");

  it("writes the status in lower case and the conclusion that its quote holds, and drops a status outside the four values, a conclusion outside its quote and one over 500 code points", async () => {
    const job = await extract(
      answer({
        items: [
          item("r", "Request", "결제 연동 요청"),
          item("q", "Request", "정산 요청"),
          item("d", "Decision", "마감 주기"),
        ],
        facts: [
          fact("r", "status", "Open", Q.status),
          fact("q", "status", "보류", Q.badStatus),
          fact("d", "conclusion", "정산은 월 단위로 마감한다", Q.conclusion),
          fact("d", "conclusion", "환불은 지연 처리한다", Q.outside),
          fact("d", "conclusion", Q.long.slice("결정: ".length), Q.long),
        ],
      }),
      { body: BODY },
    );
    expect(facts()).toEqual([
      { item: "결제 연동 요청", kind: "status", value: "open", status: "candidate" },
      {
        item: "마감 주기",
        kind: "conclusion",
        value: "정산은 월 단위로 마감한다",
        status: "candidate",
      },
    ]);
    // the outside conclusion is a quote drop; the bad status and the long conclusion are other drops
    expect(drops(job)).toEqual({ quotes: 1, other: 2 });
  });
});
