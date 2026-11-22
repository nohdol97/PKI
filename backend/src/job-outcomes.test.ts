// I03-R9, R10 (I03-T04): the rows of "실행 결과가 가는 곳" as one function from a
// handler's result to what closeJob stores, and the backoff. The stored side of
// each closing (status, attempts, code) is storage/src/jobs.test.ts `outcome.mapping`.
import { describe, expect, it } from "vitest";
import {
  backoffMs,
  classifyResult,
  DEFAULT_RUN_TIMEOUT_MS,
  failure,
  YIELD_DELAY_MS,
  type JobResult,
} from "./job-outcomes.ts";
import { BACKOFF_MAX_MS } from "./schedule.ts";

const NOW = Date.parse("2026-11-21T00:00:00.000Z");
const SECOND = 1000;
const MINUTE = 60 * SECOND;

describe("backoff (I03-R10)", () => {
  it("waits 30 s, 1 min, 2 min … doubling up to one hour for attempts 1 to 8", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((attempt) => backoffMs(attempt))).toEqual([
      30 * SECOND,
      MINUTE,
      2 * MINUTE,
      4 * MINUTE,
      8 * MINUTE,
      16 * MINUTE,
      32 * MINUTE,
      60 * MINUTE,
    ]);
    expect(backoffMs(8)).toBe(BACKOFF_MAX_MS);
    expect(backoffMs(64)).toBe(BACKOFF_MAX_MS);
    expect(backoffMs(2000)).toBe(BACKOFF_MAX_MS); // 2^1999 overflows to Infinity: still the cap
  });

  it("waits at least five minutes after a rate limit", () => {
    expect([1, 2, 3, 4, 5, 6, 8].map((attempt) => backoffMs(attempt, "rate-limited"))).toEqual([
      5 * MINUTE,
      5 * MINUTE,
      5 * MINUTE,
      5 * MINUTE,
      8 * MINUTE,
      16 * MINUTE,
      60 * MINUTE,
    ]);
  });

  it("gives the same wait for the same input: no jitter", () => {
    for (let attempt = 1; attempt <= 8; attempt++) {
      expect(new Set(Array.from({ length: 20 }, () => backoffMs(attempt))).size).toBe(1);
    }
  });

  it("refuses an attempt that is not a whole number from 1", () => {
    for (const attempt of [0, -1, 1.5, Number.NaN]) {
      expect(() => backoffMs(attempt)).toThrow(RangeError);
    }
  });
});

describe("outcome.mapping (I03-R9): a handler's result to the job's closing", () => {
  const run = { attempts: 2, now: NOW, progressed: () => false };
  const write = () => {};
  const retry = (reason: string, wait: number, refund?: true) => ({
    status: "retry",
    reason,
    runAfter: NOW + wait,
    ...(refund ? { refund } : {}),
  });
  const broker = { requestId: "r", attempts: 1 };

  const rows: [string, JobResult, object][] = [
    ["the handler's result", { status: "succeeded", write }, { status: "succeeded", write }],
    [
      "a skipped projection removal (a success with a code)",
      { status: "succeeded", write, code: "adapter-unavailable" },
      { status: "succeeded", write, reason: "adapter-unavailable" },
    ],
    [
      "a success whose code is not a code (the code's fault)",
      { status: "succeeded", write, code: "Not A Code" },
      { status: "dead_letter", reason: "invalid-reason" },
    ],
    ["a handler that found the job stale", { status: "superseded" }, { status: "superseded" }],
    [
      "handler held (an unavailable Connector instance)",
      { status: "held", reason: "unavailable" },
      { status: "held", reason: "unavailable" },
    ],
    [
      "V02's source too large",
      { status: "held", reason: "source-too-large" },
      { status: "held", reason: "source-too-large" },
    ],
    [
      "Broker rejected: missing-source",
      { status: "rejected", reason: "missing-source" },
      { status: "superseded" },
    ],
    [
      "Broker blocked (no consent)",
      { status: "blocked", requestId: "r", reason: "no-consent" },
      { status: "held", reason: "no-consent" },
    ],
    [
      "Broker blocked: budget-exhausted",
      { status: "blocked", requestId: "r", reason: "budget-exhausted" },
      retry("budget-exhausted", BACKOFF_MAX_MS, true),
    ],
    [
      "Broker failed: timeout",
      { status: "failed", error: "timeout", ...broker },
      retry("timeout", MINUTE),
    ],
    [
      "Broker failed: provider-error",
      { status: "failed", error: "provider-error", ...broker },
      retry("provider-error", MINUTE),
    ],
    [
      "Broker failed: rate-limited",
      { status: "failed", error: "rate-limited", ...broker },
      retry("rate-limited", 5 * MINUTE),
    ],
    [
      "Broker failed: invalid-output",
      { status: "failed", error: "invalid-output", ...broker },
      { status: "dead_letter", reason: "invalid-output" },
    ],
    [
      "Broker rejected for any other reason",
      { status: "rejected", reason: "origin-not-leased" },
      { status: "dead_letter", reason: "origin-not-leased" },
    ],
    [
      "a retryable failure",
      { status: "fail", code: "storage-failed", retryable: true },
      retry("storage-failed", MINUTE),
    ],
    [
      "a failure that cannot be retried",
      { status: "fail", code: "missing-version", retryable: false },
      { status: "dead_letter", reason: "missing-version" },
    ],
    ["a yield without progress", { status: "yield" }, retry("yield-no-progress", MINUTE)],
  ];

  it.each(rows)("%s", (_row, result, closing) => {
    expect(classifyResult(result, run)).toEqual(closing);
  });

  it("a yield with progress is queued a minute later", () => {
    expect(YIELD_DELAY_MS).toBe(MINUTE);
    expect(classifyResult({ status: "yield" }, { ...run, progressed: () => true })).toEqual({
      status: "queued",
      runAfter: NOW + MINUTE,
    });
  });

  it("the backoff follows the run's attempt", () => {
    const failed: JobResult = { status: "failed", error: "timeout", ...broker };
    expect([1, 3, 9].map((attempts) => classifyResult(failed, { ...run, attempts }))).toEqual([
      retry("timeout", 30 * SECOND),
      retry("timeout", 2 * MINUTE),
      retry("timeout", 60 * MINUTE),
    ]);
  });

  it("stores a fixed code for a reason that is not a code, never the text", () => {
    const text = "Provider said: SECRET-BODY-TEXT";
    const results: JobResult[] = [
      { status: "held", reason: text },
      { status: "fail", code: text, retryable: true },
      { status: "fail", code: text, retryable: false },
      { status: "blocked", requestId: "r", reason: text },
    ];
    for (const result of results) {
      expect(classifyResult(result, run)).toEqual({
        status: "dead_letter",
        reason: "invalid-reason",
      });
    }
  });

  it("a result outside the declared ones is the retryable failure handler-error (R9)", () => {
    const outside: unknown[] = [
      undefined,
      null,
      "succeeded",
      7,
      {},
      { status: "dead_letter", reason: "x" },
      { status: "succeeded" },
      { status: "succeeded", write: "not a function" },
      { status: "succeeded", items: {} },
      { status: "fail", code: "x" },
      { status: "held" },
      { status: "failed" },
    ];
    for (const result of outside) {
      expect(classifyResult(result as JobResult, run)).toEqual(retry("handler-error", MINUTE));
    }
  });

  it("what the runner itself meets: a thrown handler, a failed write, a run over its time", () => {
    expect(DEFAULT_RUN_TIMEOUT_MS).toBe(10 * MINUTE);
    expect(
      ["handler-error", "write-error", "run-timeout"].map((code) => failure(code, run)),
    ).toEqual([
      retry("handler-error", MINUTE),
      retry("write-error", MINUTE),
      retry("run-timeout", MINUTE),
    ]);
  });
});

describe("outcome.defer (I03-T09, I03-R19): a run that called nothing outside asks to run later", () => {
  const run = { attempts: 3, now: NOW, progressed: () => false };

  it("closes as a retry that gives the attempt back, due after the delay, with the code as reason", () => {
    expect(
      classifyResult({ status: "defer", code: "instance-busy", delayMs: MINUTE }, run),
    ).toEqual({
      status: "retry",
      reason: "instance-busy",
      runAfter: NOW + MINUTE,
      refund: true,
    });
  });

  it("is the handler-error retry when the delay is not a number from 0 or the code is missing", () => {
    for (const bad of [
      { status: "defer", code: "instance-busy", delayMs: -1 },
      { status: "defer", code: "instance-busy", delayMs: Number.NaN },
      { status: "defer", code: "instance-busy", delayMs: "60000" },
      { status: "defer", delayMs: MINUTE },
    ]) {
      expect(classifyResult(bad as unknown as JobResult, run)).toMatchObject({
        status: "retry",
        reason: "handler-error",
      });
    }
  });

  it("gives up a code that is not a code, as every reason does", () => {
    expect(classifyResult({ status: "defer", code: "Not A Code", delayMs: 0 }, run)).toEqual({
      status: "dead_letter",
      reason: "invalid-reason",
    });
  });
});

describe("outcome.retry-after (I01-R20 `rate-limited`): the later of the backoff and what the origin asked", () => {
  const run = { attempts: 1, now: NOW, progressed: () => false };
  const fail = (retryAfterMs?: number): JobResult => ({
    status: "fail",
    code: "rate-limited",
    retryable: true,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });

  it("waits the origin's request when it is longer than the backoff", () => {
    expect(classifyResult(fail(20 * MINUTE), run)).toMatchObject({ runAfter: NOW + 20 * MINUTE });
  });

  it("waits the backoff when the request is shorter", () => {
    expect(classifyResult(fail(SECOND), run)).toMatchObject({ runAfter: NOW + 5 * MINUTE });
    expect(classifyResult(fail(), run)).toMatchObject({ runAfter: NOW + 5 * MINUTE });
  });

  it("never waits past the backoff cap: a request of a year is an hour", () => {
    expect(classifyResult(fail(365 * 24 * 60 * MINUTE), run)).toMatchObject({
      runAfter: NOW + BACKOFF_MAX_MS,
    });
  });

  it("ignores a request that is not a number from 0", () => {
    for (const bad of [-1, Number.NaN]) {
      expect(classifyResult(fail(bad), run)).toMatchObject({ runAfter: NOW + 5 * MINUTE });
    }
  });
});
