// V01-C4 `broker` (V01-R8): timeout, retry backoff, rate-limit responses,
// concurrency cap, call budget, error recovery, and the six fields every request
// to a Provider carries. Consent, egress rules (T08) and CLI execution
// conditions (T09) are stand-ins here: the Broker only has to ask them.
import {
  ProviderError,
  ProviderRateLimitError,
  type BrokerRequest,
  type LLMProvider,
} from "@pki/contracts";
import { migrate } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { FakeProvider } from "@pki/testkit";
import { describe, expect, it } from "vitest";
import {
  createBroker,
  type BrokerDeps,
  type CallRecord,
  type EgressInput,
  type ExecutionInput,
} from "./broker.ts";
import { TASKS } from "./tasks.ts";
import { createUserActionLedger } from "./user-actions.ts";

const ALLOW = { allowed: true, destination: "fake.example", policyVersion: "pv-test" } as const;

function setup(options: { provider?: FakeProvider; deps?: Partial<BrokerDeps> } = {}) {
  const db = openBetterSqlite3(":memory:");
  migrate(db);
  const ledger = createUserActionLedger();
  const provider = options.provider ?? new FakeProvider();
  const records: CallRecord[] = [];
  const egress: EgressInput[] = [];
  const execution: ExecutionInput[] = [];
  const sleeps: number[] = [];
  const clock = { t: 0 };
  const broker = createBroker({
    db,
    provider: () => provider,
    userActions: ledger.redeemer,
    candidates: { lookup: () => undefined },
    egress: {
      decide: (input) => {
        egress.push(input);
        return ALLOW;
      },
    },
    execution: {
      decide: (input) => {
        execution.push(input);
        return { run: true };
      },
    },
    recorder: { record: (r) => void records.push(r) },
    clock: { now: () => clock.t, sleep: async (ms) => void sleeps.push(ms) },
    ...options.deps,
  });
  /** A connection test, the one request that needs no stored source. */
  const call = (request: Partial<BrokerRequest> = {}) =>
    ledger.issuer.during((userActionId) =>
      broker.call({
        taskKind: "connection-test",
        sourceVersionIds: [],
        candidateItemIds: [],
        origin: { userActionId },
        schemaVersion: 1,
        budget: { timeoutMs: 1000 },
        retryable: false,
        ...request,
      }),
    );
  return { db, provider, broker, call, records, egress, execution, sleeps, clock, ledger };
}

const retryable = (message = "busy") => new ProviderError(message, { retryable: true });

describe("broker: the request a Provider receives", () => {
  it("carries request ID, task kind, classification, egress decision, schema version and retryability", async () => {
    const { call, provider } = setup();
    const result = await call({ retryable: true });
    expect(result.status).toBe("ok");
    const [sent] = provider.requests;
    expect(sent?.requestId).toMatch(/\S/);
    expect(sent).toMatchObject({
      taskKind: "connection-test",
      trigger: "user",
      dataClassification: "synthetic",
      egress: ALLOW,
      schemaVersion: 1,
      retryable: true,
      budget: { timeoutMs: 1000 },
    });
    expect(result).toMatchObject({ requestId: sent?.requestId });
  });

  it("asks for the task's output schema and returns the validated output", async () => {
    const { call, provider } = setup();
    const result = await call();
    expect(provider.requests[0]).toMatchObject({
      outputSchema: TASKS["connection-test"][1].outputJsonSchema,
    });
    expect(result).toMatchObject({ status: "ok", output: { reply: "ok" } });
  });

  it("fails a call whose output does not match the task's schema, without retrying", async () => {
    const provider = new FakeProvider({ script: [{ output: { unexpected: 1 } }] });
    const { call } = setup({ provider });
    expect(await call({ retryable: true })).toMatchObject({
      status: "failed",
      error: "invalid-output",
      attempts: 1,
    });
  });
});

describe("broker: timeout", () => {
  it("aborts a call that runs past the budget's timeout and cancels it at the Provider", async () => {
    const provider = new FakeProvider({ script: ["hang"] });
    const { call } = setup({ provider });
    const result = await call({ budget: { timeoutMs: 20 } });
    expect(result).toMatchObject({ status: "failed", error: "timeout", attempts: 1 });
    expect(provider.cancelled).toEqual([provider.requests[0]?.requestId]);
  });

  it("caps the caller's timeout at the Broker's ceiling", async () => {
    const provider = new FakeProvider({ script: ["hang"] });
    const { call } = setup({ provider, deps: { limits: { maxTimeoutMs: 20 } } });
    const started = Date.now();
    expect(await call({ budget: { timeoutMs: 600_000 } })).toMatchObject({ error: "timeout" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("stops a Provider that ignores the abort signal", async () => {
    const provider = new FakeProvider({ script: ["ignore-abort"] });
    const { call } = setup({ provider });
    expect(await call({ budget: { timeoutMs: 20 } })).toMatchObject({ error: "timeout" });
  });
});

describe("broker: retry and backoff", () => {
  it("retries a retryable failure with exponentially growing waits", async () => {
    const provider = new FakeProvider({ script: [{ error: retryable() }, { error: retryable() }] });
    const { call, sleeps } = setup({
      provider,
      deps: { limits: { backoffBaseMs: 100, maxAttempts: 3 } },
    });
    expect(await call({ retryable: true })).toMatchObject({ status: "ok", attempts: 3 });
    expect(sleeps).toEqual([100, 200]);
  });

  it("does not retry a request the caller marked not retryable", async () => {
    const provider = new FakeProvider({ script: [{ error: retryable() }] });
    const { call, sleeps } = setup({ provider });
    expect(await call({ retryable: false })).toMatchObject({
      status: "failed",
      error: "provider-error",
      attempts: 1,
    });
    expect(sleeps).toEqual([]);
  });

  it("does not retry an error the Provider marked permanent", async () => {
    const provider = new FakeProvider({
      script: [{ error: new ProviderError("bad", { retryable: false }) }],
    });
    const { call } = setup({ provider });
    expect(await call({ retryable: true })).toMatchObject({ error: "provider-error", attempts: 1 });
  });

  it("retries a timeout when the request is retryable", async () => {
    const provider = new FakeProvider({ script: ["hang"] });
    const { call } = setup({ provider });
    expect(await call({ retryable: true, budget: { timeoutMs: 20 } })).toMatchObject({
      status: "ok",
      attempts: 2,
    });
  });

  it("gives up after the attempt limit", async () => {
    const provider = new FakeProvider({ script: Array(5).fill({ error: retryable() }) });
    const { call, provider: p } = setup({ provider, deps: { limits: { maxAttempts: 3 } } });
    expect(await call({ retryable: true })).toMatchObject({
      status: "failed",
      error: "provider-error",
      attempts: 3,
    });
    expect(p.requests).toHaveLength(3);
  });

  it("caps the backoff wait", async () => {
    const provider = new FakeProvider({ script: Array(3).fill({ error: retryable() }) });
    const { call, sleeps } = setup({
      provider,
      deps: { limits: { backoffBaseMs: 100, backoffMaxMs: 150, maxAttempts: 4 } },
    });
    await call({ retryable: true });
    expect(sleeps).toEqual([100, 150, 150]);
  });
});

describe("broker: rate-limit responses", () => {
  it("waits for the Provider's retry-after before trying again", async () => {
    const provider = new FakeProvider({
      script: [{ error: new ProviderRateLimitError({ retryAfterMs: 5_000 }) }],
    });
    const { call, sleeps } = setup({ provider, deps: { limits: { backoffMaxMs: 60_000 } } });
    expect(await call({ retryable: true })).toMatchObject({ status: "ok", attempts: 2 });
    expect(sleeps).toEqual([5_000]);
  });

  it("never waits longer than the backoff ceiling, and reports rate-limited when attempts run out", async () => {
    const provider = new FakeProvider({
      script: Array(3).fill({ error: new ProviderRateLimitError({ retryAfterMs: 3_600_000 }) }),
    });
    const { call, sleeps } = setup({
      provider,
      deps: { limits: { backoffMaxMs: 1_000, maxAttempts: 2 } },
    });
    expect(await call({ retryable: true })).toMatchObject({
      status: "failed",
      error: "rate-limited",
      attempts: 2,
    });
    expect(sleeps).toEqual([1_000]);
  });
});

describe("broker: concurrency cap", () => {
  it("runs at most maxConcurrent Provider calls at once and completes the rest after", async () => {
    const provider = new FakeProvider({ delayMs: 20 });
    const { call } = setup({ provider, deps: { limits: { maxConcurrent: 2 } } });
    const results = await Promise.all(Array.from({ length: 5 }, () => call()));
    expect(results.map((r) => r.status)).toEqual(Array(5).fill("ok"));
    expect(provider.maxInFlight).toBe(2);
  });
});

describe("broker: call budget", () => {
  it("blocks attempts beyond the budget within its window and allows them again after", async () => {
    const { call, provider, clock, records } = setup({
      deps: { limits: { callBudget: { maxCalls: 2, windowMs: 1_000 } } },
    });
    expect((await call()).status).toBe("ok");
    expect((await call()).status).toBe("ok");
    expect(await call()).toMatchObject({ status: "blocked", reason: "budget-exhausted" });
    expect(provider.requests).toHaveLength(2);
    expect(records.at(-1)).toMatchObject({ outcome: "budget-exhausted" });
    clock.t = 1_001;
    expect((await call()).status).toBe("ok");
  });

  it("counts retries against the budget", async () => {
    const provider = new FakeProvider({ script: Array(3).fill({ error: retryable() }) });
    const { call } = setup({
      provider,
      deps: { limits: { maxAttempts: 5, callBudget: { maxCalls: 2, windowMs: 1_000 } } },
    });
    expect(await call({ retryable: true })).toMatchObject({
      status: "blocked",
      reason: "budget-exhausted",
    });
    expect(provider.requests).toHaveLength(2);
  });
});

describe("broker: error recovery", () => {
  it("turns an unexpected Provider exception into a failed result and keeps serving", async () => {
    const provider = new FakeProvider({ script: [{ error: new TypeError("boom") }] });
    const { call } = setup({ provider, deps: { limits: { maxConcurrent: 1 } } });
    expect(await call({ retryable: true })).toMatchObject({
      status: "failed",
      error: "provider-error",
      attempts: 1,
    });
    // the single slot was released: the next call runs
    expect((await call()).status).toBe("ok");
  });

  it("does not leak the Provider's error text into the result or the history", async () => {
    const provider = new FakeProvider({
      script: [{ error: new ProviderError("echo: 본문 원문 SECRET-123", { retryable: false }) }],
    });
    const { call, records } = setup({ provider });
    const result = await call();
    expect(JSON.stringify(result)).not.toContain("SECRET-123");
    expect(JSON.stringify(records)).not.toContain("SECRET-123");
  });
});

describe("broker: seams for consent, egress rules and execution conditions", () => {
  it("does not call the Provider when the egress decision denies, and says why", async () => {
    const { call, provider, records } = setup({
      deps: { egress: { decide: () => ({ allowed: false, reason: "no-consent" }) } },
    });
    expect(await call()).toMatchObject({ status: "blocked", reason: "no-consent" });
    expect(provider.requests).toEqual([]);
    expect(records).toMatchObject([{ outcome: "blocked", attempt: 0 }]);
  });

  it("does not call the Provider when the execution condition blocks", async () => {
    const { call, provider } = setup({
      deps: { execution: { decide: () => ({ run: false, reason: "cli-not-verified" }) } },
    });
    expect(await call()).toMatchObject({ status: "blocked", reason: "cli-not-verified" });
    expect(provider.requests).toEqual([]);
  });

  it("hands both decisions the values the Broker computed", async () => {
    const { call, egress, execution } = setup();
    await call();
    expect(egress).toEqual([
      { providerId: "openai-compatible", taskKind: "connection-test", classification: "synthetic" },
    ]);
    expect(execution).toEqual([
      {
        providerId: "openai-compatible",
        transport: "http",
        taskKind: "connection-test",
        trigger: "user",
        classification: "synthetic",
        malicious: false,
      },
    ]);
  });

  it("blocks when no Provider is configured, without falling back to another", async () => {
    const { call } = setup({ deps: { provider: (): LLMProvider | undefined => undefined } });
    expect(await call()).toMatchObject({ status: "blocked", reason: "no-provider" });
  });
});

describe("broker: history", () => {
  it("records each attempt once, without text", async () => {
    const provider = new FakeProvider({ script: [{ error: retryable() }] });
    const { call, records } = setup({ provider });
    const result = await call({ retryable: true });
    expect(records).toHaveLength(2);
    expect(records.map((r) => [r.attempt, r.outcome])).toEqual([
      [1, "provider-error"],
      [2, "ok"],
    ]);
    for (const r of records) {
      expect(Object.keys(r).sort()).toEqual(
        [
          "attempt",
          "classification",
          "destination",
          "durationMs",
          "outcome",
          "policyVersion",
          "providerId",
          "requestId",
          "taskKind",
        ].sort(),
      );
      expect(r.requestId).toBe(result.status === "ok" ? result.requestId : "");
    }
  });
});
