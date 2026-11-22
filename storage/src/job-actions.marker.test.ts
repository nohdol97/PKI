// I03-T11 review A1: a removal that is not finished or was given up is the stored mark that its
// projection may still hold deleted content (I03-R7 "표식"). A user's cancel or discard must not
// clear it: only the rebuild that covers it closes it. Retry keeps it, and the actions on a
// rebuild never touch it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { cancelJob, discardJob, retryJob } from "./job-actions.ts";
import { readJob, registerJob } from "./jobs.ts";
import { migrate } from "./migrations.ts";
import { markedProjections } from "./projection-jobs.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";

let db: SqlDriver;
let n = 0;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
  n = 0;
});
afterEach(() => db.close());

const START = { phase: "start" } as const;
const mark = () => markedProjections(db, START);

/** A removal for `projection`, in `status` (rows written, not run). */
function remove(projection: string, status: string): number {
  saveSourceRecord(db, "c1", { externalId: `e${(n += 1)}`, title: "t", body: "b" });
  const r = registerJob(db, {
    kind: "projection-remove",
    target: projection,
    sourceId: n,
    fenceVersion: 1,
  });
  if (!r.registered) throw new Error("not registered");
  db.run("UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?", [
    status,
    status === "dead_letter" ? 1 : null,
    r.job.id,
  ]);
  return r.job.id;
}
function rebuild(projection: string, status: string): number {
  const r = registerJob(db, { kind: "projection-rebuild", target: projection });
  if (!r.registered) throw new Error("not registered");
  db.run("UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?", [
    status,
    status === "dead_letter" ? 1 : null,
    r.job.id,
  ]);
  return r.job.id;
}

describe("a removal's mark survives the user's actions", () => {
  it.each(["queued", "retry", "held", "running"])("refuses to cancel a %s removal", (status) => {
    const id = remove("engine", status);
    remove("vector", "dead_letter");
    expect(mark()).toEqual(["engine", "vector"]);
    expect(cancelJob(db, id)).toBe("not-allowed");
    expect(readJob(db, id)?.status).toBe(status);
    expect(readJob(db, id)?.cancelRequested).toBe(false);
    expect(mark()).toEqual(["engine", "vector"]);
  });

  it("refuses to discard a given-up removal, whichever of several it is", () => {
    const first = remove("engine", "dead_letter");
    const second = remove("vector", "dead_letter");
    expect(discardJob(db, second)).toBe("not-allowed");
    expect(discardJob(db, first)).toBe("not-allowed");
    expect(readJob(db, first)?.status).toBe("dead_letter");
    expect(readJob(db, second)?.status).toBe("dead_letter");
    expect(mark()).toEqual(["engine", "vector"]);
  });

  it("still tells a finished removal from a refusal, and a missing one", () => {
    const done = remove("engine", "succeeded");
    expect(cancelJob(db, done)).toBe("finished");
    expect(discardJob(db, done)).toBe("not-dead-letter");
    expect(cancelJob(db, 9999)).toBe("not-found");
  });

  it("keeps the mark when a given-up removal is tried again, and when a rebuild is cancelled or discarded", () => {
    const dead = remove("engine", "dead_letter");
    remove("vector", "held");
    expect(retryJob(db, dead)).toBe("queued");
    expect(mark()).toEqual(["engine", "vector"]);
    const open = rebuild("engine", "queued");
    const given = rebuild("vector", "dead_letter");
    expect(cancelJob(db, open)).toBe("cancelled");
    expect(discardJob(db, given)).toBe("discarded");
    expect(mark()).toEqual(["engine", "vector"]);
  });

  it("does not stop the actions on other kinds", () => {
    const r = registerJob(db, { kind: "maintenance" });
    if (!r.registered) throw new Error("not registered");
    expect(cancelJob(db, r.job.id)).toBe("cancelled");
  });
});
