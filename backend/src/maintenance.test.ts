// I03-T09, I03-R21 (retention): the `maintenance` job deletes the job rows that ended more
// than 30 days ago and keeps the one kind of row that is still a mark, a given-up
// `projection-remove` that no rebuild has closed. The cleanup period itself (daily 03:00,
// never paused) is the scheduler's and schedule.defaults'. Time is injected.
import {
  closeCoveredRemoves,
  readJob,
  registerConnectorInstance,
  registerJob,
  saveSourceRecord,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { seedLegacyTombstone, dirTemplate } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Clock } from "./clock.ts";
import { openCanonicalDb } from "./composition.ts";
import { createMaintenanceHandler, RETENTION_MS } from "./maintenance.ts";
import { createJobRunner } from "./job-runner.ts";
import { createScheduler } from "./scheduler.ts";
import { MAINTENANCE_KIND } from "./scheduler.ts";

const seedDataDir = dirTemplate((path) => openCanonicalDb(path).close());

const DAY = 24 * 60 * 60_000;
const T0 = Date.parse("2026-11-22T03:00:00.000Z");

let dir: string;
let db: SqlDriver;
let wall = T0;
const clock: Clock = {
  now: () => wall,
  monotonic: () => 0,
  sleep: () => Promise.reject(new Error("nothing here waits")),
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-maintenance-"));
  seedDataDir(join(dir, "data"));
  db = openCanonicalDb(join(dir, "data"));
  wall = T0;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const runner = () =>
  createJobRunner({
    db,
    clock,
    handlers: { [MAINTENANCE_KIND]: createMaintenanceHandler({ db, clock }) },
  });

let n = 0;
/** A sourceless job in `status` that ended `ageDays` before the clock now. */
function ended(kind: string, status: string, ageDays: number, target = `t${(n += 1)}`): StoredJob {
  const r = registerJob(db, { kind, target, at: new Date(wall - 90 * DAY) });
  if (!r.registered) throw new Error("expected a new job");
  db.run("UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?", [
    status,
    wall - ageDays * DAY,
    r.job.id,
  ]);
  return r.job;
}
const exists = (id: number) => readJob(db, id) !== undefined;

function cleanup(): StoredJob {
  const r = registerJob(db, {
    kind: MAINTENANCE_KIND,
    priority: "maintenance",
    schedule: { id: 1, slot: wall },
    at: new Date(wall),
  });
  if (!r.registered) throw new Error("expected a new job");
  return r.job;
}

describe("retention (I03-R21): the cleanup job", () => {
  it("is thirty days", () => {
    expect(RETENTION_MS).toBe(30 * DAY);
  });

  it("deletes succeeded, cancelled, superseded and dead_letter rows ended 31 days ago and keeps those ended 29 days ago", async () => {
    const old = ["succeeded", "cancelled", "superseded", "dead_letter"].map((s) =>
      ended("extract-like", s, 31),
    );
    const young = ["succeeded", "cancelled", "superseded", "dead_letter"].map((s) =>
      ended("extract-like", s, 29),
    );
    const open = ["queued", "retry", "held"].map((s) => ended("extract-like", s, 31));
    const job = cleanup();
    await runner().runOnce();
    expect(old.map((j) => exists(j.id))).toEqual([false, false, false, false]);
    expect(young.map((j) => exists(j.id))).toEqual([true, true, true, true]);
    expect(open.map((j) => exists(j.id))).toEqual([true, true, true]);
    expect(readJob(db, job.id)).toMatchObject({ status: "succeeded" });
    expect(JSON.parse(readJob(db, job.id)?.resultCounts as string)).toEqual({ purged: 4 });
  });

  it("keeps a given-up projection removal until a rebuild closes it, then lets the retention take it", async () => {
    registerConnectorInstance(db, "c1", "test-fixtures");
    const saved = saveSourceRecord(db, "c1", { externalId: "gone", title: "t", body: "b" });
    if (saved.status !== "created") throw new Error("expected a version");
    seedLegacyTombstone(db, {
      sourceId: saved.sourceId,
      version: saved.version,
      at: "x",
      reason: "user-deleted",
    });
    const removal = registerJob(db, {
      kind: "projection-remove",
      target: "engine",
      sourceId: saved.sourceId,
      fenceVersion: saved.version,
      at: new Date(wall - 90 * DAY),
    });
    if (!removal.registered) throw new Error("expected a new job");
    db.run("UPDATE jobs SET status = 'dead_letter', finished_at = ? WHERE id = ?", [
      wall - 31 * DAY,
      removal.job.id,
    ]);

    cleanup();
    await runner().runOnce();
    expect(readJob(db, removal.job.id)?.status).toBe("dead_letter"); // the mark stands

    // the projection is rebuilt: the rebuild closes the removal it covers
    expect(closeCoveredRemoves(db, "engine", Number.MAX_SAFE_INTEGER, new Date(wall))).toBe(1);
    expect(readJob(db, removal.job.id)?.status).toBe("superseded");
    wall += 29 * DAY;
    wall += 2 * DAY; // 31 days after the rebuild closed it
    cleanup();
    await runner().runOnce();
    expect(exists(removal.job.id)).toBe(false);
  });

  it("deletes the cleanup job's own old rows and finishes its own run", async () => {
    const oldRun = ended(MAINTENANCE_KIND, "succeeded", 31, "");
    const job = cleanup();
    await runner().runOnce();
    expect(exists(oldRun.id)).toBe(false);
    expect(readJob(db, job.id)?.status).toBe("succeeded");
  });

  it("leaves a schedule's dead-letter marker dangling but harmless: ids only grow, so a later give-up still pauses it", async () => {
    const scheduler = createScheduler({ db, clock, timeZone: () => "UTC" });
    const { schedule } = scheduler.ensureSchedule({
      kind: "connector-sync",
      target: "c1",
      period: { kind: "hourly" },
    });
    const giveUp = (slot: number) => {
      const r = registerJob(db, {
        kind: "connector-sync",
        target: "c1",
        schedule: { id: schedule.id, slot },
        at: new Date(wall),
      });
      if (!r.registered) throw new Error("expected a new job");
      db.run("UPDATE jobs SET status = 'dead_letter', reason = 'x', finished_at = ? WHERE id = ?", [
        wall - 40 * DAY,
        r.job.id,
      ]);
      return r.job.id;
    };
    const first = giveUp(1);
    scheduler.check();
    expect(scheduler.get(schedule.id)?.pause).toEqual({ kind: "failed", code: "x" });
    scheduler.enable(schedule.id); // the marker is now `first`
    giveUp(2); // a newer row, so `first` is not the newest and is purged
    cleanup();
    await runner().runOnce();
    expect(exists(first)).toBe(false);
    const again = giveUp(3);
    expect(again).toBeGreaterThan(first);
    scheduler.check();
    expect(scheduler.get(schedule.id)?.pause).toEqual({ kind: "failed", code: "x" });
  });
});
