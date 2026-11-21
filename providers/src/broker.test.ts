// V01-C4 `broker` (V01-R8): timeout, retry backoff, rate-limit responses,
// concurrency cap, call budget, error recovery, and the six fields every request
// to a Provider carries. Consent, egress rules (T08) and CLI execution
// conditions (T09) are stand-ins here: the Broker only has to ask them.
import {
  ProviderError,
  ProviderRateLimitError,
  type BrokerRequest,
  type LLMProvider,
  type StructuredResponse,
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
  strictest,
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
    // the Provider sees one ID per attempt, derived from the Broker's request ID
    expect(result.status === "ok" && sent?.requestId).toBe(
      result.status === "ok" && `${result.requestId}:1`,
    );
  });

  it("gives every attempt its own Provider request ID", async () => {
    const provider = new FakeProvider({ script: [{ error: retryable() }] });
    const { call, records } = setup({ provider });
    const result = await call({ retryable: true });
    if (result.status !== "ok") throw new Error(result.status);
    expect(provider.requests.map((r) => r.requestId)).toEqual([
      `${result.requestId}:1`,
      `${result.requestId}:2`,
    ]);
    expect(records.map((r) => [r.requestId, r.attempt])).toEqual([
      [result.requestId, 1],
      [result.requestId, 2],
    ]);
  });

  it("does not ask a Provider without structured output, and records why", async () => {
    const provider = new FakeProvider({ capabilities: { structuredOutput: false } });
    const { call, records, egress } = setup({ provider });
    expect(await call()).toMatchObject({
      status: "blocked",
      reason: "structured-output-unsupported",
    });
    expect(provider.requests).toEqual([]);
    expect(egress).toEqual([]);
    expect(records).toMatchObject([
      { attempt: 1, outcome: "blocked", reason: "structured-output-unsupported" },
    ]);
  });

  it("treats a structuredOutput flag that is not exactly true as unsupported", async () => {
    for (const flag of [undefined, "yes", 1]) {
      const provider = new FakeProvider({
        capabilities: { structuredOutput: flag as unknown as boolean },
      });
      const { call } = setup({ provider });
      expect(await call(), String(flag)).toMatchObject({
        reason: "structured-output-unsupported",
      });
      expect(provider.requests).toEqual([]);
    }
  });

  it("blocks, records and does not leak when the Provider's capabilities cannot be read", async () => {
    class Broken extends FakeProvider {
      override getCapabilities(): never {
        throw new Error("capabilities echo: SECRET-789");
      }
    }
    const provider = new Broken();
    const { call, records, egress } = setup({ provider });
    const result = await call();
    expect(result).toMatchObject({ status: "blocked", reason: "capabilities-unavailable" });
    expect(provider.requests).toEqual([]);
    expect(egress).toEqual([]);
    expect(records).toMatchObject([
      { attempt: 1, outcome: "blocked", reason: "capabilities-unavailable" },
    ]);
    expect(JSON.stringify([result, records])).not.toContain("SECRET-789");
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

  it("aborts the Provider's signal on timeout even when cancel does not stop the call", async () => {
    const provider = new FakeProvider({ script: ["ignore-abort"], cancelMode: "never-settles" });
    const { call } = setup({ provider });
    expect(await call({ budget: { timeoutMs: 20 } })).toMatchObject({ error: "timeout" });
    expect(provider.signals[0]?.aborted).toBe(true);
  });

  it("returns on timeout and frees its slot even if cancel never settles", async () => {
    const provider = new FakeProvider({
      script: ["ignore-abort"],
      cancelMode: "never-settles",
    });
    const { call } = setup({ provider, deps: { limits: { maxConcurrent: 1 } } });
    const first = await Promise.race([
      call({ budget: { timeoutMs: 20 } }),
      new Promise((resolve) => setTimeout(() => resolve("still pending"), 1_000)),
    ]);
    expect(first).toMatchObject({ status: "failed", error: "timeout" });
    expect(await call()).toMatchObject({ status: "ok" });
  });

  it("still aborts and reports a timeout when cancel throws synchronously", async () => {
    const provider = new FakeProvider({ script: ["ignore-abort"], cancelMode: "throws" });
    const { call } = setup({ provider });
    expect(await call({ budget: { timeoutMs: 20 } })).toMatchObject({ error: "timeout" });
    expect(provider.signals[0]?.aborted).toBe(true);
  });

  it("a late cancel of a timed-out attempt stops only that attempt, never the retry", async () => {
    // cancel stops the call with that ID 15 ms later, as killing a CLI process does
    const provider = new FakeProvider({
      script: ["ignore-abort"],
      cancelMode: "async",
      delayMs: 30,
    });
    const { call } = setup({ provider });
    // attempt 1 times out at 50 ms; its cancel lands at about 65 ms, while attempt 2 runs
    expect(await call({ retryable: true, budget: { timeoutMs: 50 } })).toMatchObject({
      status: "ok",
      attempts: 2,
    });
    expect(provider.cancelled).toEqual([provider.requests[0]?.requestId]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(provider.pending).toBe(0); // the first attempt was not orphaned
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

describe("broker: concurrency cap after a handoff", () => {
  it("keeps the cap when a call arrives after a queued call took over a slot", async () => {
    const provider = new FakeProvider({ delayMs: 20 });
    const { call } = setup({ provider, deps: { limits: { maxConcurrent: 1 } } });
    const first = call();
    const second = call(); // waits, then takes the slot first releases
    await first;
    const third = call(); // arrives while second runs
    await Promise.all([second, third]);
    expect(provider.maxInFlight).toBe(1);
  });
});

describe("broker: call budget", () => {
  it("counts an attempt exactly windowMs old as outside the window", async () => {
    const { call, clock } = setup({
      deps: { limits: { callBudget: { maxCalls: 1, windowMs: 1_000 } } },
    });
    expect((await call()).status).toBe("ok");
    clock.t = 999;
    expect(await call()).toMatchObject({ reason: "budget-exhausted" });
    clock.t = 1_000;
    expect((await call()).status).toBe("ok");
  });

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

  it("treats a Provider that throws synchronously like any failure: sanitized and recorded", async () => {
    class SyncThrowing extends FakeProvider {
      override generateStructured(): Promise<StructuredResponse> {
        throw new Error("echo of input: SECRET-456");
      }
    }
    const { call, records } = setup({ provider: new SyncThrowing() });
    const result = await call();
    expect(result).toMatchObject({ status: "failed", error: "provider-error", attempts: 1 });
    expect(records).toMatchObject([{ attempt: 1, outcome: "provider-error" }]);
    expect(JSON.stringify([result, records])).not.toContain("SECRET-456");
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
    expect(records).toMatchObject([{ outcome: "blocked", attempt: 1, reason: "no-consent" }]);
  });

  it("asks again after waiting for a slot: consent revoked while queued stops the call", async () => {
    let allowed = true;
    const provider = new FakeProvider({ delayMs: 20 });
    const { call } = setup({
      provider,
      deps: {
        limits: { maxConcurrent: 1 },
        egress: {
          decide: () => (allowed ? ALLOW : { allowed: false as const, reason: "consent-revoked" }),
        },
      },
    });
    const first = call();
    const second = call();
    allowed = false;
    expect((await first).status).toBe("ok");
    expect(await second).toMatchObject({ status: "blocked", reason: "consent-revoked" });
    expect(provider.requests).toHaveLength(1);
  });

  it("asks again before each retry: a block between attempts stops the retries", async () => {
    let runs = 0;
    const provider = new FakeProvider({ script: [{ error: retryable() }] });
    const { call, records } = setup({
      provider,
      deps: {
        execution: {
          decide: () => (++runs === 1 ? { run: true } : { run: false, reason: "cli-not-verified" }),
        },
      },
    });
    expect(await call({ retryable: true })).toMatchObject({
      status: "blocked",
      reason: "cli-not-verified",
    });
    expect(provider.requests).toHaveLength(1);
    expect(records.map((r) => [r.attempt, r.outcome])).toEqual([
      [1, "provider-error"],
      [2, "blocked"],
    ]);
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
        version: undefined,
        unverifiedAcknowledged: false,
      },
    ]);
  });

  it("asks a CLI's version before every attempt and passes the record's acknowledgement", async () => {
    const versions = ["2.1.3", "2.1.4"];
    const provider = new FakeProvider({
      id: "claude-code",
      transport: "cli",
      detect: async () => ({ installed: true, version: versions.shift() ?? "none" }),
      script: [{ error: retryable() }],
    });
    const { broker, ledger, execution } = setup({ provider });
    await ledger.issuer.during(
      (userActionId) =>
        broker.call({
          taskKind: "connection-test",
          sourceVersionIds: [],
          candidateItemIds: [],
          origin: { userActionId },
          schemaVersion: 1,
          budget: { timeoutMs: 1000 },
          retryable: true,
        }),
      { acknowledgeUnverified: true },
    );
    expect(execution.map((e) => [e.transport, e.version, e.unverifiedAcknowledged])).toEqual([
      ["cli", "2.1.3", true],
      ["cli", "2.1.4", true],
    ]);
  });

  it.each([
    ["a failing version query", async () => Promise.reject(new Error("secret-ish output"))],
    ["a CLI that is not installed", async () => ({ installed: false, version: "2.1.3" })],
    ["a version query without a version", async () => ({ installed: true })],
  ])("passes no version for %s", async (_, detect) => {
    const provider = new FakeProvider({ id: "codex", transport: "cli", detect });
    const { call, execution } = setup({ provider });
    await call();
    expect(execution).toHaveLength(1);
    expect(execution[0]?.version).toBeUndefined();
  });

  it("hands a CLI the profile and isolation the gate chose, and reports them", async () => {
    const cli = { profile: "claude-code/minimal-1", isolation: "unverified" } as const;
    const provider = new FakeProvider({ id: "claude-code", transport: "cli" });
    const { call } = setup({
      provider,
      deps: { execution: { decide: () => ({ run: true, cli }) } },
    });
    expect(await call()).toMatchObject({ status: "ok", cli });
    expect(provider.requests[0]?.execution).toEqual(cli);
  });

  it("sends an HTTP Provider no execution profile", async () => {
    const { call, provider } = setup();
    const result = await call();
    expect(result).not.toHaveProperty("cli");
    expect(provider.requests[0]).not.toHaveProperty("execution");
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

describe("broker: strictest classification", () => {
  it("is general for no input at all, and synthetic only when every input is", () => {
    const synthetic = { classification: "synthetic" as const, malicious: false };
    const general = { classification: "general" as const, malicious: false };
    expect(strictest([])).toBe("general");
    expect(strictest([synthetic, synthetic])).toBe("synthetic");
    expect(strictest([synthetic, general])).toBe("general");
  });
});
