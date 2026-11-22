// I03-R13, C3 (I03-T05) on the claim itself: the concurrency groups and the
// overall limit counted over the database's running rows, the order of a claim
// (priority, then the fairness key claimed longest ago, then run-at time, then
// ID), a full group skipped for the next candidate, and the limits holding when
// several connections claim at once (threads on one file).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import {
  DEFAULT_MAX_CONCURRENT,
  JOB_GROUP_CAPS,
  JOB_GROUP_SQL,
  JOB_KIND_GROUPS,
  jobGroup,
} from "./job-concurrency.ts";
import {
  leaseNextJob,
  readJob,
  registerJob,
  transitionJob,
  type JobPriority,
  type LeaseRequest,
  type StoredJob,
} from "./jobs.ts";
import { migrate } from "./migrations.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";

let db: SqlDriver;

beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "A", "test-fixtures");
  registerConnectorInstance(db, "B", "test-fixtures");
});

afterEach(() => {
  db.close();
});

const T0 = new Date("2026-11-21T00:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const LEASE = 60_000;
const KINDS = [
  "extract",
  "connector-sync",
  "projection-remove",
  "projection-rebuild",
  "maintenance",
  "other",
];

type Extra = { priority?: JobPriority; target?: string; at?: Date };

function queued(on: SqlDriver, job: Parameters<typeof registerJob>[1]): StoredJob {
  const r = registerJob(on, { at: T0, ...job });
  if (!r.registered) throw new Error("expected a new job");
  return r.job;
}

let seq = 0;
/** A new source of `connector` with one version. */
function stored(on: SqlDriver, connector: string): number {
  const saved = saveSourceRecord(on, connector, { externalId: `e${++seq}`, title: "t", body: "b" });
  if (saved.status !== "created") throw new Error("expected a new source");
  return saved.sourceId;
}
/** A stored source of `connector` and a job of `kind` fenced by its version. */
function sourced(connector: string, kind = "extract", extra: Extra = {}, on = db): StoredJob {
  return queued(on, { kind, sourceId: stored(on, connector), fenceVersion: 1, ...extra });
}
const sync = (instance: string, extra: Extra = {}) =>
  queued(db, { kind: "connector-sync", target: instance, ...extra });

const claim = (request: Partial<LeaseRequest> = {}) =>
  leaseNextJob(db, { kinds: KINDS, now: T0, leaseMs: LEASE, ...request });
const finish = (job: StoredJob) =>
  transitionJob(db, job.id, { from: "running", to: "succeeded", leaseToken: job.leaseToken });

describe("concurrency.groups (I03-R13): the groups are constants", () => {
  it("puts each kind in its group, with the limit of that group", () => {
    expect(jobGroup("extract", "")).toEqual({ name: "knowledge", cap: 1 });
    expect(jobGroup("extract", "scope-recompute:7")).toEqual({ name: "knowledge", cap: 1 });
    expect(jobGroup("projection-remove", "engine")).toEqual({ name: "projection", cap: 1 });
    expect(jobGroup("projection-rebuild", "vector")).toEqual({ name: "projection", cap: 1 });
    expect(jobGroup("maintenance", "")).toEqual({ name: "maintenance", cap: 1 });
    expect(JOB_GROUP_CAPS).toEqual({
      knowledge: 1,
      projection: 1,
      maintenance: 1,
      "connector-sync": 1,
    });
  });

  it("gives every Connector instance a group of its own", () => {
    expect(jobGroup("connector-sync", "A")).toEqual({ name: "connector-sync:A", cap: 1 });
    expect(jobGroup("connector-sync", "B")).toEqual({ name: "connector-sync:B", cap: 1 });
  });

  it("gives a kind the table does not name a group of its own, one at a time", () => {
    expect(jobGroup("test-effect", "x")).toEqual({ name: "kind:test-effect", cap: 1 });
  });

  it("defaults to two jobs overall", () => {
    expect(DEFAULT_MAX_CONCURRENT).toBe(2);
  });
});

describe("concurrency.groups (I03-R13; review F3): the query and the code name a group alike", () => {
  // Running rows are named by jobGroup, candidates by JOB_GROUP_SQL inside the
  // query: a full group is skipped only while the two give the same name.
  const sqlName = (kind: string, target: string) =>
    db.all(`SELECT ${JOB_GROUP_SQL} AS name FROM (SELECT ? AS kind, ? AS target) j`, [
      kind,
      target,
    ])[0]?.name;

  it("for every kind of the table and one outside it, whatever the target", () => {
    const kinds = [...Object.keys(JOB_KIND_GROUPS), "test-effect"];
    expect(kinds).toContain("connector-sync");
    for (const kind of kinds) {
      for (const target of ["", "A", "B", "engine", "scope-recompute:7", "it's: a 'target'"]) {
        expect(sqlName(kind, target), `${kind} / ${target}`).toBe(jobGroup(kind, target).name);
      }
    }
  });

  it("names two Connector instances' syncs apart in the query", () => {
    expect(sqlName("connector-sync", "A")).toBe("connector-sync:A");
    expect(sqlName("connector-sync", "B")).toBe("connector-sync:B");
  });
});

describe("concurrency.groups (I03-R13, C3): what a claim leaves queued", () => {
  it("does not claim a second knowledge job while one runs, and claims it once that closed", () => {
    const first = sourced("A");
    const second = sourced("B");
    expect(claim()?.id).toBe(first.id);
    expect(claim()).toBeUndefined();
    expect(readJob(db, second.id)).toMatchObject({ status: "queued", attempts: 0, leaseToken: 0 });
    finish(readJob(db, first.id) as StoredJob);
    expect(claim()?.id).toBe(second.id);
  });

  it("runs a knowledge job and a sync together", () => {
    const extract = sourced("A");
    const pull = sync("A");
    expect(claim()?.id).toBe(extract.id);
    expect(claim()?.id).toBe(pull.id);
  });

  it("skips a candidate whose group is full for a later job of another group", () => {
    const running = sourced("A");
    const blocked = sourced("A"); // the front candidate: lower ID, same priority and key
    const behind = sync("B");
    expect(claim()?.id).toBe(running.id);
    expect(claim()?.id).toBe(behind.id);
    expect(readJob(db, blocked.id)?.status).toBe("queued");
  });

  it("never has two open syncs of one Connector instance, and runs two instances together", () => {
    const a = sync("A");
    expect(registerJob(db, { kind: "connector-sync", target: "A", at: T0 })).toMatchObject({
      registered: false,
      existing: { id: a.id },
    });
    const b = sync("B");
    expect(claim()?.id).toBe(a.id);
    expect(claim()?.id).toBe(b.id);
  });

  it("does not run a projection removal and a rebuild together, whatever their targets", () => {
    const remove = sourced("A", "projection-remove", { target: "engine" });
    const rebuild = queued(db, { kind: "projection-rebuild", target: "vector" });
    expect(claim()?.id).toBe(remove.id);
    expect(claim()).toBeUndefined();
    finish(readJob(db, remove.id) as StoredJob);
    expect(claim()?.id).toBe(rebuild.id);
  });

  it("does not run two removals of different projections together", () => {
    const sourceId = stored(db, "A");
    const engine = queued(db, {
      kind: "projection-remove",
      target: "engine",
      sourceId,
      fenceVersion: 1,
    });
    queued(db, { kind: "projection-remove", target: "vector", sourceId, fenceVersion: 1 });
    expect(claim()?.id).toBe(engine.id);
    expect(claim()).toBeUndefined();
  });

  it("runs a kind the table does not name one at a time", () => {
    const first = queued(db, { kind: "other", target: "1" });
    queued(db, { kind: "other", target: "2" });
    expect(claim({ maxConcurrent: 4 })?.id).toBe(first.id);
    expect(claim({ maxConcurrent: 4 })).toBeUndefined();
  });

  it("counts the running jobs of another runner and of kinds it was not asked for", () => {
    const extract = sourced("A");
    const second = sourced("B");
    const pull = sync("A");
    const rebuild = queued(db, { kind: "projection-rebuild", target: "engine" });
    expect(claim({ owner: "one", kinds: ["extract"] })?.id).toBe(extract.id);
    // the knowledge group is full for the other runner too
    expect(claim({ owner: "two", kinds: ["extract"] })).toBeUndefined();
    expect(readJob(db, second.id)?.status).toBe("queued");
    expect(claim({ owner: "two", kinds: ["connector-sync"] })?.id).toBe(pull.id);
    // two run: a runner asked for neither kind still finds the limit of two reached
    expect(claim({ owner: "three", kinds: ["projection-rebuild"] })).toBeUndefined();
    expect(readJob(db, rebuild.id)?.status).toBe("queued");
  });

  it("frees the place of a job whose lease ran out in the same claim", () => {
    const first = sourced("A");
    const second = sourced("B");
    expect(claim()?.id).toBe(first.id);
    // reclaimed first (queued again, token raised), so the group is free and it is claimed anew
    expect(claim({ now: at(LEASE) })).toMatchObject({ id: first.id, leaseToken: 3, attempts: 2 });
    expect(readJob(db, second.id)?.status).toBe("queued");
  });
});

describe("concurrency.groups (I03-R13, C3): the overall limit", () => {
  const five = () => [
    sourced("A"),
    sync("A"),
    sync("B"),
    queued(db, { kind: "projection-rebuild", target: "engine" }),
    queued(db, { kind: "maintenance" }),
  ];

  it("claims two jobs of different groups by default and no third", () => {
    const jobs = five();
    expect(claim()?.id).toBe(jobs[0]?.id);
    expect(claim()?.id).toBe(jobs[1]?.id);
    expect(claim()).toBeUndefined();
    expect(jobs.slice(2).map((j) => readJob(db, j.id)?.status)).toEqual([
      "queued",
      "queued",
      "queued",
    ]);
  });

  it("claims one job at a time when the limit is one, whatever the groups", () => {
    const jobs = five();
    for (const job of jobs) {
      expect(claim({ maxConcurrent: 1 })?.id).toBe(job.id);
      expect(claim({ maxConcurrent: 1 })).toBeUndefined();
      finish(readJob(db, job.id) as StoredJob);
    }
  });

  it("claims up to the limit it is given", () => {
    const jobs = five();
    for (const job of jobs.slice(0, 4)) expect(claim({ maxConcurrent: 4 })?.id).toBe(job.id);
    expect(claim({ maxConcurrent: 4 })).toBeUndefined();
    expect(readJob(db, jobs[4]?.id as number)?.status).toBe("queued");
  });

  it("claims again once a running job closed", () => {
    const jobs = five();
    claim();
    claim();
    finish(readJob(db, jobs[1]?.id as number) as StoredJob);
    expect(claim()?.id).toBe(jobs[2]?.id);
  });

  it("refuses a limit that is not a positive whole number, claiming nothing", () => {
    const job = sourced("A");
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => claim({ maxConcurrent: bad })).toThrow(RangeError);
    }
    expect(readJob(db, job.id)?.status).toBe("queued");
  });
});

describe("priority.fairness (I03-R13, C3): priority first", () => {
  it("claims a user job registered after waiting scheduled jobs before them", () => {
    const periodic = [sync("A", { priority: "scheduled" }), sync("B", { priority: "scheduled" })];
    const retry = sourced("A"); // registerJob's default: user
    expect(claim()?.id).toBe(retry.id);
    expect(claim()?.id).toBe(periodic[0]?.id);
  });

  it("claims a projection removal registered after waiting scheduled jobs before them", () => {
    sync("A", { priority: "scheduled" });
    sourced("A", "extract", { priority: "scheduled", target: "scope-recompute:1" });
    const remove = sourced("B", "projection-remove", { target: "engine", priority: "user" });
    expect(claim()?.id).toBe(remove.id);
  });

  it("claims maintenance last", () => {
    const cleanup = queued(db, { kind: "maintenance", priority: "maintenance" });
    const periodic = sync("A", { priority: "scheduled" });
    const user = sourced("A");
    expect([claim(), claim(), claim({ maxConcurrent: 3 })].map((j) => j?.id)).toEqual([
      user.id,
      periodic.id,
      cleanup.id,
    ]);
  });

  it("puts priority above the fairness turn: a user job of the key claimed last goes first", () => {
    sync("B", { priority: "scheduled" });
    const user = sourced("A");
    expect(claim({ lastClaimed: new Map([["A", 9]]) })?.id).toBe(user.id);
  });

  it("claims a lower priority job when the higher one's group is full", () => {
    const running = sourced("A");
    sourced("A"); // user, but knowledge is full
    const periodic = sync("B", { priority: "scheduled" });
    expect(claim()?.id).toBe(running.id);
    expect(claim()?.id).toBe(periodic.id);
  });
});

describe("priority.fairness (I03-R13, C3): fairness keys take turns", () => {
  /** Claims as the runner does: one job at a time here, remembering each key's turn. */
  function drain(lastClaimed: Map<string, number>, turns: number): string[] {
    const keys: string[] = [];
    for (let turn = 1; turn <= turns; turn++) {
      const job = claim({ lastClaimed });
      if (!job) break;
      lastClaimed.set(job.fairnessKey, turn);
      keys.push(job.fairnessKey);
      finish(job);
    }
    return keys;
  }

  it("claims Connector B's one job within two claims behind 100 jobs of Connector A", () => {
    for (let i = 0; i < 100; i++) sourced("A");
    const b = sourced("B");
    expect(drain(new Map(), 2)).toContain("B");
    expect(readJob(db, b.id)?.status).toBe("succeeded");
  });

  it("claims B at once when A was claimed before and B never", () => {
    for (let i = 0; i < 3; i++) sourced("A");
    const b = sourced("B");
    expect(claim({ lastClaimed: new Map([["A", 1]]) })?.id).toBe(b.id);
  });

  it("alternates between keys, the one claimed longest ago first", () => {
    for (let i = 0; i < 3; i++) sourced("A");
    for (let i = 0; i < 3; i++) sourced("B");
    expect(drain(new Map(), 6)).toEqual(["A", "B", "A", "B", "A", "B"]);
  });

  it("starts over with no memory (a restart): the earliest registered job first", () => {
    const a = sourced("A");
    sourced("B");
    expect(claim({ lastClaimed: new Map() })?.id).toBe(a.id);
    expect(claim({ lastClaimed: new Map([["B", 5]]) })).toBeUndefined(); // knowledge is full
  });

  it("keys a sourceless job by its kind, taking turns with the Connectors", () => {
    const pull = sync("A"); // key connector-sync
    const extract = sourced("A"); // key A
    expect(pull.fairnessKey).toBe("connector-sync");
    expect(claim({ lastClaimed: new Map([["connector-sync", 1]]) })?.id).toBe(extract.id);
  });

  it("keeps the turn of a key whose job was skipped for a full group", () => {
    const running = sourced("A");
    const waiting = sourced("B"); // B's turn, but knowledge is full
    const pull = sync("A");
    const lastClaimed = new Map<string, number>();
    expect(claim({ lastClaimed })?.id).toBe(running.id);
    lastClaimed.set("A", 1);
    expect(claim({ lastClaimed })?.id).toBe(pull.id);
    lastClaimed.set("connector-sync", 2);
    finish(readJob(db, running.id) as StoredJob);
    sourced("A", "extract", { at: at(-1000) }); // due earlier, but A had its turn
    expect(claim({ lastClaimed })?.id).toBe(waiting.id);
  });

  it("orders one key's jobs by run-at time, then by registration", () => {
    const late = sourced("A", "extract", { at: at(2000) });
    const early = sourced("A", "extract", { at: at(1000) });
    const same = sourced("A", "extract", { at: at(1000) });
    const order: (number | undefined)[] = [];
    for (let i = 0; i < 3; i++) {
      const job = claim({ now: at(5000) });
      order.push(job?.id);
      if (job) finish(job);
    }
    expect(order).toEqual([early.id, same.id, late.id]);
  });

  it("takes a key with a quote or a backslash in it as it is", () => {
    registerConnectorInstance(db, 'q"\\', "test-fixtures");
    sourced("A");
    const odd = sourced('q"\\');
    expect(claim({ lastClaimed: new Map([["A", 1]]) })?.id).toBe(odd.id);
  });
});

// Several connections claim at the same moment (I03-A3: another backend on the
// same file). Each thread opens the file, waits at a barrier, then claims until
// the queue is empty, noting after every claim how many jobs it then sees running.
const WORKER = `
const { workerData, parentPort } = require("node:worker_threads");
(async () => {
  const { openBetterSqlite3 } = await import(workerData.driver);
  const { leaseNextJob, transitionJob } = await import(workerData.jobs);
  const db = openBetterSqlite3(workerData.file);
  const flag = new Int32Array(workerData.barrier);
  Atomics.add(flag, 0, 1);
  Atomics.notify(flag, 0);
  Atomics.wait(flag, 1, 0); // released together
  const count = (where) => db.all("SELECT count(*) AS n FROM jobs WHERE " + where)[0].n;
  const claimed = [];
  let most = 0;
  let mostKnowledge = 0;
  let refused = 0;
  while (count("status = 'queued'") > 0) {
    const job = leaseNextJob(db, {
      kinds: workerData.kinds,
      now: new Date(workerData.now),
      leaseMs: 3_600_000,
      owner: String(workerData.name),
      maxConcurrent: workerData.maxConcurrent,
    });
    if (!job) {
      refused++; // jobs wait, but a limit is reached: another thread holds the place
      Atomics.wait(flag, 2, 0, 1);
      continue;
    }
    claimed.push(job.id);
    most = Math.max(most, count("status = 'running'"));
    mostKnowledge = Math.max(mostKnowledge, count("status = 'running' AND kind = 'extract'"));
    Atomics.wait(flag, 2, 0, 2); // hold the job a moment: the others claim meanwhile
    transitionJob(db, job.id, { from: "running", to: "succeeded", leaseToken: job.leaseToken });
    Atomics.wait(flag, 2, 0, 1); // let another thread take the freed place
  }
  db.close();
  parentPort.postMessage({ claimed, most, mostKnowledge, refused });
})();
`;

interface Raced {
  claimed: number[];
  most: number;
  mostKnowledge: number;
  refused: number;
}

describe("concurrency.groups (I03-R13, I03-A3): claimers racing on one file", () => {
  let dir: string;
  let file: SqlDriver;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pki-jobs-race-"));
    file = openBetterSqlite3(join(dir, "db.sqlite"));
    migrate(file);
  });
  afterEach(() => {
    file.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function race(threads: number, maxConcurrent: number): Promise<Raced[]> {
    const barrier = new SharedArrayBuffer(12);
    const flag = new Int32Array(barrier);
    const workers = Array.from({ length: threads }, (_, name) => {
      const worker = new Worker(WORKER, {
        eval: true,
        workerData: {
          name,
          barrier,
          maxConcurrent,
          kinds: KINDS,
          now: T0.getTime(),
          file: join(dir, "db.sqlite"),
          driver: new URL("./adapters/better-sqlite3-driver.ts", import.meta.url).href,
          jobs: new URL("./jobs.ts", import.meta.url).href,
        },
      });
      return new Promise<Raced>((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      });
    });
    while (Atomics.load(flag, 0) < threads) await new Promise((r) => setTimeout(r, 5));
    Atomics.store(flag, 1, 1);
    Atomics.notify(flag, 1);
    return Promise.all(workers);
  }

  it("never has two knowledge jobs running, and runs every job exactly once", async () => {
    registerConnectorInstance(file, "A", "test-fixtures");
    const jobs = Array.from({ length: 40 }, () => sourced("A", "extract", {}, file));
    const results = await race(2, 4);
    expect(Math.max(...results.map((r) => r.mostKnowledge))).toBe(1);
    expect(results.flatMap((r) => r.claimed).sort((x, y) => x - y)).toEqual(jobs.map((j) => j.id));
    // the threads did contend: a claim found the group full while jobs waited
    expect(results.reduce((sum, r) => sum + r.refused, 0)).toBeGreaterThan(0);
    expect(jobs.map((j) => readJob(file, j.id)).every((j) => j?.attempts === 1)).toBe(true);
  }, 60_000);

  it("never has more jobs running than the overall limit", async () => {
    // every job in a group of its own, so only the overall limit of two binds
    const jobs = Array.from({ length: 60 }, (_, i) =>
      queued(file, { kind: "connector-sync", target: `i${i}` }),
    );
    const results = await race(3, 2);
    expect(Math.max(...results.map((r) => r.most))).toBe(2);
    expect(results.flatMap((r) => r.claimed).sort((x, y) => x - y)).toEqual(jobs.map((j) => j.id));
    expect(jobs.map((j) => readJob(file, j.id)).every((j) => j?.attempts === 1)).toBe(true);
  }, 60_000);
});
