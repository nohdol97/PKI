// I03-T11 `jobs.api` (R23, C3): the Activity screen's job API. It answers with codes, ids and
// counts only (a canary in a source and in a checkpoint never comes back), refuses a request
// without the token, with another Host or with another Origin and changes nothing for it, and
// each user action reaches the stored job (cancel, retry, discard) or schedule through the
// same entries the runner and the scheduler use.
import { JobsResponseSchema, routes, type RouteName } from "@pki/contracts";
import {
  migrate,
  markedProjections,
  readJob,
  registerConnectorInstance,
  registerJob,
  saveSourceRecord,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { send, memoryDbTemplate } from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { productAdapters, productEgress } from "./composition.ts";
import type { Clock } from "./clock.ts";
import { createJobActions } from "./job-actions.ts";
import { JOBS_LISTED, type JobsPort } from "./jobs-view.ts";
import { createScheduler, type Scheduler } from "./scheduler.ts";
import { startServer, type RunningServer } from "./server.ts";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);

const TOKEN = "j".repeat(43);
const ORIGIN = "http://localhost:5173";
const T0 = Date.parse("2026-11-21T00:00:00.000Z");
const CANARY = "CANARY-본문-7f3a";
const CANARY_TITLE = "CANARY-제목-91bc";

let db: SqlDriver;
let server: RunningServer;
let scheduler: Scheduler;
let valid: Record<string, string>;
const wake = vi.fn();
const cancelRunning = vi.fn();
const clock: Clock = { now: () => T0, sleep: () => Promise.resolve(), monotonic: () => 0 };

/** A sourceless job of `kind`, then written as `status` (a test of rows, not of running them). */
function job(
  kind: string,
  target: string,
  status: string,
  extra: { reason?: string; counts?: object; checkpoint?: string; finished?: boolean } = {},
): number {
  const r = registerJob(db, { kind, target, at: new Date(T0) });
  if (!r.registered) throw new Error("not registered");
  db.run(
    `UPDATE jobs SET status = ?, reason = ?, result_counts = ?, checkpoint = ?, finished_at = ?,
       lease_owner = ?, lease_until = ? WHERE id = ?`,
    [
      status,
      extra.reason ?? null,
      extra.counts ? JSON.stringify(extra.counts) : null,
      extra.checkpoint ?? null,
      ["succeeded", "cancelled", "dead_letter", "superseded"].includes(status) ? T0 : null,
      status === "running" ? "owner" : null,
      status === "running" ? T0 + 60_000 : null,
      r.job.id,
    ],
  );
  return r.job.id;
}

const port = (): JobsPort => ({
  scheduler,
  actions: createJobActions({ db, runner: { cancelRunning, wake }, clock }),
  budgetUsage: () => ({ used: 3, maxCalls: 10, windowMs: 60_000, resetsAt: T0 + 30_000 }),
  projectionNames: ["engine", "vector"],
  wake,
});

async function start(bound = true) {
  const stores = { db, dataDirectory: "/synthetic/data", egress: productEgress(db) };
  server = await startServer({
    token: TOKEN,
    allowedOrigins: [ORIGIN],
    connectors: { list: () => [], sync: () => Promise.reject(new Error("unused")) },
    ...stores,
    ...productAdapters(stores.dataDirectory),
    ...(bound ? { jobs: port() } : {}),
  });
  valid = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}`, origin: ORIGIN };
}
const call = (name: RouteName, body?: unknown, headers = valid) =>
  send(server.port, routes[name].path, headers, routes[name].method, body);

beforeEach(() => {
  db = freshDb();
  wake.mockClear();
  cancelRunning.mockClear();
  scheduler = createScheduler({ db, clock, timeZone: () => "UTC", openJobCap: 4 });
});
afterEach(async () => {
  await server.close();
  db.close();
});

describe("GET /api/jobs", () => {
  it("shows the status counts, the rows with their codes and counts, the schedules, the projections, the budget and the queue warning", async () => {
    registerConnectorInstance(db, "c1", "test-fixtures");
    saveSourceRecord(db, "c1", { externalId: "e1", title: CANARY_TITLE, body: CANARY });
    const synced = job("connector-sync", "c1", "succeeded", {
      counts: { received: 5, staleTombstone: 2, blocked: 1, rescanned: 1, deletionsMayBeMissed: 1 },
      // a checkpoint may hold what the run read: it never leaves the store through this API
      checkpoint: JSON.stringify({ note: CANARY }),
    });
    const held = job("connector-sync", "c1", "held", { reason: "connector-unavailable" });
    job("projection-rebuild", "engine", "queued");
    scheduler.ensureSchedule({
      kind: "maintenance",
      period: { kind: "daily", at: { hour: 3, minute: 0 } },
    });
    await start();

    const res = await call("jobs");
    expect(res.status).toBe(200);
    const body = JobsResponseSchema.parse(res.body);
    expect(body.counts).toEqual({
      queued: 1,
      running: 0,
      retry: 0,
      held: 1,
      succeeded: 1,
      superseded: 0,
      cancelled: 0,
      dead_letter: 0,
    });
    expect(body.jobs.map((j) => j.id)).toEqual([3, held, synced]);
    expect(body.jobs.find((j) => j.id === held)).toMatchObject({
      kind: "connector-sync",
      target: "c1",
      status: "held",
      reason: "connector-unavailable",
      attempts: 0,
      maxAttempts: 5,
    });
    expect(body.jobs.find((j) => j.id === synced)?.resultCounts).toEqual({
      received: 5,
      staleTombstone: 2,
      blocked: 1,
      rescanned: 1,
      deletionsMayBeMissed: 1,
    });
    expect(body.schedules).toMatchObject([
      { kind: "maintenance", enabled: true, period: { kind: "daily", at: { hour: 3, minute: 0 } } },
    ]);
    expect(body.projections).toEqual([
      { name: "engine", openRemoves: 0, deadRemoves: 0, rebuild: "pending" },
    ]);
    expect(body.budget).toEqual({
      used: 3,
      maxCalls: 10,
      windowMs: 60_000,
      resetsAt: new Date(T0 + 30_000).toISOString(),
    });
    // three open jobs of a cap of 4 reach 75%: no warning yet; a fourth passes 90%
    expect(body.backlog).toEqual({ open: 2, cap: 4, warning: false });
    job("maintenance", "x", "queued");
    job("maintenance", "y", "queued");
    expect(JobsResponseSchema.parse((await call("jobs")).body).backlog).toEqual({
      open: 4,
      cap: 4,
      warning: true,
    });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain(CANARY_TITLE);
  });

  it("lists the newest rows only, and says that more exist", async () => {
    for (let i = 0; i < JOBS_LISTED + 1; i++) job("maintenance", `t${i}`, "succeeded");
    await start();
    const body = JobsResponseSchema.parse((await call("jobs")).body);
    expect(body.jobs).toHaveLength(JOBS_LISTED);
    expect(body.jobs[0]?.id).toBe(JOBS_LISTED + 1);
    expect(body.truncated).toBe(true);
    expect(body.counts.succeeded).toBe(JOBS_LISTED + 1);
  });

  it("keeps whole numbers that are counts and drops anything else a row's result holds", async () => {
    job("connector-sync", "c1", "succeeded", {
      counts: { received: 2, note: "text", ratio: 1.5, negative: -1 },
    });
    await start();
    const body = JobsResponseSchema.parse((await call("jobs")).body);
    expect(body.jobs[0]?.resultCounts).toEqual({ received: 2 });
  });

  it("still answers without a bound runner and scheduler: no schedules, no budget, and the actions are unavailable", async () => {
    const id = job("maintenance", "x", "dead_letter", { reason: "handler-error" });
    await start(false);
    const body = JobsResponseSchema.parse((await call("jobs")).body);
    expect(body).toMatchObject({ schedules: [], budget: null });
    expect(body.counts.dead_letter).toBe(1);
    expect((await call("discardJob", { id })).body).toEqual({ outcome: "unavailable" });
    expect(readJob(db, id)?.status).toBe("dead_letter");
  });
});

describe("a row the response cannot hold (review A4)", () => {
  it("leaves it out and counts it, and the rest of the list still answers 200", async () => {
    const odd = job("maintenance", "x".repeat(300), "succeeded"); // a target over the schema's length
    const fine = job("maintenance", "ok", "succeeded");
    await start();
    const res = await call("jobs");
    expect(res.status).toBe(200);
    const body = JobsResponseSchema.parse(res.body);
    expect(body.jobs.map((j) => j.id)).toEqual([fine]);
    expect(body.unreadable).toBe(1);
    // the counts still hold both rows
    expect(body.counts.succeeded).toBe(2);
    expect(odd).toBeGreaterThan(0);
  });

  it("counts nothing unreadable when every row fits", async () => {
    job("maintenance", "ok", "succeeded");
    await start();
    expect(JobsResponseSchema.parse((await call("jobs")).body).unreadable).toBe(0);
  });
});

describe("a projection removal's mark (review A1)", () => {
  /** A removal for `projection` (it names a source of its own), written as `status`. */
  function removal(projection: string, status: string): number {
    registerConnectorInstance(db, "c1", "test-fixtures");
    const n = db.all("SELECT count(*) AS n FROM sources")[0]?.n as number;
    saveSourceRecord(db, "c1", { externalId: `r${n}`, title: "t", body: "b" });
    const r = registerJob(db, {
      kind: "projection-remove",
      target: projection,
      sourceId: n + 1,
      fenceVersion: 1,
    });
    if (!r.registered) throw new Error("not registered");
    db.run("UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?", [
      status,
      status === "dead_letter" ? T0 : null,
      r.job.id,
    ]);
    return r.job.id;
  }

  it("refuses to cancel an open removal and to discard a given-up one, leaves the mark, and the rebuild route is the way out", async () => {
    const open = removal("engine", "queued");
    const dead = removal("vector", "dead_letter");
    await start();
    expect(markedProjections(db, { phase: "start" })).toEqual(["engine", "vector"]);
    expect((await call("cancelJob", { id: open })).body).toEqual({ outcome: "not-allowed" });
    expect((await call("discardJob", { id: dead })).body).toEqual({ outcome: "not-allowed" });
    expect(readJob(db, open)?.status).toBe("queued");
    expect(readJob(db, dead)?.status).toBe("dead_letter");
    expect(markedProjections(db, { phase: "start" })).toEqual(["engine", "vector"]);
    // a try again keeps it open; the rebuild is what the screen offers
    expect((await call("retryJob", { id: dead })).body).toEqual({ outcome: "queued" });
    expect(markedProjections(db, { phase: "start" })).toEqual(["engine", "vector"]);
    expect((await call("rebuildProjection", { projection: "vector" })).body).toEqual({
      outcome: "requested",
    });
  });
});

describe("request bodies are strict (review A3)", () => {
  const period = { kind: "daily", at: { hour: 3, minute: 0 } };
  it.each([
    ["cancelJob", { id: 1, extra: 1 }],
    ["retryJob", { id: 1, extra: 1 }],
    ["discardJob", { id: 1, extra: 1 }],
    ["disableSchedule", { id: 1, extra: 1 }],
    ["enableSchedule", { id: 1, extra: 1 }],
    ["runSchedule", { id: 1, extra: 1 }],
    ["rebuildProjection", { projection: "engine", extra: 1 }],
    ["changeSchedule", { id: 1, period, extra: 1 }],
    ["changeSchedule", { id: 1, period: { ...period, extra: 1 } }],
    ["changeSchedule", { id: 1, period: { ...period, at: { hour: 3, minute: 0, second: 1 } } }],
    ["changeSchedule", { id: 1, period: { kind: "hourly", at: { hour: 3, minute: 0 } } }],
  ] as const)("%s refuses an unknown key: %j", async (name, body) => {
    await start();
    expect((await call(name, body)).status).toBe(400);
  });
});

describe("job actions", () => {
  it("cancels a held job at once and a running job by request, and reports a job that is gone", async () => {
    const held = job("maintenance", "a", "held", { reason: "no-consent" });
    const running = job("maintenance", "b", "running");
    await start();
    expect((await call("cancelJob", { id: held })).body).toEqual({ outcome: "cancelled" });
    expect(readJob(db, held)?.status).toBe("cancelled");
    expect(cancelRunning).not.toHaveBeenCalled();
    expect((await call("cancelJob", { id: running })).body).toEqual({ outcome: "requested" });
    expect(cancelRunning).toHaveBeenCalledWith(running);
    expect(readJob(db, running)?.cancelRequested).toBe(true);
    expect((await call("cancelJob", { id: held })).body).toEqual({ outcome: "finished" });
    expect((await call("cancelJob", { id: 9999 })).body).toEqual({ outcome: "not-found" });
  });

  it("retries a given-up job (queued, the runner woken) and refuses one that is not retryable", async () => {
    const dead = job("maintenance", "a", "dead_letter", { reason: "handler-error" });
    const done = job("maintenance", "b", "succeeded");
    await start();
    expect((await call("retryJob", { id: dead })).body).toEqual({ outcome: "queued" });
    expect(readJob(db, dead)).toMatchObject({ status: "queued", attempts: 0 });
    expect(wake).toHaveBeenCalled();
    wake.mockClear();
    expect((await call("retryJob", { id: done })).body).toEqual({ outcome: "not-retryable" });
    expect(wake).not.toHaveBeenCalled();
    expect((await call("retryJob", { id: 9999 })).body).toEqual({ outcome: "not-found" });
  });

  it("discards only a given-up job", async () => {
    const dead = job("maintenance", "a", "dead_letter", { reason: "handler-error" });
    const queued = job("maintenance", "b", "queued");
    await start();
    expect((await call("discardJob", { id: queued })).body).toEqual({ outcome: "not-dead-letter" });
    expect(readJob(db, queued)?.status).toBe("queued");
    expect((await call("discardJob", { id: dead })).body).toEqual({ outcome: "discarded" });
    expect(readJob(db, dead)?.status).toBe("cancelled");
    expect((await call("discardJob", { id: 9999 })).body).toEqual({ outcome: "not-found" });
  });

  it.each([
    ["cancelJob", { id: 0 }],
    ["cancelJob", { id: 1.5 }],
    ["retryJob", { id: 1, extra: true }],
    ["discardJob", {}],
    [
      "changeSchedule",
      { id: 1, period: { kind: "weekly", weekday: 7, at: { hour: 1, minute: 0 } } },
    ],
    ["changeSchedule", { id: 1, period: { kind: "daily", at: { hour: 24, minute: 0 } } }],
    ["changeSchedule", { id: 1, period: { kind: "minutely" } }],
    ["rebuildProjection", { projection: "" }],
  ] as const)("refuses the malformed %s body %j", async (name, body) => {
    await start();
    expect((await call(name, body)).status).toBe(400);
  });
});

describe("schedule actions", () => {
  it("turns a schedule off and on, changes its period, and runs it now", async () => {
    const { schedule } = scheduler.ensureSchedule({
      kind: "maintenance",
      period: { kind: "hourly" },
    });
    await start();
    const off = (await call("disableSchedule", { id: schedule.id })).body as {
      outcome: string;
      schedule: { enabled: boolean };
    };
    expect(off.outcome).toBe("done");
    expect(off.schedule.enabled).toBe(false);
    expect(scheduler.get(schedule.id)?.enabled).toBe(false);
    const on = (await call("enableSchedule", { id: schedule.id })).body as typeof off;
    expect(on.schedule.enabled).toBe(true);
    const period = { kind: "weekly", weekday: 1, at: { hour: 2, minute: 30 } } as const;
    const changed = (await call("changeSchedule", { id: schedule.id, period })).body as {
      schedule: { period: unknown };
    };
    expect(changed.schedule.period).toEqual(period);
    expect(scheduler.get(schedule.id)?.period).toEqual(period);
    const run = (await call("runSchedule", { id: schedule.id })).body as {
      outcome: string;
      jobId: number;
    };
    expect(run.outcome).toBe("started");
    expect(readJob(db, run.jobId)).toMatchObject({ kind: "maintenance", priority: "user" });
    expect(wake).toHaveBeenCalled();
    // one is open: the same job answers
    expect((await call("runSchedule", { id: schedule.id })).body).toEqual({
      outcome: "already-open",
      jobId: run.jobId,
    });
  });

  it("answers a schedule that does not exist with not-found and changes nothing", async () => {
    await start();
    for (const name of ["disableSchedule", "enableSchedule", "runSchedule"] as const) {
      expect((await call(name, { id: 77 })).body).toEqual({ outcome: "not-found" });
    }
    const period = { kind: "hourly" } as const;
    expect((await call("changeSchedule", { id: 77, period })).body).toEqual({
      outcome: "not-found",
    });
    expect(scheduler.list()).toEqual([]);
  });
});

describe("rebuild", () => {
  it("registers the rebuild of a projection the backend knows, once, and wakes the runner", async () => {
    await start();
    expect((await call("rebuildProjection", { projection: "engine" })).body).toEqual({
      outcome: "requested",
    });
    expect(wake).toHaveBeenCalled();
    expect(
      db.all("SELECT kind, target, priority FROM jobs WHERE kind = 'projection-rebuild'"),
    ).toEqual([{ kind: "projection-rebuild", target: "engine", priority: "user" }]);
    expect((await call("rebuildProjection", { projection: "engine" })).body).toEqual({
      outcome: "already-open",
    });
    expect(db.all("SELECT id FROM jobs")).toHaveLength(1);
  });

  it("registers nothing for a name that is no projection", async () => {
    await start();
    expect((await call("rebuildProjection", { projection: "nope" })).body).toEqual({
      outcome: "unknown-projection",
    });
    expect(db.all("SELECT id FROM jobs")).toEqual([]);
  });
});

describe("request checks", () => {
  const ROUTES: [RouteName, unknown][] = [
    ["jobs", undefined],
    ["cancelJob", { id: 1 }],
    ["retryJob", { id: 1 }],
    ["discardJob", { id: 1 }],
    ["changeSchedule", { id: 1, period: { kind: "hourly" } }],
    ["disableSchedule", { id: 1 }],
    ["enableSchedule", { id: 1 }],
    ["runSchedule", { id: 1 }],
    ["rebuildProjection", { projection: "engine" }],
  ];

  it.each(ROUTES)(
    "%s: no token, a wrong token, another Host and another Origin are refused and nothing changes",
    async (name, body) => {
      const dead = job("maintenance", "a", "dead_letter", { reason: "handler-error" });
      scheduler.ensureSchedule({ kind: "maintenance", period: { kind: "hourly" } });
      await start();
      const refused: [Record<string, string>, number][] = [
        [{ host: valid.host as string, origin: ORIGIN }, 401],
        [{ ...valid, authorization: "Bearer wrong" }, 401],
        [{ ...valid, host: "evil.example" }, 403],
        [{ ...valid, origin: "https://evil.example" }, 403],
      ];
      for (const [headers, status] of refused) {
        expect((await call(name, body, headers)).status).toBe(status);
      }
      expect(readJob(db, dead)?.status).toBe("dead_letter");
      expect(scheduler.get(1)).toMatchObject({ enabled: true, period: { kind: "hourly" } });
      expect(db.all("SELECT id FROM jobs WHERE kind = 'projection-rebuild'")).toEqual([]);
      expect(wake).not.toHaveBeenCalled();
      expect(cancelRunning).not.toHaveBeenCalled();
    },
  );
});
