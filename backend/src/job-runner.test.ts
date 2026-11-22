// V02-R4, R5, C3 integration on a real SQLite file: the runner claims jobs with an
// expiring lease, one at a time, picks up a job left running by a backend that
// stopped once the lease runs out, and discards a result whose version went
// stale before it was written. Clocks are injected; nothing sleeps.
import {
  readJob,
  registerConnectorInstance,
  registerJob,
  saveSourceRecord,
  writeTombstone,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openCanonicalDb } from "./composition.ts";
import {
  createJobRunner,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_LEASE_MS,
  testRunnerSettings,
  type JobHandler,
  type JobResult,
} from "./job-runner.ts";

let dir: string;
let db: SqlDriver;
const open: SqlDriver[] = [];

const T0 = new Date("2026-11-21T00:00:00.000Z");
const LEASE = 60_000;
let clock = T0;
const now = () => clock;

function reopen(): SqlDriver {
  const next = openCanonicalDb(join(dir, "data"));
  open.push(next);
  return next;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-jobs-"));
  db = reopen();
  clock = T0;
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

const runner = (handler: JobHandler, on = db, onError?: (e: unknown) => void) =>
  createJobRunner({
    db: on,
    handlers: { extract: handler },
    now,
    testBuild: { leaseMs: LEASE },
    ...(onError && { onError }),
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
        writeTombstone(db, {
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

  it("fails a job whose handler throws with a code, not the error text", async () => {
    const job = imported();
    const errors: unknown[] = [];
    const run = await runner(
      async () => {
        throw new Error("secret body text");
      },
      db,
      (e) => errors.push(e),
    ).runOnce();
    expect(run).toEqual({ jobId: job.id, status: "dead_letter" });
    expect(readJob(db, job.id)).toMatchObject({ status: "dead_letter", reason: "handler-error" });
    expect(errors).toHaveLength(1);
  });

  it("fails a job whose result cannot be written, keeping none of it", async () => {
    const job = imported();
    const run = await runner(async () => ({
      status: "succeeded",
      write: () => {
        marked(db, "partial")();
        throw new Error("constraint");
      },
    })).runOnce();
    expect(run).toEqual({ jobId: job.id, status: "dead_letter" });
    expect(readJob(db, job.id)).toMatchObject({ status: "dead_letter", reason: "write-error" });
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
      now,
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
      now: () => (reads++, clock),
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
      now,
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
