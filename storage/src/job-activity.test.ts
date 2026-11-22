// I03-T11, the storage half of R23: what the Activity screen counts and lists, with
// no source text (a job row holds none) and the projection's rebuild state of R7.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { countJobsByStatus, listRecentJobs, projectionActivity } from "./job-activity.ts";
import { readJob, registerJob, transitionJob } from "./jobs.ts";
import { migrate } from "./migrations.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
  n = 0;
});
afterEach(() => db.close());

const T0 = new Date("2026-11-21T00:00:00.000Z");
let at = 0;
let n = 0;
/** A job of `kind` for `target`: a removal names a source of its own, any other kind none. */
function register(kind: string, target: string) {
  const base = { kind, target, at: tick() };
  if (kind !== "projection-remove") return registerJob(db, base);
  saveSourceRecord(db, "c1", { externalId: `e${(n += 1)}`, title: "t", body: "b" });
  return registerJob(db, { ...base, sourceId: n, fenceVersion: 1 });
}
const tick = () => new Date(T0.getTime() + (at += 1000));

/** A sourceless job of `kind`/`target`, written as ended (these tests read rows, they do not run jobs). */
function ended(kind: string, target: string, status: "dead_letter" | "succeeded"): number {
  const r = register(kind, target);
  if (!r.registered) throw new Error("not registered");
  db.run("UPDATE jobs SET status = ?, reason = ?, finished_at = ? WHERE id = ?", [
    status,
    status === "dead_letter" ? "projection-error" : null,
    tick().getTime(),
    r.job.id,
  ]);
  return r.job.id;
}
const open = (kind: string, target: string) => {
  const r = register(kind, target);
  if (!r.registered) throw new Error("not registered");
  return r.job.id;
};

describe("countJobsByStatus", () => {
  it("counts every status, zero included, over all rows", () => {
    open("maintenance", "");
    ended("projection-remove", "engine", "dead_letter");
    ended("projection-rebuild", "engine", "succeeded");
    expect(countJobsByStatus(db)).toEqual({
      queued: 1,
      running: 0,
      retry: 0,
      held: 0,
      succeeded: 1,
      superseded: 0,
      cancelled: 0,
      dead_letter: 1,
    });
  });
});

describe("listRecentJobs", () => {
  it("lists newest first up to the limit and says whether more exist", () => {
    const ids = [1, 2, 3].map((i) => open("maintenance", `t${i}`));
    const two = listRecentJobs(db, 2);
    expect(two.jobs.map((j) => j.id)).toEqual([ids[2], ids[1]]);
    expect(two.truncated).toBe(true);
    const all = listRecentJobs(db, 3);
    expect(all.jobs).toHaveLength(3);
    expect(all.truncated).toBe(false);
    expect(all.jobs[0]).toEqual(readJob(db, ids[2] as number));
  });
});

describe("projectionActivity", () => {
  it("names a projection only while a removal or a rebuild has something to show", () => {
    expect(projectionActivity(db)).toEqual([]);
    ended("projection-remove", "engine", "succeeded");
    expect(projectionActivity(db)).toEqual([]);
  });

  it("counts the open and given-up removals per projection", () => {
    ended("projection-remove", "engine", "dead_letter");
    open("projection-remove", "engine");
    ended("projection-remove", "vector", "dead_letter");
    ended("projection-remove", "vector", "dead_letter");
    const rows = projectionActivity(db);
    expect(rows).toEqual([
      { name: "engine", openRemoves: 1, deadRemoves: 1, rebuild: "none" },
      { name: "vector", openRemoves: 0, deadRemoves: 2, rebuild: "none" },
    ]);
  });

  it("shows a rebuild that is open as pending, and one that keeps being given up as repeating", () => {
    open("projection-rebuild", "engine");
    expect(projectionActivity(db)).toEqual([
      { name: "engine", openRemoves: 0, deadRemoves: 0, rebuild: "pending" },
    ]);
    const first = ended("projection-rebuild", "vector", "dead_letter");
    // one given-up rebuild with none open waits for the next check to register again
    expect(projectionActivity(db).find((p) => p.name === "vector")?.rebuild).toBe("pending");
    open("projection-rebuild", "vector"); // the next check's
    expect(projectionActivity(db).find((p) => p.name === "vector")?.rebuild).toBe("repeating");
    expect(first).toBeGreaterThan(0);
  });

  it("counts only the given-up rebuilds after the last good one, and a good one ends the repeat", () => {
    ended("projection-rebuild", "engine", "dead_letter");
    ended("projection-rebuild", "engine", "dead_letter");
    expect(projectionActivity(db)[0]?.rebuild).toBe("repeating");
    ended("projection-rebuild", "engine", "succeeded");
    expect(projectionActivity(db)).toEqual([]);
  });

  it("discarding the latest given-up rebuild ends the repeat: the earlier ones are before a settled one", () => {
    ended("projection-rebuild", "engine", "dead_letter");
    const latest = ended("projection-rebuild", "engine", "dead_letter");
    expect(projectionActivity(db)[0]?.rebuild).toBe("repeating");
    transitionJob(db, latest, { from: "dead_letter", to: "cancelled", at: tick() });
    expect(projectionActivity(db)).toEqual([]);
  });
});
