// I03-R14 / I03-T06 (C3): a run's Broker requests are counted by the context's
// wrapped Broker (`budget.job`), a spent request budget is a yield, and a spent
// whole-window budget is a retry whose attempt is given back and whose next run
// time is the one `budgetUsage()` names (`budget.restart`, with a Broker restarted
// over the same history). A Broker `cancelled` is not an answer.
import {
  createBroker,
  createCallRecorder,
  DEFAULT_LIMITS,
  EXTRACT_SCHEMA_VERSION,
  type BrokerResult,
} from "@pki/providers";
import {
  readJob,
  registerConnectorInstance,
  registerJob,
  saveSourceRecord,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { FakeProvider } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Clock } from "./clock.ts";
import { openCanonicalDb } from "./composition.ts";
import { BACKOFF_MAX_MS } from "./schedule.ts";
import { classifyResult } from "./job-outcomes.ts";
import { jobBroker } from "./job-broker.ts";
import { createJobRunner, type JobHandler } from "./job-runner.ts";

const T0 = Date.parse("2026-11-21T00:00:00.000Z");
const HOUR = DEFAULT_LIMITS.callBudget.windowMs;
let dir: string;
let db: SqlDriver;
let wall = T0;
const testClock: Clock = { now: () => wall, sleep: async () => {}, monotonic: () => 0 };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-job-budget-"));
  db = openCanonicalDb(join(dir, "data"));
  wall = T0;
  registerConnectorInstance(db, "c", "test-fixtures");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
function imported(): StoredJob {
  saveSourceRecord(db, "c", { externalId: `s${++seq}`, title: "t", body: "b1" });
  const row = db.all("SELECT source_id, version FROM source_versions ORDER BY id DESC LIMIT 1")[0];
  const r = registerJob(db, {
    kind: "extract",
    sourceId: row?.source_id as number,
    fenceVersion: row?.version as number,
    at: new Date(wall),
  });
  if (!r.registered) throw new Error("expected a new job");
  return r.job;
}

function brokerOver(on: SqlDriver, provider: FakeProvider, maxCalls = 60) {
  return createBroker({
    db: on,
    provider: () => provider,
    userActions: { redeem: () => "unknown" },
    candidates: { lookup: () => undefined },
    egress: { decide: () => ({ allowed: true, destination: "d", policyVersion: "p" }) },
    execution: { decide: () => ({ run: true }) },
    recorder: createCallRecorder(on, () => new Date(wall)),
    limits: { callBudget: { maxCalls, windowMs: HOUR } },
    clock: testClock,
  });
}

const extractRequest = (job: StoredJob) => ({
  taskKind: "extract",
  sourceVersionIds: [String(db.all("SELECT max(id) AS id FROM source_versions")[0]?.id)],
  candidateItemIds: [],
  origin: { jobId: String(job.id), leaseToken: String(job.leaseToken) },
  schemaVersion: EXTRACT_SCHEMA_VERSION,
  budget: { timeoutMs: 1000 },
  retryable: false,
});

function runnerFor(
  handler: JobHandler,
  broker: ReturnType<typeof brokerOver>,
  maxRequests?: number,
) {
  return createJobRunner({
    db,
    handlers: { extract: handler },
    broker,
    clock: testClock,
    kinds: { extract: { checkpointFields: ["n"], ...(maxRequests ? { maxRequests } : {}) } },
  });
}

describe("budget.job (I03-R14, C3): the request budget of one run", () => {
  it("lets two requests of an extract run through and blocks the third before the Provider", async () => {
    const provider = new FakeProvider();
    const seen: BrokerResult[] = [];
    const job = imported();
    const r = runnerFor(
      async (j, context) => {
        for (let i = 0; i < 3; i++) seen.push(await context.broker.call(extractRequest(j)));
        return { status: "fail", code: "done", retryable: true };
      },
      brokerOver(db, provider),
    );
    await r.runOnce();
    expect(provider.requests).toHaveLength(2);
    expect(seen[2]).toMatchObject({ status: "blocked", reason: "job-budget-exhausted" });
    expect(readJob(db, job.id)).toMatchObject({ reason: "done" });
  });

  it("the limit is the kind's setting; a new run of the same job starts counting again", async () => {
    const provider = new FakeProvider();
    const job = imported();
    let calls = 0;
    const r = runnerFor(
      async (j, context) => {
        calls++;
        const first = await context.broker.call(extractRequest(j));
        const second = await context.broker.call(extractRequest(j));
        expect([first.status, second.status]).toEqual([expect.any(String), "blocked"]);
        return { status: "fail", code: "again", retryable: true };
      },
      brokerOver(db, provider),
      1,
    );
    await r.runOnce();
    wall += BACKOFF_MAX_MS;
    expect(await r.runOnce()).toMatchObject({ jobId: job.id });
    expect(calls).toBe(2);
    expect(provider.requests).toHaveLength(2); // one per run
  });

  it("a yield after the checkpoint moved spends no attempt; one without spends it", async () => {
    const job = imported();
    let progress = true;
    const r = runnerFor(
      async (_j, context) => {
        if (progress) context.checkpoint({ n: 1 });
        return { status: "yield" };
      },
      brokerOver(db, new FakeProvider()),
    );
    expect(await r.runOnce()).toEqual({ jobId: job.id, status: "queued" });
    expect(readJob(db, job.id)).toMatchObject({ status: "queued", attempts: 0 });
    wall += 60_000;
    progress = false;
    expect(await r.runOnce()).toEqual({ jobId: job.id, status: "retry" });
    expect(readJob(db, job.id)).toMatchObject({ reason: "yield-no-progress", attempts: 1 });
  });

  it("a handler that hands the job-budget block back as it is yields: never held", async () => {
    const job = imported();
    const r = runnerFor(
      async (j, context) => {
        context.checkpoint({ n: 1 });
        await context.broker.call(extractRequest(j));
        await context.broker.call(extractRequest(j));
        return context.broker.call(extractRequest(j)) as Promise<never>;
      },
      brokerOver(db, new FakeProvider()),
    );
    expect(await r.runOnce()).toEqual({ jobId: job.id, status: "queued" });
    expect(readJob(db, job.id)).toMatchObject({ attempts: 0 });
  });

  it("hands the run's signal to every request and counts requests the Broker refused too", async () => {
    const seen: unknown[][] = [];
    const run = new AbortController();
    const broker = jobBroker(
      {
        call: async (...args) => {
          seen.push(args);
          return { status: "cancelled" };
        },
      },
      { limit: 1, signal: run.signal },
    );
    expect(await broker.call({ a: 1 })).toEqual({ status: "cancelled" });
    expect(seen).toEqual([[{ a: 1 }, run.signal]]);
    expect(await broker.call({ a: 2 })).toMatchObject({ reason: "job-budget-exhausted" });
    expect(seen).toHaveLength(1);
  });

  it("a runner given no Broker fails a handler that calls one, as a handler error", async () => {
    const job = imported();
    const r = createJobRunner({
      db,
      handlers: { extract: async (_j, context) => context.broker.call({}) as Promise<never> },
      clock: testClock,
    });
    await r.runOnce();
    expect(readJob(db, job.id)).toMatchObject({ status: "retry", reason: "handler-error" });
  });
});

describe("budget.restart (I03-R14, C3): a spent window budget is a retry that gives the attempt back", () => {
  it("after a restart over the same history the job retries when budgetUsage() says", async () => {
    const provider = new FakeProvider();
    const spend = runnerFor(
      async (j, context) => {
        await context.broker.call(extractRequest(j));
        return { status: "fail", code: "spent", retryable: false };
      },
      brokerOver(db, provider, 3),
    );
    for (let i = 0; i < 3; i++) {
      wall = T0 + i * 1000;
      imported();
      await spend.runOnce();
    }
    expect(provider.requests).toHaveLength(3);
    // a restart: a new Broker over the same history reads the budget back from it
    wall = T0 + 10_000;
    const after = brokerOver(db, provider, 3);
    const job = imported();
    const r = runnerFor(
      async (j, context) => context.broker.call(extractRequest(j)) as Promise<never>,
      after,
    );
    expect(await r.runOnce()).toEqual({ jobId: job.id, status: "retry" });
    expect(provider.requests).toHaveLength(3); // the 4th attempt never left
    expect(readJob(db, job.id)).toMatchObject({
      status: "retry",
      reason: "budget-exhausted",
      attempts: 0,
      runAfter: T0 + HOUR, // when the oldest attempt leaves the window
    });
    expect(after.budgetUsage().resetsAt).toBe(T0 + HOUR);
  });
});

describe("classifyResult: Broker results the Broker's budget adds (I03-R14)", () => {
  const run = { attempts: 2, now: T0, progressed: () => false };

  it("budget-exhausted retries at the time budgetUsage() names, clamped to one hour, attempt given back", () => {
    const blocked = { status: "blocked", requestId: "r", reason: "budget-exhausted" } as const;
    const at = (resumesAt: number | undefined) =>
      classifyResult(blocked, { ...run, budgetResumesAt: () => resumesAt });
    const expected = (runAfter: number) => ({
      status: "retry",
      reason: "budget-exhausted",
      runAfter,
      refund: true,
    });
    expect(at(T0 + 20 * 60_000)).toEqual(expected(T0 + 20 * 60_000));
    expect(at(T0 - 1)).toEqual(expected(T0)); // already free: due now
    expect(at(T0 + 5 * HOUR)).toEqual(expected(T0 + BACKOFF_MAX_MS));
    expect(at(undefined)).toEqual(expected(T0 + BACKOFF_MAX_MS));
  });

  it("a Broker cancelled is a retry with its attempt spent (a cancel request closes it cancelled)", () => {
    expect(classifyResult({ status: "cancelled" }, run)).toMatchObject({
      status: "retry",
      reason: "cancelled",
    });
  });

  it("job-budget-exhausted is a yield, by progress", () => {
    const blocked = { status: "blocked", requestId: "", reason: "job-budget-exhausted" } as const;
    expect(classifyResult(blocked, { ...run, progressed: () => true })).toEqual({
      status: "queued",
      runAfter: T0 + 60_000,
    });
    expect(classifyResult(blocked, run)).toMatchObject({ reason: "yield-no-progress" });
  });
});
