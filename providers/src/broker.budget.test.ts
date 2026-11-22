// I03-R14 / I03-T06 (C3): the Broker's own call budget survives a restart because
// history is written before a call (a "started" row) and read back at start; a
// call killed midway is "interrupted" and still counted; a wall clock that went
// back does not lock the budget; an outer AbortSignal ends a request, a retry
// wait included, with the result and history outcome "cancelled".
import { ProviderError, type BrokerRequest } from "@pki/contracts";
import { listProviderCalls, migrate, type SqlDriver } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { FakeProvider } from "@pki/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBroker, DEFAULT_LIMITS } from "./broker.ts";
import { createCallRecorder } from "./call-recorder.ts";
import { createUserActionLedger } from "./user-actions.ts";

const T0 = Date.parse("2026-11-21T00:00:00.000Z");
const HOUR = DEFAULT_LIMITS.callBudget.windowMs;
const ALLOW = { allowed: true, destination: "fake.example", policyVersion: "pv-test" } as const;

const open: SqlDriver[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function newDb(): SqlDriver {
  const db = openBetterSqlite3(":memory:");
  migrate(db);
  open.push(db);
  return db;
}

/** A Broker over `db`: building another over the same db and clock is a restart. */
function rig(
  db: SqlDriver,
  clock: { t: number },
  provider: FakeProvider = new FakeProvider(),
  sleep: (ms: number, signal?: AbortSignal) => Promise<void> = async () => {},
  onDecide: () => void = () => {},
) {
  const ledger = createUserActionLedger();
  const asked: string[] = [];
  const broker = createBroker({
    db,
    provider: () => provider,
    userActions: ledger.redeemer,
    candidates: { lookup: () => undefined },
    egress: {
      decide: (input) => {
        asked.push(input.taskKind);
        onDecide();
        return ALLOW;
      },
    },
    execution: { decide: () => ({ run: true }) },
    recorder: createCallRecorder(db, () => new Date(clock.t)),
    clock: { now: () => clock.t, sleep },
  });
  const call = (request: Partial<BrokerRequest> = {}, signal?: AbortSignal) =>
    ledger.issuer.during((userActionId) =>
      broker.call(
        {
          taskKind: "connection-test",
          sourceVersionIds: [],
          candidateItemIds: [],
          origin: { userActionId },
          schemaVersion: 1,
          budget: { timeoutMs: 1000 },
          retryable: false,
          ...request,
        },
        signal,
      ),
    );
  return { broker, provider, call, asked };
}

const outcomes = (db: SqlDriver) => listProviderCalls(db).map((c) => c.outcome);

describe("broker.cancelled-outcome (I03-R14, C3)", () => {
  it("an outer signal ends a sent attempt as cancelled: result, history and budget", async () => {
    const db = newDb();
    const clock = { t: T0 };
    const provider = new FakeProvider({ script: ["hang"] });
    const { broker, call } = rig(db, clock, provider);
    const ac = new AbortController();
    const pending = call({}, ac.signal);
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
    expect(outcomes(db)).toEqual(["started"]); // written before the Provider was asked
    ac.abort();
    expect(await pending).toEqual({ status: "cancelled" });
    expect(outcomes(db)).toEqual(["cancelled"]);
    expect(provider.signals[0]?.aborted).toBe(true);
    expect(provider.cancelled).toEqual([provider.requests[0]?.requestId]);
    expect(broker.budgetUsage()).toMatchObject({ used: 1 });
  });

  it("a signal cut inside the egress decision sends nothing and leaves no row", async () => {
    const db = newDb();
    const provider = new FakeProvider();
    const ac = new AbortController();
    const { broker, call } = rig(db, { t: T0 }, provider, undefined, () => ac.abort());
    expect(await call({}, ac.signal)).toEqual({ status: "cancelled" });
    expect(provider.requests).toEqual([]);
    expect(listProviderCalls(db)).toEqual([]);
    expect(broker.budgetUsage()).toMatchObject({ used: 0 });
  });

  it("the Broker's own time limit is still a timeout", async () => {
    const db = newDb();
    const { call } = rig(db, { t: T0 }, new FakeProvider({ script: ["hang"] }));
    expect(await call({ budget: { timeoutMs: 20 } })).toMatchObject({
      status: "failed",
      error: "timeout",
    });
    expect(outcomes(db)).toEqual(["timeout"]);
  });

  it("a signal cut before the attempt leaves no history row and no budget use", async () => {
    const db = newDb();
    const provider = new FakeProvider();
    const { broker, call } = rig(db, { t: T0 }, provider);
    expect(await call({}, AbortSignal.abort())).toEqual({ status: "cancelled" });
    expect(provider.requests).toEqual([]);
    expect(listProviderCalls(db)).toEqual([]);
    expect(broker.budgetUsage()).toMatchObject({ used: 0, resetsAt: null });
  });
});

describe("cancel.broker-retry (I03-R14, C3)", () => {
  it("a signal cut during the retry wait stops the request: no second call, cancelled", async () => {
    const db = newDb();
    const provider = new FakeProvider({
      script: [{ error: new ProviderError("busy", { retryable: true }) }],
    });
    let waiting!: () => void;
    const inWait = new Promise<void>((resolve) => (waiting = resolve));
    // a clock whose sleep ignores the signal: the Broker must not depend on it
    const { call } = rig(db, { t: T0 }, provider, () => {
      waiting();
      return new Promise<void>(() => {});
    });
    const ac = new AbortController();
    const pending = call({ retryable: true }, ac.signal);
    await inWait;
    ac.abort();
    expect(await pending).toEqual({ status: "cancelled" });
    expect(provider.requests).toHaveLength(1);
    expect(outcomes(db)).toEqual(["provider-error"]);
  });

  it("hands the Provider's attempt the same cut: a signal cut while the attempt waits for a slot sends nothing", async () => {
    const db = newDb();
    const provider = new FakeProvider({ script: ["hang", "hang", "hang"] });
    const { call, asked } = rig(db, { t: T0 }, provider);
    const holders = [new AbortController(), new AbortController()];
    const running = holders.map((h) => call({}, h.signal));
    await vi.waitFor(() => expect(provider.requests).toHaveLength(2)); // both slots taken
    const ac = new AbortController();
    const queued = call({}, ac.signal);
    ac.abort();
    holders[0]?.abort(); // frees a slot: the queued request takes it and sees the cut
    expect(await queued).toEqual({ status: "cancelled" });
    expect(provider.requests).toHaveLength(2);
    expect(asked).toHaveLength(2); // the cut request was not even judged
    holders[1]?.abort();
    await Promise.all(running);
  });
});

describe("budget.restart (I03-R14, C3)", () => {
  it("60 attempts in the window, then a restart: the 61st is budget-exhausted until the oldest leaves", async () => {
    const db = newDb();
    const clock = { t: T0 };
    const first = rig(db, clock);
    for (let i = 0; i < 60; i++) {
      clock.t = T0 + i * 1000;
      expect((await first.call()).status).toBe("ok");
    }
    clock.t = T0 + 60_000;
    const restarted = rig(db, clock);
    expect(await restarted.call()).toMatchObject({ status: "blocked", reason: "budget-exhausted" });
    expect(restarted.provider.requests).toEqual([]);
    expect(restarted.broker.budgetUsage()).toEqual({
      used: 60,
      maxCalls: 60,
      windowMs: HOUR,
      resetsAt: T0 + HOUR,
    });
    clock.t = T0 + HOUR;
    expect((await restarted.call()).status).toBe("ok");
  });

  it("blocked and budget-exhausted rows are not attempts: they do not fill the budget back", async () => {
    const db = newDb();
    const clock = { t: T0 };
    const first = rig(db, clock);
    for (let i = 0; i < 60; i++) await first.call();
    for (let i = 0; i < 5; i++) await first.call(); // 5 budget-exhausted rows
    expect(outcomes(db).filter((o) => o === "budget-exhausted")).toHaveLength(5);
    expect(rig(db, clock).broker.budgetUsage()).toMatchObject({ used: 60 });
  });
});

describe("budget.kill-mid-call, the in-process half (I03-R14, C3)", () => {
  it("a started row a dead process left becomes interrupted at start and is still counted", () => {
    const db = newDb();
    const clock = { t: T0 };
    const recorder = createCallRecorder(db, () => new Date(clock.t));
    recorder.begin({
      requestId: "dead",
      attempt: 1,
      providerId: "claude-code",
      taskKind: "connection-test",
      classification: "synthetic",
      destination: "d",
      policyVersion: "p",
    });
    expect(outcomes(db)).toEqual(["started"]);
    const { broker } = rig(db, clock);
    expect(outcomes(db)).toEqual(["interrupted"]);
    expect(broker.budgetUsage()).toMatchObject({ used: 1, resetsAt: T0 + HOUR });
  });
});

describe("budget.clock-regression (I03-R14, C3)", () => {
  it("a wall clock set back three hours frees the budget within one window, not three", async () => {
    const db = newDb();
    const clock = { t: T0 };
    const first = rig(db, clock);
    for (let i = 0; i < 60; i++) await first.call();
    clock.t = T0 - 3 * HOUR;
    expect(await first.call()).toMatchObject({ status: "blocked", reason: "budget-exhausted" });
    const usage = first.broker.budgetUsage();
    expect(usage.resetsAt).not.toBeNull();
    expect(usage.resetsAt as number).toBeLessThanOrEqual(clock.t + HOUR);
    clock.t = (usage.resetsAt as number) + 1;
    expect((await first.call()).status).toBe("ok");
  });

  it("the same after a restart that reads the future-dated rows from history", async () => {
    const db = newDb();
    const clock = { t: T0 };
    const first = rig(db, clock);
    for (let i = 0; i < 60; i++) await first.call();
    clock.t = T0 - 3 * HOUR;
    const restarted = rig(db, clock);
    expect(await restarted.call()).toMatchObject({ status: "blocked", reason: "budget-exhausted" });
    expect(restarted.broker.budgetUsage().resetsAt as number).toBeLessThanOrEqual(clock.t + HOUR);
    clock.t += HOUR;
    expect((await restarted.call()).status).toBe("ok");
  });
});
