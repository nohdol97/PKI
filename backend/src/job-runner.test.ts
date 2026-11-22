// V02-R4, R5, C3 integration on a real SQLite file: the runner claims jobs with an
// expiring lease, one knowledge job at a time (other groups together: I03-T05,
// job-concurrency.test.ts), picks up a job left running by a backend that
// stopped once the lease runs out, and discards a result whose version went
// stale before it was written. Clocks are injected; nothing sleeps.
// I03-T04: results go through the outcome table (retry with backoff, refunds,
// the run-time limit on the injected monotonic clock) and steps through checkpoints.
import {
  createCommitScope,
  DEFAULT_MAX_ATTEMPTS,
  heartbeatJob,
  readJob,
  registerConnectorInstance,
  registerJob,
  requeueHeldReasons,
  saveSourceRecord,
  supersedeOpenJobs,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedLegacyTombstone } from "@pki/testkit";
import type { Clock } from "./clock.ts";
import { openCanonicalDb } from "./composition.ts";
import { DEFAULT_RUN_TIMEOUT_MS } from "./job-outcomes.ts";
import {
  createJobRunner,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_LEASE_MS,
  testRunnerSettings,
  type JobHandler,
  type JobKindSettings,
  type JobResult,
} from "./job-runner.ts";

let dir: string;
let db: SqlDriver;
const open: SqlDriver[] = [];

const T0 = new Date("2026-11-21T00:00:00.000Z");
const LEASE = 60_000;
let clock = T0;
const now = () => clock;
/** The monotonic reading of the injected clock, moved by the tests alone. */
let mono = 0;
const testClock: Clock = {
  now: () => clock.getTime(),
  sleep: async () => {},
  monotonic: () => mono,
};

function reopen(): SqlDriver {
  const next = openCanonicalDb(join(dir, "data"));
  open.push(next);
  return next;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-jobs-"));
  db = reopen();
  clock = T0;
  mono = 0;
  registerConnectorInstance(db, "c", "test-fixtures");
});

afterEach(() => {
  for (const d of open.splice(0)) d.close();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

let seq = 0;
/** Stores a version of source `externalId` and queues its extraction job, as T04 will. */
function imported(externalId = `s${++seq}`, body = "b1"): StoredJob {
  return db.transaction(() => {
    saveSourceRecord(db, "c", { externalId, title: "t", body });
    const row =
      db.all(
        `SELECT v.source_id, v.version FROM source_versions v
         JOIN sources s ON s.id = v.source_id WHERE s.external_id = ?
        ORDER BY v.id DESC LIMIT 1`,
        [externalId],
      )[0] ?? {};
    const r = registerJob(db, {
      kind: "extract",
      sourceId: row.source_id as number,
      fenceVersion: row.version as number,
      at: now(), // due on the injected clock: a claim honours the run-at time (I03-T03)
    });
    if (!r.registered) throw new Error("expected a new job");
    return r.job;
  });
}

/** A result that writes one marker row, so a discarded result leaves no trace. */
const marked =
  (on: SqlDriver, marker: string): (() => void) =>
  () =>
    void on.run("INSERT INTO settings (key, value) VALUES (?, 'written')", [marker]);
const written = (on: SqlDriver, marker: string) =>
  on.all("SELECT key FROM settings WHERE key = ?", [marker]).length === 1;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const runner = (
  handler: JobHandler,
  on = db,
  onError?: (e: unknown) => void,
  settings?: JobKindSettings,
) =>
  createJobRunner({
    db: on,
    handlers: { extract: handler },
    clock: testClock,
    testBuild: { leaseMs: LEASE },
    ...(onError && { onError }),
    ...(settings && { kinds: { extract: settings } }),
  });

describe("job runner: version fence (V02-R5)", () => {
  it("writes the result of a job whose version is still the latest and closes it done", async () => {
    const job = imported("a");
    const run = await runner(async () => ({
      status: "succeeded",
      write: marked(db, "a"),
    })).runOnce();
    expect(run).toEqual({ jobId: job.id, status: "succeeded" });
    expect(written(db, "a")).toBe(true);
    expect(readJob(db, job.id)).toMatchObject({ status: "succeeded", leaseUntil: null });
  });

  it("discards a result whose source got a new version while it ran: superseded", async () => {
    const job = imported("a", "v1");
    const run = await runner(async () => {
      imported("a", "v2"); // a newer version arrives while the Broker call is out
      return { status: "succeeded", write: marked(db, "stale") };
    }).runOnce();
    expect(run).toEqual({ jobId: job.id, status: "superseded" });
    expect(written(db, "stale")).toBe(false);
    expect(readJob(db, job.id)?.status).toBe("superseded");
  });

  it("discards a result whose source was deleted while it ran: superseded", async () => {
    const job = imported("a");
    const run = await runner(async () => {
      db.transaction(() => {
        db.run("DELETE FROM source_versions WHERE source_id = ?", [job.sourceId]);
        seedLegacyTombstone(db, {
          sourceId: job.sourceId as number,
          version: 1,
          at: "x",
          reason: "source-deleted",
        });
      });
      return { status: "succeeded", write: marked(db, "deleted") };
    }).runOnce();
    expect(run?.status).toBe("superseded");
    expect(written(db, "deleted")).toBe(false);
  });

  it("closes a job already stale when claimed without calling its handler", async () => {
    const job = imported("a", "v1");
    imported("a", "v2");
    const handler = vi.fn<JobHandler>();
    expect(await runner(handler).runOnce()).toEqual({ jobId: job.id, status: "superseded" });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("job runner: restart (V02-R4, R16)", () => {
  it("resumes a job left running by a stopped backend once its lease runs out", async () => {
    const job = imported("a");
    const before = runner(() => new Promise<never>(() => {})); // the call never returns
    void before.runOnce();
    await vi.waitFor(() => expect(readJob(db, job.id)?.status).toBe("running"));
    db.close(); // the backend stops with the job running
    open.splice(open.indexOf(db), 1);

    const after = reopen();
    const handler = vi.fn<JobHandler>(async () => ({
      status: "succeeded",
      write: marked(after, "a"),
    }));
    const restarted = runner(handler, after);
    clock = new Date(T0.getTime() + LEASE - 1);
    expect(await restarted.runOnce()).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();

    clock = new Date(T0.getTime() + LEASE);
    expect(await restarted.runOnce()).toEqual({ jobId: job.id, status: "succeeded" });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ id: job.id }),
      expect.anything(),
    );
    expect(written(after, "a")).toBe(true);
  });

  it("keeps queued jobs across a restart and runs them", async () => {
    const job = imported("a");
    db.close();
    open.splice(open.indexOf(db), 1);
    const after = reopen();
    const run = await runner(
      async () => ({ status: "succeeded", write: () => {} }),
      after,
    ).runOnce();
    expect(run).toEqual({ jobId: job.id, status: "succeeded" });
  });

  it("counts a job once when a late result from the earlier run arrives after the rerun", async () => {
    const job = imported("a");
    const late = deferred<JobResult>();
    const first = runner(() => late.promise).runOnce();
    await vi.waitFor(() => expect(readJob(db, job.id)?.status).toBe("running"));

    const other = reopen(); // a second connection runs it again after the lease ran out
    clock = new Date(T0.getTime() + LEASE);
    const rerun = runner(
      async () => ({ status: "succeeded", write: marked(other, "rerun") }),
      other,
    );
    expect(await rerun.runOnce()).toEqual({ jobId: job.id, status: "succeeded" });

    late.resolve({ status: "succeeded", write: marked(db, "late") });
    expect(await first).toEqual({ jobId: job.id, status: "not-leased" });
    expect(written(db, "late")).toBe(false);
    expect(written(db, "rerun")).toBe(true);
  });
});

describe("job runner: one job at a time (V02-R4)", () => {
  it("does not start a job before the one running has closed", async () => {
    const jobs = [imported(), imported(), imported()];
    const gates = new Map(jobs.map((j) => [j.id, deferred<JobResult>()]));
    let running = 0;
    let most = 0;
    const order: number[] = [];
    const r = runner(async (job) => {
      running++;
      most = Math.max(most, running);
      order.push(job.id);
      const result = await gates.get(job.id)?.promise;
      running--;
      if (!result) throw new Error("no gate");
      return result;
    });
    const drained = Promise.all([r.wake(), r.wake(), r.runOnce(), r.runOnce()]);
    for (const [i, gate] of [...gates.values()].entries()) {
      await vi.waitFor(() => expect(order).toHaveLength(i + 1));
      expect(running).toBe(1);
      gate.resolve({ status: "succeeded", write: () => {} });
    }
    await drained;
    expect(most).toBe(1);
    expect(order).toEqual(jobs.map((j) => j.id));
    expect(jobs.map((j) => readJob(db, j.id)?.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
  });
});

describe("job runner: outcomes other than a result", () => {
  it("holds a job the Broker did not run, with its reason, and does not claim it again", async () => {
    // e.g. the CLI background setting is off: the Broker blocks the call
    // (V01-T09) and the job waits, never moving to another Provider (ARCHITECTURE 7)
    const job = imported();
    const handler = vi.fn<JobHandler>(async () => ({
      status: "held",
      reason: "cli-background-off",
    }));
    const r = runner(handler);
    expect(await r.runOnce()).toEqual({ jobId: job.id, status: "held" });
    expect(readJob(db, job.id)).toMatchObject({ status: "held", reason: "cli-background-off" });
    clock = new Date(T0.getTime() + 10 * LEASE);
    expect(await r.runOnce()).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("retries a job whose handler throws, with a code, not the error text", async () => {
    const job = imported();
    const errors: unknown[] = [];
    const run = await runner(
      async () => {
        throw new Error("secret body text");
      },
      db,
      (e) => errors.push(e),
    ).runOnce();
    expect(run).toEqual({ jobId: job.id, status: "retry" });
    expect(readJob(db, job.id)).toMatchObject({
      status: "retry",
      reason: "handler-error",
      attempts: 1,
      runAfter: T0.getTime() + 30_000,
    });
    expect(errors).toHaveLength(1);
  });

  it("retries a job whose result cannot be written, keeping none of it", async () => {
    const job = imported();
    const run = await runner(async () => ({
      status: "succeeded",
      write: () => {
        marked(db, "partial")();
        throw new Error("constraint");
      },
    })).runOnce();
    expect(run).toEqual({ jobId: job.id, status: "retry" });
    expect(readJob(db, job.id)).toMatchObject({ status: "retry", reason: "write-error" });
    expect(written(db, "partial")).toBe(false);
  });

  it("leaves jobs of a kind it has no handler for untouched", async () => {
    const { job } = registerJob(db, {
      kind: "unhandled",
      sourceId: imported().sourceId as number,
      fenceVersion: 1,
    }) as {
      job: StoredJob;
    };
    const r = runner(async () => ({ status: "succeeded", write: () => {} }));
    await r.wake();
    expect(readJob(db, job.id)?.status).toBe("queued");
  });
});

describe("job runner: start and stop", () => {
  it("drains on start, picks up later jobs on the poll, and stops claiming after stop", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const handler = vi.fn<JobHandler>(async () => ({ status: "succeeded", write: () => {} }));
    const r = createJobRunner({
      db,
      handlers: { extract: handler },
      clock: testClock,
      testBuild: { leaseMs: LEASE },
      pollMs: 1000,
    });
    const first = imported();
    r.start();
    await vi.waitFor(() => expect(readJob(db, first.id)?.status).toBe("succeeded"));

    const second = imported();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(readJob(db, second.id)?.status).toBe("succeeded"));

    await r.stop();
    const third = imported();
    await vi.advanceTimersByTimeAsync(5000);
    expect(readJob(db, third.id)?.status).toBe("queued");
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe("job runner: stop while a job runs (V02-T03 rework)", () => {
  it("waits for the running job to close and claims nothing after it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const jobs = [imported(), imported(), imported()];
    const gate = deferred<JobResult>();
    const handler = vi.fn<JobHandler>(() => gate.promise);
    const r = runner(handler);
    r.start();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    void r.wake(); // e.g. an import finished while job 1 runs

    let stopped = false;
    const stopping = r.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(5000);
    expect(stopped).toBe(false);

    gate.resolve({ status: "succeeded", write: () => {} });
    await stopping;
    await vi.advanceTimersByTimeAsync(5000);
    expect(jobs.map((j) => readJob(db, j.id)?.status)).toEqual(["succeeded", "queued", "queued"]);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("job runner: failures that are not the result's (V02-T03 rework)", () => {
  it("leaves the job running when closing fails in the database, not as a write error", async () => {
    const job = imported();
    // locked once, at the first close only (another process held the file)
    let busy = true;
    const flaky: SqlDriver = {
      ...db,
      run: (sql, params) => {
        // the close's status write (it names the reason; the claim's reclaim does not)
        if (busy && sql.startsWith("UPDATE jobs SET status = ?") && sql.includes("reason = ?")) {
          busy = false;
          throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        }
        return db.run(sql, params);
      },
    };
    const errors: unknown[] = [];
    const write = vi.fn(marked(db, "busy"));
    const r = runner(
      async () => ({ status: "succeeded", write }),
      flaky,
      (e) => errors.push(e),
    );
    await expect(r.runOnce()).rejects.toMatchObject({ code: "SQLITE_BUSY" });
    expect(readJob(db, job.id)).toMatchObject({ status: "running", reason: null });
    expect(written(db, "busy")).toBe(false);

    clock = new Date(T0.getTime() + LEASE);
    expect(await r.runOnce()).toEqual({ jobId: job.id, status: "succeeded" });
    expect(written(db, "busy")).toBe(true);
  });

  it("fails a job whose handler gives a reason that is not a code, storing a fixed code", async () => {
    const job = imported();
    const run = await runner(async () => ({
      status: "held",
      reason: "Provider said: SECRET-BODY-TEXT",
    })).runOnce();
    expect(run).toEqual({ jobId: job.id, status: "dead_letter" });
    expect(readJob(db, job.id)).toMatchObject({ status: "dead_letter", reason: "invalid-reason" });
  });
});

describe("job runner: round 2 review (V02-T03)", () => {
  it("drains again after start when it was woken while stopped", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const r = runner(async () => ({ status: "succeeded", write: () => {} }));
    await r.stop();
    await r.wake(); // e.g. an import finished during shutdown
    const job = imported();
    r.start();
    await r.wake();
    await vi.waitFor(() => expect(readJob(db, job.id)?.status).toBe("succeeded"));
    await r.stop();
  });

  it("takes the write lock before writing: a file locked by another process leaves the job running", async () => {
    db.exec("PRAGMA busy_timeout = 0");
    const job = imported();
    const other = reopen();
    const write = vi.fn(marked(db, "locked"));
    let calls = 0;
    const r = runner(async () => {
      // the first time, another process takes the write lock while the call is out
      if (calls++ === 0) other.exec("BEGIN IMMEDIATE");
      return { status: "succeeded", write };
    });
    await expect(r.runOnce()).rejects.toMatchObject({ code: "SQLITE_BUSY" });
    expect(write).not.toHaveBeenCalled();
    other.exec("ROLLBACK");
    expect(readJob(db, job.id)).toMatchObject({ status: "running", reason: null });

    clock = new Date(T0.getTime() + LEASE);
    expect(await r.runOnce()).toEqual({ jobId: job.id, status: "succeeded" });
    expect(write).toHaveBeenCalledTimes(1);
    expect(written(db, "locked")).toBe(true);
  });

  it("leaves the job running when the write itself meets a locked file", async () => {
    const job = imported();
    const run = runner(async () => ({
      status: "succeeded",
      write: () => {
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_LOCKED" });
      },
    })).runOnce();
    await expect(run).rejects.toMatchObject({ code: "SQLITE_LOCKED" });
    expect(readJob(db, job.id)).toMatchObject({ status: "running", reason: null });
  });
});

describe("lease.token (I03-R4..R6): two runs contend for one job", () => {
  // The sequence of "두 실행이 한 작업을 다투는 경우": A claims and stalls past its
  // lease, B reclaims, claims and writes; A's heartbeat then fails, so A's signal is
  // cut and its late result is never written. Fake clock, fake interval timers.
  it("fails A's heartbeat and result write once B took the job: one effect", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const job = imported("a");
    const gate = deferred<JobResult>();
    let signal: AbortSignal | undefined;
    const aWrite = vi.fn(marked(db, "a"));
    const a = runner((_job, context) => {
      signal = context.signal;
      return gate.promise;
    });
    const aRun = a.runOnce();
    await vi.waitFor(() => expect(signal).toBeDefined());
    const aToken = readJob(db, job.id)?.leaseToken as number;

    clock = new Date(T0.getTime() + LEASE); // A stalled (sleep): its lease ran out
    const other = reopen();
    const b = runner(async () => ({ status: "succeeded", write: marked(other, "b") }), other);
    expect(await b.runOnce()).toEqual({ jobId: job.id, status: "succeeded" });
    expect(readJob(db, job.id)).toMatchObject({ status: "succeeded", leaseToken: aToken + 2 });

    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(LEASE / 4); // A's heartbeat: running under its token? no
    expect(signal?.aborted).toBe(true);

    gate.resolve({ status: "succeeded", write: aWrite });
    expect(await aRun).toEqual({ jobId: job.id, status: "not-leased" });
    expect(aWrite).not.toHaveBeenCalled();
    expect([written(db, "a"), written(db, "b")]).toEqual([false, true]);
  });

  it("keeps a long job's lease by heartbeat: a second runner reclaims nothing", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const job = imported("a");
    const gate = deferred<JobResult>();
    const a = runner(() => gate.promise);
    const aRun = a.runOnce();
    await vi.waitFor(() => expect(readJob(db, job.id)?.status).toBe("running"));
    const b = runner(async () => ({ status: "succeeded", write: () => {} }), reopen());
    for (let i = 1; i <= 12; i++) {
      clock = new Date(T0.getTime() + (i * LEASE) / 4);
      await vi.advanceTimersByTimeAsync(LEASE / 4);
      expect(await b.runOnce()).toBeUndefined();
    }
    expect(readJob(db, job.id)).toMatchObject({
      status: "running",
      leaseUntil: T0.getTime() + 4 * LEASE,
    });
    gate.resolve({ status: "succeeded", write: marked(db, "a") });
    expect(await aRun).toEqual({ jobId: job.id, status: "succeeded" });
  });

  it("lease.heartbeat-after-expiry: the same runner awake after sleep keeps its job and writes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const job = imported("a");
    const gate = deferred<JobResult>();
    let signal: AbortSignal | undefined;
    const a = runner((_job, context) => {
      signal = context.signal;
      return gate.promise;
    });
    const aRun = a.runOnce();
    await vi.waitFor(() => expect(signal).toBeDefined());
    clock = new Date(T0.getTime() + 3 * LEASE); // asleep three leases, no one took it
    await vi.advanceTimersByTimeAsync(LEASE / 4);
    expect(signal?.aborted).toBe(false);
    expect(readJob(db, job.id)?.leaseUntil).toBe(T0.getTime() + 4 * LEASE);
    gate.resolve({ status: "succeeded", write: marked(db, "a") });
    expect(await aRun).toEqual({ jobId: job.id, status: "succeeded" });
    expect(written(db, "a")).toBe(true);
  });

  it("stops heartbeating once the job closed", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    imported("a");
    await runner(async () => ({ status: "succeeded", write: () => {} })).runOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reads its clock for a claim only once the write lock is held (review RA-1)", async () => {
    db.exec("PRAGMA busy_timeout = 0");
    imported("a");
    const other = reopen();
    let reads = 0;
    const r = createJobRunner({
      db,
      handlers: { extract: async () => ({ status: "succeeded", write: () => {} }) },
      clock: { ...testClock, now: () => (reads++, clock.getTime()) },
      testBuild: { leaseMs: LEASE },
    });
    other.exec("BEGIN IMMEDIATE"); // another backend holds the lock
    await expect(r.runOnce()).rejects.toMatchObject({ code: "SQLITE_BUSY" });
    expect(reads).toBe(0);
    other.exec("ROLLBACK");
    expect(await r.runOnce()).toMatchObject({ status: "succeeded" });
  });

  it("names a new runner ID per runner as the lease owner", async () => {
    const first = imported("a");
    const second = imported("b");
    const owners: (string | null)[] = [];
    const handler: JobHandler = async (job) => {
      owners.push(readJob(db, job.id)?.leaseOwner ?? null);
      return { status: "succeeded", write: () => {} };
    };
    await runner(handler).runOnce();
    await runner(handler).runOnce();
    expect([first.id, second.id].map((id) => readJob(db, id)?.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
    expect(owners[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(owners[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(owners[0]).not.toBe(owners[1]);
  });
});

describe("lease.test-build (I03-R24): lease length and test kinds in a test build only", () => {
  // honoured in a test build only: createJobRunner enters testRunnerSettings when
  // the build kind is "test", which the bundler folds away from any other build
  // (a production bundle without it: apps/desktop/build/bundle.test.ts)
  const handlers = () => ({
    "test-effect": async () => ({ status: "held" as const, reason: "x" }),
  });

  it("defaults to a two-minute lease and a heartbeat at a quarter of it", () => {
    expect([DEFAULT_LEASE_MS, DEFAULT_HEARTBEAT_MS]).toEqual([120_000, 30_000]);
    expect(testRunnerSettings(undefined)).toEqual({
      leaseMs: DEFAULT_LEASE_MS,
      heartbeatMs: DEFAULT_HEARTBEAT_MS,
    });
  });

  it("takes the test options, the heartbeat at a quarter of the lease", () => {
    expect(testRunnerSettings({ leaseMs: 1000, pollMs: 50, handlers })).toEqual({
      leaseMs: 1000,
      heartbeatMs: 250,
      pollMs: 50,
      handlers,
    });
  });

  it("refuses a lease that is not a positive whole number of milliseconds", () => {
    for (const leaseMs of [0, -1, 1.5, Number.NaN]) {
      expect(() => testRunnerSettings({ leaseMs })).toThrow(RangeError);
    }
  });

  it("this runner (a test build) claims for the test lease and runs the test kinds' handlers", async () => {
    const { job } = registerJob(db, { kind: "test-effect", target: "t", at: clock }) as {
      job: StoredJob;
    };
    let until: number | null = null;
    const r = createJobRunner({
      db,
      handlers: {},
      clock: testClock,
      testBuild: {
        leaseMs: 1000,
        handlers: (on) => ({
          "test-effect": async (claimed) => {
            until = readJob(on, claimed.id)?.leaseUntil ?? null;
            return { status: "succeeded", write: () => {} };
          },
        }),
      },
    });
    expect(await r.runOnce()).toEqual({ jobId: job.id, status: "succeeded" });
    expect(until).toBe(T0.getTime() + 1000);
  });
});

describe("effect.fence-new-version (I03-R6 ③, C1): a result behind commitDerived", () => {
  const effectRows = (on: SqlDriver) =>
    on.all("SELECT key FROM settings WHERE key LIKE 'effect-%'").length;
  /** A result handed over as derived items, each writing one effect row. */
  const derived = (job: StoredJob, names: string[]): JobResult => ({
    status: "succeeded",
    items: names.map((name) => ({
      kind: "fact",
      itemKey: name,
      lineage: [{ sourceId: job.sourceId as number, version: job.fenceVersion as number }],
      write: marked(db, `effect-${name}`),
    })),
  });

  it("writes every item of a result whose version stayed the latest", async () => {
    const job = imported("a");
    const run = await runner(async (claimed) => derived(claimed, ["x", "y"])).runOnce();
    expect(run).toEqual({ jobId: job.id, status: "succeeded" });
    expect(effectRows(db)).toBe(2);
  });

  it("a new version arriving while the Provider answers: superseded, no effect row, no retry", async () => {
    const job = imported("a", "v1");
    const answer = deferred<undefined>();
    const r = runner(async (claimed) => {
      await answer.promise; // the extraction waits for the Provider
      return derived(claimed, ["x", "y"]);
    });
    const run = r.runOnce();
    await vi.waitFor(() => expect(readJob(db, job.id)?.status).toBe("running"));
    const next = imported("a", "v2");
    answer.resolve(undefined);
    expect(await run).toEqual({ jobId: job.id, status: "superseded" });
    expect(effectRows(db)).toBe(0);
    expect(readJob(db, job.id)).toMatchObject({ status: "superseded", finishedAt: T0.getTime() });
    expect((await r.runOnce())?.jobId).toBe(next.id); // only the new version's job is left
  });

  it("the source deleted while the Provider answers: superseded, no effect row", async () => {
    const job = imported("a");
    const answer = deferred<undefined>();
    const run = runner(async (claimed) => {
      await answer.promise;
      return derived(claimed, ["x"]);
    }).runOnce();
    await vi.waitFor(() => expect(readJob(db, job.id)?.status).toBe("running"));
    db.transaction(() => {
      db.run("DELETE FROM source_versions WHERE source_id = ?", [job.sourceId]);
      seedLegacyTombstone(db, {
        sourceId: job.sourceId as number,
        version: 1,
        at: "x",
        reason: "source-deleted",
      });
    });
    answer.resolve(undefined);
    expect(await run).toEqual({ jobId: job.id, status: "superseded" });
    expect(effectRows(db)).toBe(0);
  });
});

describe("outcome.mapping (I03-R9..R11): the runner stores what the table says", () => {
  const broker = { requestId: "r", attempts: 1 };

  it("retries a transient Broker failure after its backoff, on the injected clock", async () => {
    const job = imported();
    const results: JobResult[] = [
      { status: "failed", error: "provider-error", ...broker },
      { status: "failed", error: "rate-limited", ...broker },
      { status: "succeeded", write: marked(db, "third") },
    ];
    const handler = vi.fn<JobHandler>(async () => results.shift() as JobResult);
    const r = runner(handler);
    clock = new Date(T0.getTime() + 7);
    expect(await r.runOnce()).toEqual({ jobId: job.id, status: "retry" });
    expect(readJob(db, job.id)).toMatchObject({
      status: "retry",
      reason: "provider-error",
      attempts: 1,
      runAfter: T0.getTime() + 7 + 30_000,
      updatedAt: T0.getTime() + 7,
    });
    clock = new Date(T0.getTime() + 7 + 29_999);
    expect(await r.runOnce()).toBeUndefined();
    clock = new Date(T0.getTime() + 7 + 30_000);
    expect(await r.runOnce()).toEqual({ jobId: job.id, status: "retry" });
    // the second attempt would wait a minute; a rate limit waits five
    expect(readJob(db, job.id)).toMatchObject({
      reason: "rate-limited",
      attempts: 2,
      runAfter: clock.getTime() + 5 * 60_000,
    });
    clock = new Date(clock.getTime() + 5 * 60_000);
    expect(await r.runOnce()).toEqual({ jobId: job.id, status: "succeeded" });
    expect(readJob(db, job.id)).toMatchObject({ status: "succeeded", attempts: 3, reason: null });
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("gives up a job that fails every attempt, and one whose kind allows fewer sooner", async () => {
    const run = async (settings?: JobKindSettings) => {
      const job = imported();
      const handler = vi.fn<JobHandler>(async () => ({
        status: "fail",
        code: "storage-failed",
        retryable: true,
      }));
      const r = runner(handler, db, undefined, settings);
      for (let i = 0; i < 10; i++) {
        clock = new Date(clock.getTime() + 60 * 60_000);
        await r.runOnce();
      }
      expect(readJob(db, job.id)).toMatchObject({
        status: "dead_letter",
        reason: "storage-failed",
      });
      return handler.mock.calls.length;
    };
    expect(await run()).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(await run({ maxAttempts: 2 })).toBe(2);
  });

  it("gives up at once a failure that cannot be retried, and a superseded job stays closed", async () => {
    const failed = imported();
    const stale = imported();
    const results: JobResult[] = [
      { status: "fail", code: "missing-version", retryable: false },
      { status: "rejected", reason: "missing-source" },
    ];
    const r = runner(async () => results.shift() as JobResult);
    expect(await r.runOnce()).toEqual({ jobId: failed.id, status: "dead_letter" });
    expect(await r.runOnce()).toEqual({ jobId: stale.id, status: "superseded" });
    expect(readJob(db, failed.id)).toMatchObject({ reason: "missing-version", attempts: 1 });
  });

  it("queues a yield that moved its checkpoint a minute later, unspent; one that did not is a retry", async () => {
    const job = imported();
    let step = 0;
    const r = runner(
      async (_job, context) => {
        if (step < 2) context.checkpoint({ step: ++step });
        return { status: "yield" };
      },
      db,
      undefined,
      { checkpointFields: ["step"] },
    );
    for (const expected of [1, 2]) {
      expect(await r.runOnce()).toEqual({ jobId: job.id, status: "queued" });
      expect(readJob(db, job.id)).toMatchObject({
        status: "queued",
        attempts: 0,
        checkpoint: `{"step":${expected}}`,
        runAfter: clock.getTime() + 60_000,
      });
      clock = new Date(clock.getTime() + 60_000);
    }
    expect(await r.runOnce()).toEqual({ jobId: job.id, status: "retry" });
    expect(readJob(db, job.id)).toMatchObject({ reason: "yield-no-progress", attempts: 1 });
  });
});

describe("attempts.refund (I03-R11, C3): runs the Broker did not let out spend no attempt", () => {
  it("held and released ten times: zero attempts; then a failure leaves four; a spent budget none", async () => {
    const job = imported();
    let result: JobResult = { status: "blocked", requestId: "r", reason: "cli-background-off" };
    const handler = vi.fn<JobHandler>(async () => result);
    const r = runner(handler);
    for (let i = 0; i < 10; i++) {
      expect(await r.runOnce()).toEqual({ jobId: job.id, status: "held" });
      expect(readJob(db, job.id)).toMatchObject({
        status: "held",
        reason: "cli-background-off",
        attempts: 0,
      });
      expect(requeueHeldReasons(db, { reasons: ["cli-background-off"] })).toBe(1); // the setting changed: judged anew
    }
    result = { status: "blocked", requestId: "r", reason: "budget-exhausted" };
    expect(await r.runOnce()).toEqual({ jobId: job.id, status: "retry" });
    expect(readJob(db, job.id)).toMatchObject({
      status: "retry",
      reason: "budget-exhausted",
      attempts: 0,
    });
    clock = new Date(T0.getTime() + 60 * 60_000);
    result = { status: "failed", error: "provider-error", requestId: "r", attempts: 1 };
    expect(await r.runOnce()).toEqual({ jobId: job.id, status: "retry" });
    const { attempts } = readJob(db, job.id) as StoredJob;
    expect(DEFAULT_MAX_ATTEMPTS - attempts).toBe(4);
    expect(handler).toHaveBeenCalledTimes(12);
  });
});

describe("run-timeout (I03-R14, C3): a run over its time on the monotonic clock", () => {
  it("cuts the signal and retries the job, without waiting for its handler", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const job = imported();
    let signal: AbortSignal | undefined;
    const late = deferred<JobResult>();
    const lateWrite = vi.fn(marked(db, "late"));
    const r = runner((_job, context) => {
      signal = context.signal;
      return late.promise; // ignores its signal
    });
    let run: unknown;
    void r.runOnce().then((done) => (run = done));
    await vi.waitFor(() => expect(signal).toBeDefined());

    expect(DEFAULT_RUN_TIMEOUT_MS).toBe(600_000);
    mono = DEFAULT_RUN_TIMEOUT_MS - 1;
    clock = new Date(T0.getTime() + 3 * 24 * 3_600_000); // the wall clock jumping is not run time
    await vi.advanceTimersByTimeAsync(LEASE / 4);
    expect(signal?.aborted).toBe(false);
    expect(run).toBeUndefined();
    expect(readJob(db, job.id)?.status).toBe("running");

    mono = DEFAULT_RUN_TIMEOUT_MS;
    await vi.advanceTimersByTimeAsync(LEASE / 4);
    expect(signal?.aborted).toBe(true);
    await vi.waitFor(() => expect(run).toEqual({ jobId: job.id, status: "retry" }));
    expect(readJob(db, job.id)).toMatchObject({
      status: "retry",
      reason: "run-timeout",
      attempts: 1,
      runAfter: clock.getTime() + 30_000,
      leaseUntil: null,
    });
    expect(vi.getTimerCount()).toBe(0);

    late.resolve({ status: "succeeded", write: lateWrite }); // its result comes too late
    await vi.advanceTimersByTimeAsync(0);
    expect(lateWrite).not.toHaveBeenCalled();
    expect(readJob(db, job.id)?.status).toBe("retry");
  });

  it("takes the limit of the job's kind", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const job = imported();
    const run = runner(() => new Promise<never>(() => {}), db, undefined, {
      runTimeoutMs: 1000,
    }).runOnce();
    await vi.waitFor(() => expect(readJob(db, job.id)?.status).toBe("running"));
    mono = 1000;
    await vi.advanceTimersByTimeAsync(LEASE / 4);
    expect(await run).toEqual({ jobId: job.id, status: "retry" });
  });

  it("a run within its time keeps its lease and result", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const job = imported();
    const gate = deferred<JobResult>();
    const run = runner(() => gate.promise).runOnce();
    await vi.waitFor(() => expect(readJob(db, job.id)?.status).toBe("running"));
    mono = DEFAULT_RUN_TIMEOUT_MS - 1;
    await vi.advanceTimersByTimeAsync(LEASE / 4);
    gate.resolve({ status: "succeeded", write: marked(db, "in-time") });
    expect(await run).toEqual({ jobId: job.id, status: "succeeded" });
    expect(written(db, "in-time")).toBe(true);
  });
});

describe("a run that lost its job ends without its handler (I03-R14, review A-F1)", () => {
  const never = () => new Promise<never>(() => {}); // ignores its signal

  it("lease lost mid-run: the run ends not-leased, the next job is claimed, stop returns", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const lost = imported("a");
    const next = imported("b");
    let signal: AbortSignal | undefined;
    const handler = vi.fn<JobHandler>((job, context) => {
      if (job.id !== lost.id) return Promise.resolve({ status: "succeeded", write: () => {} });
      signal = context.signal;
      return never();
    });
    const r = runner(handler);
    const run = r.runOnce();
    await vi.waitFor(() => expect(signal).toBeDefined());
    supersedeOpenJobs(db, lost.sourceId as number); // the source is deleted: the token is raised
    await vi.advanceTimersByTimeAsync(LEASE / 4); // the heartbeat fails
    expect(signal?.aborted).toBe(true);
    expect(await run).toEqual({ jobId: lost.id, status: "not-leased" });
    expect(readJob(db, lost.id)).toMatchObject({ status: "superseded", reason: "source-closed" });
    expect(vi.getTimerCount()).toBe(0);

    expect(await r.runOnce()).toEqual({ jobId: next.id, status: "succeeded" });
    await r.stop();
    expect(heartbeatJob(db, lost, { now: clock, leaseMs: LEASE })).toBe(false);
  });

  it("a step that closed the job: the run ends with the step's answer, the next job is claimed, stop returns", async () => {
    const cancelled = imported("a");
    const next = imported("b");
    let answer: string | undefined;
    const handler = vi.fn<JobHandler>((job, context) => {
      if (job.id !== cancelled.id) return Promise.resolve({ status: "succeeded", write: () => {} });
      db.run("UPDATE jobs SET cancel_requested = 1 WHERE id = ?", [job.id]); // the user cancels
      answer = context.checkpoint({ step: 1 }, marked(db, "step-1"));
      return never(); // keeps waiting, whatever the step answered
    });
    const r = runner(handler, db, undefined, { checkpointFields: ["step"] });
    expect(await r.runOnce()).toEqual({ jobId: cancelled.id, status: "cancelled" });
    expect(answer).toBe("cancelled");
    expect(written(db, "step-1")).toBe(false);
    expect(await r.runOnce()).toEqual({ jobId: next.id, status: "succeeded" });
    await r.stop();
  });
});

describe("a result outside the declared ones (I03-R9, review A-F2)", () => {
  it("is the retryable failure handler-error, the run not rejected and the job not left running", async () => {
    const outside: unknown[] = [undefined, { status: "done" }, { status: "succeeded" }, "ok"];
    for (const result of outside) {
      const job = imported();
      const run = await runner(async () => result as JobResult).runOnce();
      expect(run).toEqual({ jobId: job.id, status: "retry" });
      expect(readJob(db, job.id)).toMatchObject({
        status: "retry",
        reason: "handler-error",
        attempts: 1,
      });
    }
  });
});

describe("a handler cannot name the runner's own endings (review A R2-N1)", () => {
  it("a result that is the text of an ending is the handler's undeclared result: handler-error", async () => {
    for (const text of ["lost", "run-timeout"]) {
      const job = imported();
      const run = await runner(async () => text as unknown as JobResult).runOnce();
      expect(run).toEqual({ jobId: job.id, status: "retry" });
      expect(readJob(db, job.id)).toMatchObject({ status: "retry", reason: "handler-error" });
    }
  });
});

describe("checkpoint.resume (I03-R8, C1): a job claimed again goes on from its checkpoint", () => {
  const STEPS = { checkpointFields: ["step"] };
  const stepRows = (on: SqlDriver) =>
    on.all("SELECT key FROM settings WHERE key LIKE 'step-%' ORDER BY key").map((r) => r.key);
  /** Three steps, each one effect row with its checkpoint; `stopAfter` hangs like a killed run. */
  const stepped =
    (on: SqlDriver, ran: number[], stopAfter?: number): JobHandler =>
    async (_job, context) => {
      for (let step = (context.lastCheckpoint?.step ?? 0) + 1; step <= 3; step++) {
        ran.push(step);
        context.checkpoint({ step }, marked(on, `step-${step}`));
        if (step === stopAfter) await new Promise<never>(() => {});
      }
      return { status: "succeeded", write: marked(on, "step-done") };
    };

  it("stopped after step 2, it resumes at step 3: one effect row per step", async () => {
    const job = imported("a");
    const first: number[] = [];
    void runner(stepped(db, first, 2), db, undefined, STEPS).runOnce();
    await vi.waitFor(() => expect(first).toEqual([1, 2]));
    expect(readJob(db, job.id)).toMatchObject({ status: "running", checkpoint: '{"step":2}' });
    db.close(); // the backend stops with the job running, two steps written
    open.splice(open.indexOf(db), 1);

    const after = reopen();
    const second: number[] = [];
    const restarted = runner(stepped(after, second), after, undefined, STEPS);
    clock = new Date(T0.getTime() + LEASE);
    expect(await restarted.runOnce()).toEqual({ jobId: job.id, status: "succeeded" });
    expect(second).toEqual([3]);
    expect(stepRows(after)).toEqual(["step-1", "step-2", "step-3", "step-done"]);
    expect(readJob(after, job.id)).toMatchObject({ status: "succeeded", checkpoint: null });
  });

  it("a step refused by the checks ends the run: the signal is cut and its result is not written", async () => {
    const job = imported("a");
    let signal: AbortSignal | undefined;
    const run = await runner(
      async (_job, context) => {
        signal = context.signal;
        db.run("UPDATE jobs SET cancel_requested = 1 WHERE id = ?", [job.id]); // the user cancels
        expect(context.checkpoint({ step: 1 }, marked(db, "step-1"))).toBe("cancelled");
        return { status: "succeeded", write: marked(db, "step-done") };
      },
      db,
      undefined,
      STEPS,
    ).runOnce();
    expect(run).toEqual({ jobId: job.id, status: "cancelled" });
    expect(signal?.aborted).toBe(true);
    expect(stepRows(db)).toEqual([]);
    expect(readJob(db, job.id)?.status).toBe("cancelled");
  });

  it("a kind that declared no checkpoint fields cannot write one", async () => {
    const job = imported("a");
    const run = await runner(async (_job, context) => {
      context.checkpoint({ step: 1 });
      return { status: "succeeded", write: () => {} };
    }).runOnce();
    expect(run).toEqual({ jobId: job.id, status: "retry" });
    expect(readJob(db, job.id)).toMatchObject({ reason: "handler-error", checkpoint: null });
  });
});

describe("jobs.no-content (I03-R2, R8, R9, C1): a job row never holds source text", () => {
  const CANARY = "CANARY-7f3a-source-body";

  it("keeps the canary out of the row and the checkpoint, whatever the handler tries", async () => {
    const tries: JobHandler[] = [
      async () => {
        throw new Error(`could not parse: ${CANARY}`);
      },
      async (_job, context) => {
        context.checkpoint({ step: CANARY } as never);
        return { status: "succeeded", write: () => {} };
      },
      async (_job, context) => {
        context.checkpoint({ [CANARY]: 1 });
        return { status: "succeeded", write: () => {} };
      },
      async () => ({ status: "held", reason: CANARY }),
      async () => ({ status: "fail", code: CANARY, retryable: true }),
      async () => ({ status: "blocked", requestId: "r", reason: CANARY }),
      async () => ({
        status: "succeeded",
        write: () => {
          throw new Error(CANARY);
        },
      }),
    ];
    for (const handler of tries) {
      imported(undefined, CANARY); // the source's body is the canary
      await runner(handler, db, () => {}, { checkpointFields: ["step"] }).runOnce();
    }
    const rows = db.all("SELECT * FROM jobs");
    expect(rows).toHaveLength(tries.length);
    expect(rows.map((r) => r.status).sort()).toEqual([
      "dead_letter",
      "dead_letter",
      "dead_letter",
      "retry",
      "retry",
      "retry",
      "retry",
    ]);
    expect(JSON.stringify(rows)).not.toContain("CANARY");
    expect(rows.every((r) => r.checkpoint === null)).toBe(true);
  });
});

describe("the scope policy reaches the runner's writes (I04-R11, I04-T09)", () => {
  const refusing = createCommitScope({
    policy: { combinable: () => false },
    now: () => T0.toISOString(),
  });
  const scoped = (handler: JobHandler, settings?: JobKindSettings) =>
    createJobRunner({
      db,
      handlers: { extract: handler },
      clock: testClock,
      testBuild: { leaseMs: LEASE },
      scope: refusing,
      ...(settings && { kinds: { extract: settings } }),
    });

  it("hands the scope to the closing's write: the refused item is left out and the job still succeeds", async () => {
    const job = imported("a");
    const run = await scoped(async () => ({
      status: "succeeded",
      write: marked(db, "closing"),
    })).runOnce();
    expect(run).toEqual({ jobId: job.id, status: "succeeded" });
    expect(written(db, "closing")).toBe(false);
    expect(db.all("SELECT count(*) AS n FROM scope_policy_drops")).toEqual([{ n: 1 }]);
  });

  it("hands the scope to a checkpoint's write too", async () => {
    const job = imported("a");
    let answer: string | undefined;
    const run = await scoped(
      async (_job, context) => {
        answer = context.checkpoint({ step: 1 }, marked(db, "step"));
        return { status: "succeeded", write: () => {} };
      },
      { checkpointFields: ["step"] },
    ).runOnce();
    expect(run).toEqual({ jobId: job.id, status: "succeeded" });
    expect(answer).toBe("saved");
    expect(written(db, "step")).toBe(false);
    expect(db.all("SELECT count(*) AS n FROM scope_policy_drops")).toEqual([{ n: 1 }]);
  });

  it("writes everything when no scope is handed over (the default policy)", async () => {
    imported("a");
    await runner(async () => ({ status: "succeeded", write: marked(db, "plain") })).runOnce();
    expect(written(db, "plain")).toBe(true);
  });
});
