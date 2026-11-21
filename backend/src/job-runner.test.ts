// V02-R4, R5, C3 integration on a real SQLite file: the runner claims jobs with an
// expiring lease, one at a time, picks up a job left leased by a backend that
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
import { createJobRunner, type JobHandler, type JobResult } from "./job-runner.ts";

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
    leaseMs: LEASE,
    ...(onError && { onError }),
  });

describe("job runner: version fence (V02-R5)", () => {
  it("writes the result of a job whose version is still the latest and closes it done", async () => {
    const job = imported("a");
    const run = await runner(async () => ({ status: "done", write: marked(db, "a") })).runOnce();
    expect(run).toEqual({ jobId: job.id, status: "done" });
    expect(written(db, "a")).toBe(true);
    expect(readJob(db, job.id)).toMatchObject({ status: "done", leaseUntil: null });
  });

  it("discards a result whose source got a new version while it ran: superseded", async () => {
    const job = imported("a", "v1");
    const run = await runner(async () => {
      imported("a", "v2"); // a newer version arrives while the Broker call is out
      return { status: "done", write: marked(db, "stale") };
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
        writeTombstone(db, { sourceId: job.sourceId, version: 1, at: "x", reason: "deleted" });
      });
      return { status: "done", write: marked(db, "deleted") };
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
  it("resumes a job left leased by a stopped backend once its lease runs out", async () => {
    const job = imported("a");
    const before = runner(() => new Promise<never>(() => {})); // the call never returns
    void before.runOnce();
    await vi.waitFor(() => expect(readJob(db, job.id)?.status).toBe("leased"));
    db.close(); // the backend stops with the job leased
    open.splice(open.indexOf(db), 1);

    const after = reopen();
    const handler = vi.fn<JobHandler>(async () => ({ status: "done", write: marked(after, "a") }));
    const restarted = runner(handler, after);
    clock = new Date(T0.getTime() + LEASE - 1);
    expect(await restarted.runOnce()).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();

    clock = new Date(T0.getTime() + LEASE);
    expect(await restarted.runOnce()).toEqual({ jobId: job.id, status: "done" });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(written(after, "a")).toBe(true);
  });

  it("keeps queued jobs across a restart and runs them", async () => {
    const job = imported("a");
    db.close();
    open.splice(open.indexOf(db), 1);
    const after = reopen();
    const run = await runner(async () => ({ status: "done", write: () => {} }), after).runOnce();
    expect(run).toEqual({ jobId: job.id, status: "done" });
  });

  it("counts a job once when a late result from the earlier run arrives after the rerun", async () => {
    const job = imported("a");
    const late = deferred<JobResult>();
    const first = runner(() => late.promise).runOnce();
    await vi.waitFor(() => expect(readJob(db, job.id)?.status).toBe("leased"));

    const other = reopen(); // a second connection runs it again after the lease ran out
    clock = new Date(T0.getTime() + LEASE);
    const rerun = runner(async () => ({ status: "done", write: marked(other, "rerun") }), other);
    expect(await rerun.runOnce()).toEqual({ jobId: job.id, status: "done" });

    late.resolve({ status: "done", write: marked(db, "late") });
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
      gate.resolve({ status: "done", write: () => {} });
    }
    await drained;
    expect(most).toBe(1);
    expect(order).toEqual(jobs.map((j) => j.id));
    expect(jobs.map((j) => readJob(db, j.id)?.status)).toEqual(["done", "done", "done"]);
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
    expect(run).toEqual({ jobId: job.id, status: "failed" });
    expect(readJob(db, job.id)).toMatchObject({ status: "failed", reason: "handler-error" });
    expect(errors).toHaveLength(1);
  });

  it("fails a job whose result cannot be written, keeping none of it", async () => {
    const job = imported();
    const run = await runner(async () => ({
      status: "done",
      write: () => {
        marked(db, "partial")();
        throw new Error("constraint");
      },
    })).runOnce();
    expect(run).toEqual({ jobId: job.id, status: "failed" });
    expect(readJob(db, job.id)).toMatchObject({ status: "failed", reason: "write-error" });
    expect(written(db, "partial")).toBe(false);
  });

  it("leaves jobs of a kind it has no handler for untouched", async () => {
    const { job } = registerJob(db, {
      kind: "unhandled",
      sourceId: imported().sourceId,
      fenceVersion: 1,
    }) as {
      job: StoredJob;
    };
    const r = runner(async () => ({ status: "done", write: () => {} }));
    await r.wake();
    expect(readJob(db, job.id)?.status).toBe("queued");
  });
});

describe("job runner: start and stop", () => {
  it("drains on start, picks up later jobs on the poll, and stops claiming after stop", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const handler = vi.fn<JobHandler>(async () => ({ status: "done", write: () => {} }));
    const r = createJobRunner({
      db,
      handlers: { extract: handler },
      now,
      leaseMs: LEASE,
      pollMs: 1000,
    });
    const first = imported();
    r.start();
    await vi.waitFor(() => expect(readJob(db, first.id)?.status).toBe("done"));

    const second = imported();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(readJob(db, second.id)?.status).toBe("done"));

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

    gate.resolve({ status: "done", write: () => {} });
    await stopping;
    await vi.advanceTimersByTimeAsync(5000);
    expect(jobs.map((j) => readJob(db, j.id)?.status)).toEqual(["done", "queued", "queued"]);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("job runner: failures that are not the result's (V02-T03 rework)", () => {
  it("leaves the job leased when closing fails in the database, not as a write error", async () => {
    const job = imported();
    // locked once, at the first close only (another process held the file)
    let busy = true;
    const flaky: SqlDriver = {
      ...db,
      run: (sql, params) => {
        if (busy && sql.startsWith("UPDATE jobs SET status = ?")) {
          busy = false;
          throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        }
        return db.run(sql, params);
      },
    };
    const errors: unknown[] = [];
    const write = vi.fn(marked(db, "busy"));
    const r = runner(
      async () => ({ status: "done", write }),
      flaky,
      (e) => errors.push(e),
    );
    await expect(r.runOnce()).rejects.toMatchObject({ code: "SQLITE_BUSY" });
    expect(readJob(db, job.id)).toMatchObject({ status: "leased", reason: null });
    expect(written(db, "busy")).toBe(false);

    clock = new Date(T0.getTime() + LEASE);
    expect(await r.runOnce()).toEqual({ jobId: job.id, status: "done" });
    expect(written(db, "busy")).toBe(true);
  });

  it("fails a job whose handler gives a reason that is not a code, storing a fixed code", async () => {
    const job = imported();
    const run = await runner(async () => ({
      status: "held",
      reason: "Provider said: SECRET-BODY-TEXT",
    })).runOnce();
    expect(run).toEqual({ jobId: job.id, status: "failed" });
    expect(readJob(db, job.id)).toMatchObject({ status: "failed", reason: "invalid-reason" });
  });
});
