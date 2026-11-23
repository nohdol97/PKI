// I03-T07 `cancel` (C3, I03-R12 ③): a user's cancel of a queued, retrying, held
// or running job. A running job's request is written, and a runner of the same
// process holding it cuts the handler's signal on the spot instead of at the next
// heartbeat; a runner of another process sees the flag at its next heartbeat. The
// job ends cancelled with no effect and no further handler call. Clocks and
// leases are small and real: nothing here waits for a default lease.
import {
  readJob,
  registerConnectorInstance,
  registerJob,
  saveSourceRecord,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openCanonicalDb } from "./composition.ts";
import { createJobActions } from "./job-actions.ts";
import { createJobRunner, type JobHandler, type JobResult } from "./job-runner.ts";
import { dirTemplate } from "@pki/testkit";

const seedDataDir = dirTemplate((path) => openCanonicalDb(path).close());

let dir: string;
let db: SqlDriver;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-cancel-"));
  seedDataDir(join(dir, "data"));
  db = openCanonicalDb(join(dir, "data"));
  registerConnectorInstance(db, "c", "test-fixtures");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
function imported(): StoredJob {
  return db.transaction(() => {
    saveSourceRecord(db, "c", { externalId: `s${(seq += 1)}`, title: "t", body: "b" });
    const row = db.all("SELECT source_id AS s FROM source_versions ORDER BY id DESC LIMIT 1")[0];
    const r = registerJob(db, { kind: "extract", sourceId: row?.s as number, fenceVersion: 1 });
    if (!r.registered) throw new Error("expected a new job");
    return r.job;
  });
}

const effect = (id: number) => () =>
  void db.run("INSERT INTO settings (key, value) VALUES (?, 'x')", [`effect-${id}`]);
const effects = () => db.all("SELECT key FROM settings WHERE key LIKE 'effect-%'").length;

/** A short lease, so the heartbeat (a quarter of it) is quick: the test build's setting. */
const runnerOf = (handler: JobHandler, leaseMs = 4_000) =>
  createJobRunner({ db, handlers: { extract: handler }, testBuild: { leaseMs } });

/** A handler that has started, waits for its signal and then hands back a result to write. */
function waiting() {
  const state = { calls: 0, aborted: false, started: Promise.withResolvers<undefined>() };
  const handler: JobHandler = async (job, { signal }) => {
    state.calls++;
    state.started.resolve(undefined);
    await new Promise((resolve) => signal.addEventListener("abort", resolve));
    state.aborted = true;
    return { status: "succeeded", write: effect(job.id) } satisfies JobResult;
  };
  return { state, handler };
}

describe("cancel (I03-R12, C3)", () => {
  it("closes a queued job at once, and a held and a retrying one too", () => {
    const actions = createJobActions({ db, runner: runnerOf(async () => ({ status: "yield" })) });
    const ids = [imported(), imported(), imported()].map((j) => j.id);
    const [, held, retrying] = ids as [number, number, number];
    db.run("UPDATE jobs SET status = 'held', reason = 'no-consent' WHERE id = ?", [held]);
    db.run("UPDATE jobs SET status = 'retry', reason = 'timeout' WHERE id = ?", [retrying]);
    expect(ids.map((id) => actions.cancel(id))).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(ids.map((id) => readJob(db, id)?.status)).toEqual(Array(3).fill("cancelled"));
  });

  it("cuts a running job's signal in the same process without waiting for a heartbeat: cancelled, no effect, no later call", async () => {
    const { state, handler } = waiting();
    const runner = runnerOf(handler, 600_000); // a heartbeat would come after 150 s
    const actions = createJobActions({ db, runner });
    const job = imported();
    const run = runner.runOnce();
    await state.started.promise;
    expect(actions.cancel(job.id)).toBe("requested");
    expect(await run).toEqual({ jobId: job.id, status: "cancelled" });
    expect(state.aborted).toBe(true);
    expect(effects()).toBe(0);
    expect(readJob(db, job.id)).toMatchObject({ status: "cancelled", leaseUntil: null });
    await runner.wake(); // nothing is claimed again
    expect(state.calls).toBe(1);
  });

  it("stops waiting for a handler that ignores its signal", async () => {
    let calls = 0;
    const runner = runnerOf(() => {
      calls++;
      return new Promise<never>(() => {}); // never answers, never looks at its signal
    }, 600_000);
    const actions = createJobActions({ db, runner });
    const job = imported();
    const run = runner.runOnce();
    await vi.waitFor(() => expect(calls).toBe(1));
    actions.cancel(job.id);
    expect(await run).toEqual({ jobId: job.id, status: "cancelled" });
  });

  it("sees a flag another process wrote at its next heartbeat", async () => {
    const { state, handler } = waiting();
    const runner = runnerOf(handler, 80); // a heartbeat every 20 ms
    const job = imported();
    const run = runner.runOnce();
    await state.started.promise;
    db.run("UPDATE jobs SET cancel_requested = 1 WHERE id = ?", [job.id]); // not through this runner
    expect(await run).toEqual({ jobId: job.id, status: "cancelled" });
    expect(state.aborted).toBe(true);
    expect(effects()).toBe(0);
  });

  it("answers 'finished' for a succeeded job and changes nothing", async () => {
    const runner = runnerOf(async (job) => ({ status: "succeeded", write: effect(job.id) }));
    const actions = createJobActions({ db, runner });
    const job = imported();
    await runner.runOnce();
    expect(actions.cancel(job.id)).toBe("finished");
    expect(readJob(db, job.id)?.status).toBe("succeeded");
    expect(effects()).toBe(1);
  });

  it("does not cut anything for a job this runner does not hold", () => {
    const runner = runnerOf(async () => ({ status: "yield" }));
    expect(runner.cancelRunning(12345)).toBe(false);
  });
});
