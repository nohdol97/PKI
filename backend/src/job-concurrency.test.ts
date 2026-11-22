// I03-R13, C3 (I03-T05) through the runner on a real SQLite file: jobs of
// different groups run together within the overall limit (the setting
// `jobs.maxConcurrent`, read at every claim), a full group is skipped, the jobs
// the runner holds are not reclaimed, and fairness keys take turns from the
// runner's memory. Handlers are gated by the test; clocks are injected.
import {
  closeJob,
  readJob,
  registerConnectorInstance,
  registerJob,
  saveSourceRecord,
  supersedeOpenJobs,
  writeSetting,
  type JobPriority,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clock } from "./clock.ts";
import { openCanonicalDb } from "./composition.ts";
import {
  createJobRunner,
  JOBS_MAX_CONCURRENT_SETTING,
  readMaxConcurrent,
  type JobHandler,
  type JobResult,
  type JobRunner,
} from "./job-runner.ts";

let dir: string;
let db: SqlDriver;

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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-jobs-concurrency-"));
  db = openCanonicalDb(join(dir, "data"));
  clock = T0;
  mono = 0;
  registerConnectorInstance(db, "A", "test-fixtures");
  registerConnectorInstance(db, "B", "test-fixtures");
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

function queued(job: Parameters<typeof registerJob>[1]): StoredJob {
  const r = registerJob(db, { at: now(), ...job });
  if (!r.registered) throw new Error("expected a new job");
  return r.job;
}

let seq = 0;
function extract(connector: string, priority?: JobPriority): StoredJob {
  const saved = saveSourceRecord(db, connector, { externalId: `e${++seq}`, title: "t", body: "b" });
  if (saved.status !== "created") throw new Error("expected a new source");
  return queued({
    kind: "extract",
    sourceId: saved.sourceId,
    fenceVersion: 1,
    ...(priority ? { priority } : {}),
  });
}
const sync = (instance: string, priority?: JobPriority) =>
  queued({ kind: "connector-sync", target: instance, ...(priority ? { priority } : {}) });
const rebuild = (target: string) => queued({ kind: "projection-rebuild", target });

const KINDS = ["extract", "connector-sync", "projection-rebuild", "maintenance"];
const DONE: JobResult = { status: "succeeded", write: () => {} };

/** A runner whose handlers wait for the test: what runs now, what ran, in which order. */
function gated(onError?: (e: unknown) => void, pollMs?: number) {
  const gates = new Map<number, (result: JobResult) => void>();
  const started: number[] = [];
  let mostAtOnce = 0;
  let mostExtracts = 0;
  const handler: JobHandler = (job) => {
    started.push(job.id);
    return new Promise<JobResult>((resolve) => {
      gates.set(job.id, (result) => {
        gates.delete(job.id);
        resolve(result);
      });
      mostAtOnce = Math.max(mostAtOnce, gates.size);
      const kinds = [...gates.keys()].map((id) => readJob(db, id)?.kind);
      mostExtracts = Math.max(mostExtracts, kinds.filter((k) => k === "extract").length);
    });
  };
  const runner: JobRunner = createJobRunner({
    db,
    handlers: Object.fromEntries(KINDS.map((kind) => [kind, handler])),
    clock: testClock,
    testBuild: { leaseMs: LEASE, ...(pollMs === undefined ? {} : { pollMs }) },
    ...(onError && { onError }),
  });
  return {
    runner,
    started,
    running: () => [...gates.keys()].sort((a, b) => a - b),
    finish: (id: number, result: JobResult = DONE) => {
      const gate = gates.get(id);
      if (!gate) throw new Error(`job ${id} is not running`);
      gate(result);
    },
    most: () => ({ atOnce: mostAtOnce, extracts: mostExtracts }),
  };
}

const status = (job: StoredJob) => readJob(db, job.id)?.status;
const count = (jobs: StoredJob[], wanted: string) =>
  jobs.filter((job) => status(job) === wanted).length;
// Sourceless jobs share their kind as fairness key (I03-R13), so which of two
// syncs or of a sync and a rebuild is claimed next follows the turns, not the
// IDs: the tests below count what runs and name a job only where the order is theirs.

describe("concurrency.groups (I03-R13, C3): the runner runs jobs together", () => {
  it("runs a knowledge job and a sync together, never two knowledge jobs", async () => {
    const jobs = [extract("A"), extract("A"), extract("B"), sync("A")];
    const g = gated();
    const drained = g.runner.wake();
    await vi.waitFor(() => expect(g.running()).toEqual([jobs[0]?.id, jobs[3]?.id]));
    // the second extract was the front candidate; the sync behind it runs instead
    expect(status(jobs[1] as StoredJob)).toBe("queued");

    g.finish(jobs[3]?.id as number);
    await vi.waitFor(() => expect(status(jobs[3] as StoredJob)).toBe("succeeded"));
    expect(g.running()).toEqual([jobs[0]?.id]); // a free place, but knowledge is full

    g.finish(jobs[0]?.id as number);
    await vi.waitFor(() => expect(g.running()).toHaveLength(1));
    g.finish(g.running()[0] as number);
    await vi.waitFor(() => expect(g.running()).toHaveLength(1));
    g.finish(g.running()[0] as number);
    await drained;
    expect(jobs.map(status)).toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
    expect(g.most()).toEqual({ atOnce: 2, extracts: 1 });
  });

  it("runs at most two jobs by default, starting the next as one closes", async () => {
    expect(readMaxConcurrent(db)).toBe(2);
    const jobs = [sync("A"), sync("B"), rebuild("engine"), queued({ kind: "maintenance" })];
    const g = gated();
    const drained = g.runner.wake();
    await vi.waitFor(() => expect(g.running()).toHaveLength(2));
    expect(count(jobs, "queued")).toBe(2);
    g.finish(g.running()[0] as number);
    await vi.waitFor(() => expect(g.started).toHaveLength(3));
    expect(g.running()).toHaveLength(2);
    for (const id of g.running()) g.finish(id);
    await vi.waitFor(() => expect(g.started).toHaveLength(4));
    g.finish(g.running()[0] as number);
    await drained;
    expect(g.most().atOnce).toBe(2);
    expect(count(jobs, "succeeded")).toBe(4);
  });

  it("runs one job at a time when the setting is 1, whatever the groups", async () => {
    writeSetting(db, JOBS_MAX_CONCURRENT_SETTING, "1");
    const jobs = [extract("A"), sync("A"), rebuild("engine")];
    const g = gated();
    const drained = g.runner.wake();
    for (const job of jobs) {
      await vi.waitFor(() => expect(g.running()).toEqual([job.id]));
      g.finish(job.id);
    }
    await drained;
    expect(g.most().atOnce).toBe(1);
    expect(g.started).toEqual(jobs.map((j) => j.id));
  });

  it("runs four jobs of four groups when the setting is 4, and no fifth", async () => {
    writeSetting(db, JOBS_MAX_CONCURRENT_SETTING, "4");
    const jobs = [
      extract("A"),
      sync("A"),
      sync("B"),
      rebuild("engine"),
      queued({ kind: "maintenance" }),
    ];
    const g = gated();
    const drained = g.runner.wake();
    await vi.waitFor(() => expect(g.running()).toHaveLength(4));
    expect(count(jobs, "queued")).toBe(1);
    for (const id of g.running()) g.finish(id);
    await vi.waitFor(() => expect(g.started).toHaveLength(5));
    g.finish(g.running()[0] as number);
    await drained;
    expect(g.most().atOnce).toBe(4);
    expect(count(jobs, "succeeded")).toBe(5);
  });

  it("applies a changed setting at the next claim, without a restart", async () => {
    const jobs = [sync("A"), sync("B"), rebuild("engine"), queued({ kind: "maintenance" })];
    const g = gated();
    const drained = g.runner.wake();
    await vi.waitFor(() => expect(g.running()).toHaveLength(2));
    writeSetting(db, JOBS_MAX_CONCURRENT_SETTING, "3");
    void g.runner.runOnce(); // not awaited: it resolves when its job closes
    await vi.waitFor(() => expect(g.running()).toHaveLength(3));
    // lowered: the running jobs are not cut, and no new one starts until below the limit
    writeSetting(db, JOBS_MAX_CONCURRENT_SETTING, "1");
    const [one, two, three] = g.running() as [number, number, number];
    g.finish(one);
    g.finish(two);
    await vi.waitFor(() => expect(count(jobs, "succeeded")).toBe(2));
    expect(g.running()).toEqual([three]);
    expect(count(jobs, "queued")).toBe(1);
    g.finish(three);
    await vi.waitFor(() => expect(g.started).toHaveLength(4));
    g.finish(g.running()[0] as number);
    await drained;
    expect(g.most().atOnce).toBe(3);
  });
});

describe("concurrency.groups (I03-R13; review F1): work that arrives while a job runs", () => {
  it("a wake while an extract runs starts a sync registered since, without waiting for it", async () => {
    const running = extract("A");
    const g = gated();
    const drained = g.runner.wake();
    await vi.waitFor(() => expect(g.running()).toEqual([running.id]));
    const arrived = sync("B");
    void g.runner.wake(); // e.g. "run now" while the extraction is still going
    await vi.waitFor(() => expect(g.running()).toEqual([running.id, arrived.id]));
    g.finish(arrived.id);
    g.finish(running.id);
    await drained;
    expect(g.started).toEqual([running.id, arrived.id]);
  });

  it("the poll starts it too", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const running = extract("A");
    const g = gated(undefined, 1000);
    g.runner.start();
    await vi.waitFor(() => expect(g.running()).toEqual([running.id]));
    const arrived = sync("B");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(g.running()).toEqual([running.id, arrived.id]));
    g.finish(arrived.id);
    g.finish(running.id);
    await g.runner.stop();
  });

  it("a wake after the setting was raised starts a job that waited for a place", async () => {
    writeSetting(db, JOBS_MAX_CONCURRENT_SETTING, "1");
    const jobs = [sync("A"), rebuild("engine")];
    const g = gated();
    const drained = g.runner.wake();
    await vi.waitFor(() => expect(g.running()).toHaveLength(1));
    writeSetting(db, JOBS_MAX_CONCURRENT_SETTING, "2");
    void g.runner.wake();
    await vi.waitFor(() => expect(g.running()).toHaveLength(2));
    for (const id of g.running()) g.finish(id);
    await drained;
    expect(count(jobs, "succeeded")).toBe(2);
  });

  it("a wake with nothing new to claim leaves the drain waiting, and it still ends", async () => {
    const jobs = [extract("A"), extract("B")];
    const g = gated();
    const drained = g.runner.wake();
    await vi.waitFor(() => expect(g.running()).toEqual([jobs[0]?.id]));
    void g.runner.wake(); // knowledge is full: nothing to claim
    await new Promise((r) => setTimeout(r, 20));
    expect(g.started).toEqual([jobs[0]?.id]);
    g.finish(jobs[0]?.id as number);
    await vi.waitFor(() => expect(g.running()).toEqual([jobs[1]?.id]));
    g.finish(jobs[1]?.id as number);
    await drained;
    expect(count(jobs, "succeeded")).toBe(2);
  });
});

describe("jobs.maxConcurrent (I03-R13): the setting", () => {
  it("is named jobs.maxConcurrent", () => {
    expect(JOBS_MAX_CONCURRENT_SETTING).toBe("jobs.maxConcurrent");
  });

  it("reads 1 to 4", () => {
    for (const n of [1, 2, 3, 4]) {
      writeSetting(db, JOBS_MAX_CONCURRENT_SETTING, String(n));
      expect(readMaxConcurrent(db)).toBe(n);
    }
  });

  it("reads anything else as the default of two, not the nearest value", () => {
    for (const bad of ["0", "5", "100", "-1", "2.5", "two", "", " 3", "3 ", "0x2", "1e0"]) {
      writeSetting(db, JOBS_MAX_CONCURRENT_SETTING, bad);
      expect(readMaxConcurrent(db), JSON.stringify(bad)).toBe(2);
    }
  });
});

describe("concurrency.groups (I03-R13): runOnce, stop and the held jobs", () => {
  it("runOnce claims beside a running job, and gives undefined at once when nothing may run", async () => {
    const jobs = [extract("A"), extract("B"), sync("A")];
    const g = gated();
    const first = g.runner.runOnce();
    const second = g.runner.runOnce(); // does not wait for the first
    await vi.waitFor(() => expect(g.running()).toEqual([jobs[0]?.id, jobs[2]?.id]));
    expect(await g.runner.runOnce()).toBeUndefined(); // the limit of two is reached
    g.finish(jobs[2]?.id as number);
    expect(await second).toEqual({ jobId: jobs[2]?.id, status: "succeeded" });
    expect(await g.runner.runOnce()).toBeUndefined(); // a place is free, knowledge is full
    g.finish(jobs[0]?.id as number);
    expect(await first).toEqual({ jobId: jobs[0]?.id, status: "succeeded" });
  });

  it("does not reclaim the jobs it holds when their lease ran out on the wall clock", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] }); // no heartbeat fires
    const held = extract("A");
    const g = gated();
    const first = g.runner.runOnce();
    await vi.waitFor(() => expect(g.running()).toEqual([held.id]));
    clock = new Date(T0.getTime() + LEASE + 1); // e.g. awake after sleep, before a heartbeat
    const other = sync("A");
    const second = g.runner.runOnce();
    await vi.waitFor(() => expect(g.running()).toEqual([held.id, other.id]));
    expect(readJob(db, held.id)).toMatchObject({ status: "running", leaseToken: 1, attempts: 1 });
    g.finish(held.id);
    g.finish(other.id);
    expect(await first).toEqual({ jobId: held.id, status: "succeeded" });
    await second;
    expect(g.started).toEqual([held.id, other.id]); // the held job ran once
  });

  it("stop waits for every running job and claims nothing after", async () => {
    const jobs = [sync("A"), sync("B"), rebuild("engine")];
    const g = gated();
    void g.runner.wake();
    await vi.waitFor(() => expect(g.running()).toHaveLength(2));
    let stopped = false;
    const stopping = g.runner.stop().then(() => (stopped = true));
    const [one, two] = g.running() as [number, number];
    g.finish(one);
    await vi.waitFor(() => expect(count(jobs, "succeeded")).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(false); // one still runs
    g.finish(two);
    await stopping;
    expect(count(jobs, "queued")).toBe(1);
    expect(g.started).toHaveLength(2);
  });

  it("stop waits for the job of a runOnce asked just before it", async () => {
    const job = sync("A");
    const g = gated();
    const run = g.runner.runOnce();
    let stopped = false;
    const stopping = g.runner.stop().then(() => (stopped = true));
    await vi.waitFor(() => expect(g.running()).toEqual([job.id]));
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(false);
    g.finish(job.id);
    await stopping;
    expect(await run).toEqual({ jobId: job.id, status: "succeeded" });
  });

  it("keeps draining the other groups when one job's handler fails", async () => {
    const errors: unknown[] = [];
    const jobs = [sync("A"), sync("B"), rebuild("engine")];
    const g = gated((e) => errors.push(e));
    const drained = g.runner.wake();
    await vi.waitFor(() => expect(g.running()).toHaveLength(2));
    g.finish(g.running()[0] as number, { status: "fail", code: "gone", retryable: false });
    await vi.waitFor(() => expect(g.started).toHaveLength(3));
    for (const id of g.running()) g.finish(id);
    await drained;
    expect(jobs.map(status).sort()).toEqual(["dead_letter", "succeeded", "succeeded"]);
    expect(errors).toEqual([]);
  });
});

describe("concurrency.groups (I03-R13, R14; I03-T05 item 9): a run that ended without its handler", () => {
  /** Extract jobs whose handlers never return on their own and ignore their signal. */
  function abandoning() {
    const started: number[] = [];
    const late = new Map<number, (result: JobResult) => void>();
    const runner = createJobRunner({
      db,
      handlers: {
        extract: (job) => {
          started.push(job.id);
          return new Promise<JobResult>((resolve) => late.set(job.id, resolve));
        },
      },
      kinds: { extract: { runTimeoutMs: 1000 } },
      clock: testClock,
      testBuild: { leaseMs: LEASE },
    });
    return { runner, started, late };
  }
  const marker = vi.fn();

  beforeEach(() => {
    marker.mockClear();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  });

  it("a timed-out handler that never returns frees its place: the next job of its group runs, and its late write is refused", async () => {
    const first = extract("A");
    const second = extract("B");
    const { runner, started, late } = abandoning();
    const drained = runner.wake();
    await vi.waitFor(() => expect(started).toEqual([first.id]));
    await vi.advanceTimersByTimeAsync(LEASE / 4);
    expect(status(second)).toBe("queued"); // knowledge is full while the first runs in time

    mono = 1000; // over the kind's limit at the next heartbeat
    await vi.advanceTimersByTimeAsync(LEASE / 4);
    await vi.waitFor(() => expect(started).toEqual([first.id, second.id]));
    expect(readJob(db, first.id)).toMatchObject({ status: "retry", reason: "run-timeout" });
    expect(readJob(db, second.id)).toMatchObject({ status: "running", attempts: 1 });

    // the abandoned handler comes back while the second runs: nothing of it is written
    const lease = { id: first.id, leaseToken: 1 };
    late.get(first.id)?.({ status: "succeeded", write: marker });
    await vi.advanceTimersByTimeAsync(0);
    expect(closeJob(db, lease, { status: "succeeded", write: marker })).toBe("not-leased");
    expect(marker).not.toHaveBeenCalled();
    expect(readJob(db, first.id)).toMatchObject({ status: "retry", reason: "run-timeout" });
    expect(status(second)).toBe("running");

    late.get(second.id)?.({ status: "succeeded", write: () => {} });
    await drained; // the first waits out its backoff: nothing else is due
    expect(status(second)).toBe("succeeded");
    expect(started).toEqual([first.id, second.id]);
  });

  it("a run that lost its job frees its place the same way", async () => {
    const first = extract("A");
    const second = extract("B");
    const { runner, started, late } = abandoning();
    const drained = runner.wake();
    await vi.waitFor(() => expect(started).toEqual([first.id]));
    // the source is closed under the running job (I03-R3): its token is raised
    expect(supersedeOpenJobs(db, first.sourceId as number, now())).toBe(1);
    expect(status(second)).toBe("queued"); // nothing claims until the runner notices

    await vi.advanceTimersByTimeAsync(LEASE / 4); // the heartbeat fails: the run ends
    await vi.waitFor(() => expect(started).toEqual([first.id, second.id]));
    late.get(first.id)?.({ status: "succeeded", write: marker });
    await vi.advanceTimersByTimeAsync(0);
    expect(marker).not.toHaveBeenCalled();
    expect(readJob(db, first.id)).toMatchObject({ status: "superseded", reason: "source-closed" });

    late.get(second.id)?.({ status: "succeeded", write: () => {} });
    await drained;
    expect(status(second)).toBe("succeeded");
  });
});

describe("priority.fairness (I03-R13, C3): through the runner", () => {
  /** Runs every due job one by one as it starts; the order they started in. */
  async function runAll(g: ReturnType<typeof gated>, count: number): Promise<number[]> {
    const drained = g.runner.wake();
    for (let i = 0; i < count; i++) {
      await vi.waitFor(() => expect(g.started).toHaveLength(i + 1));
      g.finish(g.started[i] as number);
    }
    await drained;
    return g.started;
  }

  it("runs Connector B's one job within two claims behind 100 jobs of Connector A", async () => {
    for (let i = 0; i < 100; i++) extract("A");
    const b = extract("B");
    const g = gated();
    void g.runner.wake();
    for (let i = 0; i < 2; i++) {
      await vi.waitFor(() => expect(g.started).toHaveLength(i + 1));
      if (i === 1) void g.runner.stop(); // two claims are enough
      g.finish(g.started[i] as number);
    }
    await g.runner.stop();
    expect(g.started).toHaveLength(2);
    expect(g.started).toContain(b.id);
  });

  it("alternates between two Connectors' jobs", async () => {
    const a = [extract("A"), extract("A"), extract("A")];
    const b = [extract("B"), extract("B"), extract("B")];
    const order = await runAll(gated(), 6);
    expect(order).toEqual([a[0], b[0], a[1], b[1], a[2], b[2]].map((j) => j?.id));
  });

  it("starts over after a restart: a new runner remembers no turn", async () => {
    const a = [extract("A"), extract("A")];
    const b = [extract("B")];
    const before = gated();
    const one = before.runner.runOnce();
    await vi.waitFor(() => expect(before.running()).toEqual([a[0]?.id]));
    before.finish(a[0]?.id as number);
    await one;
    // the old runner would go to B next; a new one starts from the earliest registered
    const after = gated();
    const next = after.runner.runOnce();
    await vi.waitFor(() => expect(after.running()).toEqual([a[1]?.id]));
    after.finish(a[1]?.id as number);
    await next;
    expect(status(b[0] as StoredJob)).toBe("queued");
  });

  it("runs a user job and a projection job registered behind scheduled jobs first", async () => {
    writeSetting(db, JOBS_MAX_CONCURRENT_SETTING, "1");
    const periodic = [sync("A", "scheduled"), sync("B", "scheduled")];
    const retried = extract("A"); // user, as a manual retry is
    const projection = rebuild("engine"); // projection work is user priority (I03-R7)
    const order = await runAll(gated(), 4);
    expect(order).toEqual([retried.id, projection.id, periodic[0]?.id, periodic[1]?.id]);
  });
});
