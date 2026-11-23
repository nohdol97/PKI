// I03-T10, R7 and the evidence of C1: the executing side of the projection jobs, on a real
// SQLite file with test doubles for the projections (the engine and the vector index the
// product binds are I04-T04's). `projection.classify` (what each projection error does),
// `projection.stale-reissue` and `projection.newer-version` (a removal after a newer
// notice), `projection.rebuild-race` (a rebuild covers only the removals up to the
// change sequence it read), `projection.fallback` (the markers force a rebuild when the
// change sequences agree) and `projection.request` (the forced rebuild). The clock is
// injected; nothing sleeps.
import { AdapterUnavailableError, StaleFenceError } from "@pki/contracts";
import { userDelete, liftTombstone } from "@pki/knowledge-engine";
import {
  canonicalTransaction,
  createDerivativeRegistry,
  findSourceId,
  readChangeSeq,
  readJob,
  registerConnectorInstance,
  registerJob,
  saveSourceRecord,
  type DerivativeKind,
  type ScopePolicy,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootBackend } from "./boot.ts";
import type { Clock } from "./clock.ts";
import { openCanonicalDb } from "./composition.ts";
import { createJobRunner, type JobRunner } from "./job-runner.ts";
import {
  checkProjectionMarkers,
  projectionHandlers,
  PROJECTION_KIND_SETTINGS,
  requestProjectionRebuild,
  type ProjectionPort,
  type ProjectionPorts,
  type ProjectionRemoveRequest,
} from "./projection-jobs.ts";
import { createScheduler } from "./scheduler.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";
import { dirTemplate } from "@pki/testkit";

const seedDataDir = dirTemplate((path) => openCanonicalDb(path).close());

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-11-22T00:00:00.000Z");
const CANARY = (name: string) => `CANARY-${name}`;

let dir: string;
let db: SqlDriver;
const open: SqlDriver[] = [];
let wall = T0;
const clock: Clock = { now: () => wall, sleep: async () => {}, monotonic: () => 0 };

const reopen = (): SqlDriver => {
  const next = openCanonicalDb(dir);
  open.push(next);
  return next;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-projection-jobs-"));
  seedDataDir(dir);
  db = reopen();
  wall = T0;
  registerConnectorInstance(db, "c", "test-fixtures");
});
afterEach(() => {
  for (const d of open.splice(0)) d.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A projection double: items by source and version, the engine's fence rule, a rebuild from the store. */
class FakeProjection implements ProjectionPort {
  readonly registered: { permanentlyAbsent?: true };
  items = new Map<number, Map<number, string>>();
  fence = new Map<number, number>();
  removedThrough = new Map<number, number>();
  applied: number | null = null;
  /** Thrown by the next removals while set. */
  removeFails: Error | undefined;
  removeCalls: {
    sourceId: number;
    coversVersion: number;
    fenceVersion: number;
    changeSeq: number;
  }[] = [];
  rebuildReads: number[] = [];
  /** Called inside a rebuild: after the sequence was handed over, and after the sources were read. */
  afterSeq: (() => void) | undefined;
  afterRead: (() => void) | undefined;

  private readonly database: () => SqlDriver;

  constructor(database: () => SqlDriver, absent = false) {
    this.database = database;
    this.registered = absent ? { permanentlyAbsent: true } : {};
  }

  upsert(sourceId: number, version: number, body: string, seq = readChangeSeq(this.database())) {
    if (version <= (this.removedThrough.get(sourceId) ?? 0)) throw new StaleFenceError("removed");
    this.fence.set(sourceId, version);
    this.items.set(sourceId, (this.items.get(sourceId) ?? new Map()).set(version, body));
    this.applied = seq;
  }

  async remove(request: ProjectionRemoveRequest): Promise<void> {
    const { sourceId, coversVersion, fenceVersion, changeSeq } = request;
    this.removeCalls.push({ sourceId, coversVersion, fenceVersion, changeSeq });
    if (this.removeFails) throw this.removeFails;
    if (fenceVersion < (this.fence.get(sourceId) ?? 0)) {
      throw new StaleFenceError(`${sourceId}: fence v${fenceVersion}`);
    }
    this.fence.set(sourceId, fenceVersion);
    this.removedThrough.set(
      sourceId,
      Math.max(coversVersion, this.removedThrough.get(sourceId) ?? 0),
    );
    const versions = this.items.get(sourceId);
    for (const v of [...(versions?.keys() ?? [])]) if (v <= coversVersion) versions?.delete(v);
    this.applied = Math.max(this.applied ?? changeSeq, changeSeq);
  }

  async rebuild({ readSeq }: { readSeq: number }): Promise<void> {
    this.rebuildReads.push(readSeq);
    this.items.clear();
    this.fence.clear();
    this.removedThrough.clear();
    this.afterSeq?.();
    const rows = this.database().all(
      `SELECT v.source_id, v.version, v.body FROM source_versions v
        WHERE v.version = (SELECT max(version) FROM source_versions WHERE source_id = v.source_id)`,
    );
    for (const r of rows) {
      const id = r.source_id as number;
      this.items.set(id, new Map([[r.version as number, r.body as string]]));
      this.fence.set(id, r.version as number);
    }
    this.afterRead?.();
    this.applied = readSeq;
  }

  holds(text: string): boolean {
    return [...this.items.values()].some((byVersion) =>
      [...byVersion.values()].some((body) => body.includes(text)),
    );
  }

  versionsOf(sourceId: number): number[] {
    return [...(this.items.get(sourceId)?.keys() ?? [])].sort();
  }
}

const ports = (...entries: [string, ProjectionPort][]): ProjectionPorts =>
  Object.fromEntries(entries);

function runnerOf(p: ProjectionPorts): JobRunner {
  return createJobRunner({
    db,
    handlers: projectionHandlers({ db, ports: p, now: () => new Date(wall) }),
    kinds: PROJECTION_KIND_SETTINGS,
    clock,
  });
}

/** Runs every job that is due now, one after another. */
async function drain(runner: JobRunner): Promise<void> {
  for (let guard = 0; guard < 50; guard++) if (!(await runner.runOnce())) return;
  throw new Error("the runner did not go idle");
}

const stored = (externalId: string, body: string) => {
  const saved = saveSourceRecord(db, "c", { externalId, title: "t", body });
  if (saved.status !== "created") throw new Error("expected a version");
  return saved;
};
const identity = (externalId: string) => ({
  connectorInstanceId: "c",
  namespace: "",
  externalId,
});
const iso = () => new Date(wall).toISOString();

/**
 * The user's deletion. Its transaction registers a removal for each registered projection kind (I04-R12);
 * these tests drive one projection at a time, so only the removal for `target` is kept, registered by hand
 * for a target the registry has no kind for.
 */
function deleted(externalId: string, target = "engine"): StoredJob {
  const sourceId = findSourceId(db, "c", "", externalId) as number;
  const { outcome, coversVersion } = userDelete(db, identity(externalId), iso());
  if (outcome === "unchanged") throw new Error("nothing was deleted");
  db.run("DELETE FROM jobs WHERE kind = 'projection-remove' AND source_id = ? AND target != ?", [
    sourceId,
    target,
  ]);
  const own = db.all(
    "SELECT id FROM jobs WHERE kind = 'projection-remove' AND source_id = ? AND target = ?",
    [sourceId, target],
  );
  if (own[0]) return job(own[0].id as number);
  const r = registerJob(db, {
    kind: "projection-remove",
    target,
    sourceId,
    fenceVersion: coversVersion,
    at: new Date(wall),
  });
  if (!r.registered) throw new Error("expected a new job");
  return r.job;
}
const job = (id: number) => readJob(db, id) as StoredJob;
const openRebuilds = (target = "engine") =>
  db.all(
    "SELECT id FROM jobs WHERE kind = 'projection-rebuild' AND target = ? AND status IN ('queued','running','retry','held')",
    [target],
  );
const rebuildJobs = () =>
  db.all("SELECT id, status, reason FROM jobs WHERE kind = 'projection-rebuild' ORDER BY id");

describe("projection.classify", () => {
  it("a removal on a kind marked permanentlyAbsent ends at once as a skip: succeeded with the code adapter-unavailable, no retry, no marker", async () => {
    const empty = new FakeProjection(() => db, true);
    empty.remove = async (r) => {
      empty.removeCalls.push(r);
      throw new AdapterUnavailableError("empty vector index");
    };
    stored("a", "x");
    const removal = deleted("a", "vector");
    const runner = runnerOf(ports(["vector", empty]));
    await drain(runner);
    expect(job(removal.id)).toMatchObject({
      status: "succeeded",
      reason: "adapter-unavailable",
      attempts: 1,
    });
    expect(empty.removeCalls).toHaveLength(1);
    expect(checkProjectionMarkers(db, { phase: "start", now: wall })).toEqual([]);
    expect(checkProjectionMarkers(db, { phase: "check", now: wall + 5 * HOUR })).toEqual([]);
    expect(rebuildJobs()).toEqual([]);
  });

  it("one malformed marked row does not stop the others or the start: it is logged and skipped", () => {
    stored("a", "x");
    stored("b", "y");
    const bad = deleted("a");
    deleted("b");
    db.run("UPDATE jobs SET target = '' WHERE id = ?", [bad.id]); // a row no code writes
    const marked = () => checkProjectionMarkers(db, { phase: "start", now: wall });
    expect(() => marked()).not.toThrow();
    expect(db.all("SELECT target FROM jobs WHERE kind = 'projection-rebuild'")).toEqual([
      { target: "engine" },
    ]);
  });

  it("the same error from a kind without the mark (a stopped sidecar) is a retry, not a skip, and the removal stays a marker", async () => {
    const sidecar = new FakeProjection(() => db);
    sidecar.removeFails = new AdapterUnavailableError("sidecar down");
    stored("a", "x");
    const removal = deleted("a");
    const runner = runnerOf(ports(["engine", sidecar]));
    await drain(runner);
    expect(job(removal.id)).toMatchObject({
      status: "retry",
      reason: "projection-unavailable",
      attempts: 1,
    });
    // the marker stands at start, and at a check once it has been open an hour
    expect(checkProjectionMarkers(db, { phase: "start", now: wall }).map((j) => j.target)).toEqual([
      "engine",
    ]);
  });

  it("another error retries with the backoff of its attempt, stores a code and never the error's text", async () => {
    const engine = new FakeProjection(() => db);
    engine.removeFails = new Error(`boom ${CANARY("text")}`);
    stored("a", "x");
    const removal = deleted("a");
    const runner = runnerOf(ports(["engine", engine]));
    await drain(runner);
    expect(job(removal.id)).toMatchObject({
      status: "retry",
      reason: "projection-error",
      runAfter: wall + 30_000,
    });
    wall += 30_000;
    await drain(runner);
    expect(job(removal.id)).toMatchObject({
      status: "retry",
      attempts: 2,
      runAfter: wall + 60_000,
    });
    expect(JSON.stringify(job(removal.id))).not.toContain(CANARY("text"));
  });

  it("gives up after the attempts are spent, and the given-up removal is a marker a check turns into a rebuild", async () => {
    const engine = new FakeProjection(() => db);
    engine.removeFails = new Error("down");
    stored("a", "x");
    const removal = deleted("a");
    const runner = runnerOf(ports(["engine", engine]));
    for (let i = 0; i < 6; i++) {
      wall += HOUR; // far past any backoff
      await drain(runner);
    }
    expect(job(removal.id).status).toBe("dead_letter");
    const requested = checkProjectionMarkers(db, { phase: "check", now: wall });
    expect(requested.map((j) => [j.kind, j.target])).toEqual([["projection-rebuild", "engine"]]);
  });

  it("a removal for a projection nobody bound is retried with the backoff, then given up with the code unknown-projection", async () => {
    stored("a", "x");
    const removal = deleted("a", "graph");
    const runner = runnerOf(ports());
    await drain(runner);
    expect(job(removal.id)).toMatchObject({
      status: "retry",
      reason: "unknown-projection",
      runAfter: wall + 30_000,
    });
    for (let i = 0; i < 6; i++) {
      wall += HOUR;
      await drain(runner);
    }
    expect(job(removal.id)).toMatchObject({ status: "dead_letter", reason: "unknown-projection" });
  });

  it("scheduler checks with no port bound keep the rebuild rows bounded; a new removal lets a check register again", async () => {
    stored("a", "x");
    deleted("a", "graph");
    const runner = runnerOf(ports());
    const scheduler = createScheduler({ db, clock, timeZone: () => "UTC" });
    // 12 hours of two-minute checks (a check every 30 s only adds identical rows), the runner draining after each
    for (let i = 0; i < 360; i++) {
      wall += 2 * MIN;
      scheduler.check();
      await drain(runner);
    }
    const rows = rebuildJobs();
    expect(rows.length).toBeLessThanOrEqual(2);
    expect(rows.at(-1)).toMatchObject({ status: "dead_letter", reason: "unknown-projection" });
    expect(openRebuilds("graph")).toEqual([]);
    // until something changes: a removal registered after the dead rebuild marks the target again
    stored("b", "y");
    deleted("b", "graph");
    const before = rebuildJobs().length;
    wall += HOUR + 1;
    scheduler.check();
    expect(rebuildJobs().length).toBe(before + 1);
  });

  it("at start the suppression does not apply: a boot may have bound the port", () => {
    stored("a", "x");
    const removal = deleted("a", "graph");
    db.run("UPDATE jobs SET status = 'dead_letter' WHERE id = ?", [removal.id]);
    const dead = requestProjectionRebuild(db, "graph", { at: new Date(wall) });
    db.run("UPDATE jobs SET status = 'dead_letter', reason = 'unknown-projection' WHERE id = ?", [
      dead.job.id,
    ]);
    db.run("UPDATE jobs SET created_at = created_at - 1 WHERE id = ?", [removal.id]);
    expect(checkProjectionMarkers(db, { phase: "check", now: wall })).toEqual([]);
    expect(checkProjectionMarkers(db, { phase: "start", now: wall }).map((j) => j.target)).toEqual([
      "graph",
    ]);
  });

  it("the removal of a deleted source is not closed by the version fence: it runs and succeeds (R7)", async () => {
    const engine = new FakeProjection(() => db);
    const saved = stored("a", CANARY("fence"));
    engine.upsert(saved.sourceId, saved.version, CANARY("fence"));
    const removal = deleted("a");
    expect(db.all("SELECT 1 FROM source_versions WHERE source_id = ?", [saved.sourceId])).toEqual(
      [],
    );
    await drain(runnerOf(ports(["engine", engine])));
    expect(job(removal.id)).toMatchObject({ status: "succeeded", reason: null });
    expect(engine.holds(CANARY("fence"))).toBe(false);
    expect(engine.removeCalls).toEqual([
      {
        sourceId: saved.sourceId,
        coversVersion: 1,
        fenceVersion: 1,
        changeSeq: removal.registeredChangeSeq,
      },
    ]);
  });
});

describe("projection.stale-reissue", () => {
  it("a removal that fails, a lift, a newer version applied, then StaleFenceError: re-sent with the source's latest canonical version, succeeded, v1 to v3 gone and v4 kept", async () => {
    const engine = new FakeProjection(() => db);
    const v1 = stored("a", `one ${CANARY("v1")}`);
    stored("a", `two ${CANARY("v2")}`);
    stored("a", `three ${CANARY("v3")}`);
    for (const [v, body] of [
      [1, CANARY("v1")],
      [2, CANARY("v2")],
      [3, CANARY("v3")],
    ] as const) {
      engine.upsert(v1.sourceId, v, body);
    }
    const removal = deleted("a");
    expect(removal.fenceVersion).toBe(3);
    engine.removeFails = new Error("engine down");
    const runner = runnerOf(ports(["engine", engine]));
    await drain(runner);
    expect(job(removal.id).status).toBe("retry");

    // the user lifts the deletion, the source comes back as v4 and the engine takes it
    canonicalTransaction(db, (tx) => liftTombstone(tx, v1.sourceId, iso()));
    const v4 = saveSourceRecord(db, "c", {
      externalId: "a",
      title: "t",
      body: `four ${CANARY("v4")}`,
    });
    expect(v4).toMatchObject({ status: "created", version: 4 });
    engine.upsert(v1.sourceId, 4, CANARY("v4"));
    engine.removeFails = undefined;

    wall += HOUR;
    await drain(runner);
    expect(engine.removeCalls.slice(1)).toEqual([
      {
        sourceId: v1.sourceId,
        coversVersion: 3,
        fenceVersion: 3,
        changeSeq: removal.registeredChangeSeq,
      },
      {
        sourceId: v1.sourceId,
        coversVersion: 3,
        fenceVersion: 4,
        changeSeq: removal.registeredChangeSeq,
      },
    ]);
    expect(job(removal.id).status).toBe("succeeded"); // not superseded: the notice was newer, the job is not
    expect(engine.versionsOf(v1.sourceId)).toEqual([4]);
    expect(engine.holds(CANARY("v1"))).toBe(false);
    expect(engine.holds(CANARY("v3"))).toBe(false);
    expect(engine.holds(CANARY("v4"))).toBe(true);
  });

  it("a removal still stale after the re-sends the run allows is a retryable failure, not a success", async () => {
    const engine = new FakeProjection(() => db);
    engine.remove = async (r) => {
      engine.removeCalls.push(r);
      throw new StaleFenceError("always");
    };
    stored("a", "x");
    const removal = deleted("a");
    await drain(runnerOf(ports(["engine", engine])));
    expect(job(removal.id)).toMatchObject({ status: "retry", reason: "stale-fence" });
    expect(engine.removeCalls.length).toBeGreaterThan(1); // it did re-send
    expect(engine.removeCalls.length).toBeLessThanOrEqual(3);
  });

  it("a stale fence on a vector-like projection re-sends the same way (the port hides the fence's form)", async () => {
    const vector = new FakeProjection(() => db);
    let first = true;
    vector.remove = async (r) => {
      vector.removeCalls.push(r);
      if (first) {
        first = false;
        throw new StaleFenceError("older sequence");
      }
    };
    const saved = stored("a", "x");
    const removal = deleted("a", "vector");
    await drain(runnerOf(ports(["vector", vector])));
    expect(job(removal.id).status).toBe("succeeded");
    expect(vector.removeCalls.map((c) => c.fenceVersion)).toEqual([1, saved.version]);
  });
});

describe("projection.newer-version", () => {
  it("a removal that runs late leaves the newer version's item and removes only versions up to the cover", async () => {
    const engine = new FakeProjection(() => db);
    const v1 = stored("a", CANARY("v1"));
    stored("a", CANARY("v2"));
    engine.upsert(v1.sourceId, 1, CANARY("v1"));
    engine.upsert(v1.sourceId, 2, CANARY("v2"));
    const removal = deleted("a"); // tombstone covers 2
    expect(removal.fenceVersion).toBe(2);
    canonicalTransaction(db, (tx) => liftTombstone(tx, v1.sourceId, iso()));
    expect(
      saveSourceRecord(db, "c", { externalId: "a", title: "t", body: CANARY("v3") }),
    ).toMatchObject({
      version: 3,
    });
    engine.upsert(v1.sourceId, 3, CANARY("v3")); // applied before the removal got its turn
    await drain(runnerOf(ports(["engine", engine])));
    expect(job(removal.id).status).toBe("succeeded");
    expect(engine.versionsOf(v1.sourceId)).toEqual([3]);
    expect(engine.removeCalls.every((c) => c.coversVersion === 2)).toBe(true);
    expect(engine.holds(CANARY("v1"))).toBe(false);
    expect(engine.holds(CANARY("v2"))).toBe(false);
    expect(engine.holds(CANARY("v3"))).toBe(true);
  });
});

describe("projection.rebuild-race", () => {
  it("covers the removals registered at or before the sequence it read, and no later one; the later ones then run and the deleted sources' canaries are gone", async () => {
    const engine = new FakeProjection(() => db);
    for (const name of ["old", "equal", "x", "z", "keep"]) {
      const saved = stored(name, CANARY(name));
      engine.upsert(saved.sourceId, saved.version, CANARY(name));
    }
    const old = deleted("old");
    db.run("UPDATE jobs SET status = 'dead_letter', reason = 'projection-error' WHERE id = ?", [
      old.id,
    ]);
    stored("filler", "f"); // raises the sequence, so the next deletion's is above the first's
    const equal = deleted("equal");
    // retrying, not yet due: still open when the rebuild runs, and not run before it
    db.run("UPDATE jobs SET status = 'retry', run_after = ? WHERE id = ?", [
      wall + 10 * HOUR,
      equal.id,
    ]);
    const readAt = readChangeSeq(db);
    expect(old.registeredChangeSeq).toBeLessThan(readAt);
    expect(equal.registeredChangeSeq).toBe(readAt);
    // z is deleted right after the sequence is read; x after the rebuild read the sources
    let zRemoval: StoredJob | undefined;
    let xRemoval: StoredJob | undefined;
    engine.afterSeq = () => {
      zRemoval = deleted("z");
    };
    engine.afterRead = () => {
      xRemoval = deleted("x");
    };
    const request = requestProjectionRebuild(db, "engine", { at: new Date(wall) });
    expect(request.registered).toBe(true);
    // the rebuild holds the `projection` group: it runs alone, so jobs registered meanwhile wait
    const runner = runnerOf(ports(["engine", engine]));
    expect(await runner.runOnce()).toMatchObject({ status: "succeeded" });
    expect(engine.rebuildReads).toEqual([readAt]);
    const rebuild = job(request.job.id);
    expect(rebuild.status).toBe("succeeded");
    expect(JSON.parse(rebuild.resultCounts as string)).toEqual({ covered: 2, readSeq: readAt });
    expect(job(old.id)).toMatchObject({ status: "superseded", reason: "covered-by-rebuild" });
    expect(job(equal.id)).toMatchObject({ status: "superseded", reason: "covered-by-rebuild" });
    expect((zRemoval as StoredJob).registeredChangeSeq).toBeGreaterThan(readAt);
    expect(job((zRemoval as StoredJob).id).status).toBe("queued");
    expect(job((xRemoval as StoredJob).id).status).toBe("queued");
    // x was read into the projection by the rebuild: its canary is there until x's removal runs
    expect(engine.holds(CANARY("x"))).toBe(true);
    await drain(runner);
    expect(job((xRemoval as StoredJob).id).status).toBe("succeeded");
    expect(job((zRemoval as StoredJob).id).status).toBe("succeeded");
    for (const name of ["x", "z", "old", "equal"]) expect(engine.holds(CANARY(name))).toBe(false);
    expect(engine.holds(CANARY("keep"))).toBe(true);
  });

  it("a rebuild that fails closes nothing and is retried", async () => {
    const engine = new FakeProjection(() => db);
    engine.rebuild = async () => {
      throw new Error("rebuild down");
    };
    stored("a", "x");
    const removal = deleted("a");
    db.run("UPDATE jobs SET status = 'dead_letter' WHERE id = ?", [removal.id]);
    const request = requestProjectionRebuild(db, "engine", { at: new Date(wall) });
    await drain(runnerOf(ports(["engine", engine])));
    expect(job(request.job.id)).toMatchObject({ status: "retry", reason: "projection-error" });
    expect(job(removal.id).status).toBe("dead_letter");
  });

  it("a rebuild of a permanentlyAbsent projection is a skip (adapter-unavailable) that still covers its removals; the same error from another kind is a retry", async () => {
    const none = new FakeProjection(() => db, true);
    none.rebuild = async () => {
      throw new AdapterUnavailableError("empty");
    };
    stored("a", "x");
    const removal = deleted("a", "vector");
    db.run("UPDATE jobs SET status = 'dead_letter' WHERE id = ?", [removal.id]);
    const skipped = requestProjectionRebuild(db, "vector", { at: new Date(wall) });
    await drain(runnerOf(ports(["vector", none])));
    expect(job(skipped.job.id)).toMatchObject({
      status: "succeeded",
      reason: "adapter-unavailable",
    });
    expect(job(removal.id)).toMatchObject({ status: "superseded", reason: "covered-by-rebuild" });

    const sidecar = new FakeProjection(() => db);
    sidecar.rebuild = async () => {
      throw new AdapterUnavailableError("down");
    };
    const retried = requestProjectionRebuild(db, "engine", { at: new Date(wall) });
    await drain(runnerOf(ports(["engine", sidecar])));
    expect(job(retried.job.id)).toMatchObject({
      status: "retry",
      reason: "projection-unavailable",
    });
  });
});

describe("projection.fallback", () => {
  /** A removal that gave up, then another source's notice that applied: the sequences agree. */
  function givenUpRemovalWithEqualSequences() {
    const engine = new FakeProjection(() => db);
    const x = stored("x", CANARY("x"));
    engine.upsert(x.sourceId, x.version, CANARY("x"));
    const removal = deleted("x");
    db.run(
      "UPDATE jobs SET status = 'dead_letter', reason = 'projection-error', attempts = 5 WHERE id = ?",
      [removal.id],
    );
    const y = stored("y", "y body");
    engine.upsert(y.sourceId, y.version, "y body"); // a later notice succeeded: the engine's applied sequence caught up
    expect(engine.applied).toBe(readChangeSeq(db));
    return { engine, removal };
  }

  it("without a restart: the next check registers the rebuild, it runs, the canary is gone and the given-up removal is covered; until then reads go through visible()", async () => {
    const { engine, removal } = givenUpRemovalWithEqualSequences();
    const sourceId = removal.sourceId as number;
    // the I04 read check as a double: a hit of a deleted source's version is filtered
    const kind: DerivativeKind = {
      kind: "engine-hit",
      layer: "projection",
      references: [],
      storage: "projection",
      dataPaths: [],
      affected: () => [],
      lineage: (_db, ref) => [{ sourceId: Number(ref.id), version: 1 }],
      invalidate: () => ({ removed: 0, recomputed: 0 }),
    };
    const allow: ScopePolicy = {
      compare: () => "equal",
      strictest: (scopes) => scopes[0] ?? null,
      combinable: () => true,
      allows: () => true,
    };
    const registry = createDerivativeRegistry({ kinds: [kind], policy: allow });
    const refs = [{ kind: "engine-hit", id: String(sourceId) }];
    expect(engine.holds(CANARY("x"))).toBe(true); // the projection still holds the deleted content
    expect(registry.visible(db, refs, "search")).toEqual([]); // and no read returns it

    const registered: StoredJob[] = [];
    const scheduler = createScheduler({
      db,
      clock,
      timeZone: () => "UTC",
      onRegistered: (j) => registered.push(j),
    });
    const report = scheduler.check();
    expect(report.rebuilds).toEqual(["engine"]);
    expect(registered.map((j) => j.kind)).toEqual(["projection-rebuild"]);
    await drain(runnerOf(ports(["engine", engine])));
    expect(engine.holds(CANARY("x"))).toBe(false);
    expect(engine.holds("y body")).toBe(true);
    expect(job(removal.id)).toMatchObject({ status: "superseded", reason: "covered-by-rebuild" });
    // nothing marks it any more: the next check registers nothing
    expect(scheduler.check().rebuilds).toEqual([]);
  });

  it("an open removal is a marker at a check only after an hour: 59 minutes registers nothing, over an hour registers the rebuild", async () => {
    const engine = new FakeProjection(() => db);
    stored("x", CANARY("x"));
    const removal = deleted("x");
    db.run("UPDATE jobs SET status = 'retry', run_after = ? WHERE id = ?", [
      wall + 10 * HOUR,
      removal.id,
    ]);
    const scheduler = createScheduler({ db, clock, timeZone: () => "UTC" });
    wall = T0 + 59 * MIN;
    expect(scheduler.check().rebuilds).toEqual([]);
    expect(openRebuilds()).toEqual([]);
    wall = T0 + HOUR + 1;
    expect(scheduler.check().rebuilds).toEqual(["engine"]);
    expect(openRebuilds()).toHaveLength(1);
    expect(engine.rebuildReads).toEqual([]);
  });

  it("a check does not register a second rebuild while one is open, and none for another projection's removals", () => {
    stored("x", "x");
    const removal = deleted("x", "vector");
    db.run("UPDATE jobs SET status = 'dead_letter' WHERE id = ?", [removal.id]);
    const scheduler = createScheduler({ db, clock, timeZone: () => "UTC" });
    expect(scheduler.check().rebuilds).toEqual(["vector"]);
    expect(scheduler.check().rebuilds).toEqual([]);
    expect(openRebuilds("vector")).toHaveLength(1);
    expect(openRebuilds("engine")).toEqual([]);
  });

  // A data directory a stopped backend left, restarted with the sequences equal. A young
  // unfinished removal is a mark at start only (a check waits an hour), so the boot's own
  // start pass is what registers the rebuild there.
  it.each([
    ["a given-up removal", "status = 'dead_letter', attempts = 5"],
    [
      "an unfinished removal registered a minute ago",
      // Not due at boot on the real clock. `created_at + …` in the same UPDATE reads the old
      // created_at (the fake clock's T0), a fixed moment that real time passes.
      `status = 'retry', run_after = ${Date.now() + 10 * HOUR}`,
    ],
  ])(
    "at start: %s makes the boot register the rebuild and run it, the canary gone",
    async (_, set) => {
      const x = stored("x", CANARY("x"));
      const removal = deleted("x");
      db.run(`UPDATE jobs SET ${set}, created_at = ? WHERE id = ?`, [Date.now() - MIN, removal.id]);
      stored("y", "y body");
      for (const d of open.splice(0)) d.close();

      let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;
      const live = new FakeProjection(() => (booted as NonNullable<typeof booted>).db);
      live.items.set(x.sourceId, new Map([[1, CANARY("x")]])); // the projection's own state survived the restart
      live.applied = 99;
      try {
        booted = await bootBackend({
          dataDir: dir,
          token: "t".repeat(43),
          allowedOrigins: [],
          secrets: NO_SECRET_STORE,
          providers: [],
          projectionPorts: ports(["engine", live]),
        });
        const alive = booted;
        await vi.waitFor(() => expect(readJob(alive.db, removal.id)?.status).toBe("superseded"));
        expect(readJob(alive.db, removal.id)).toMatchObject({
          status: "superseded",
          reason: "covered-by-rebuild",
        });
        expect(live.holds(CANARY("x"))).toBe(false);
        expect(live.rebuildReads).toHaveLength(1);
      } finally {
        await booted?.server.close();
        booted?.db.close();
      }
    },
  );
});

describe("projection.request", () => {
  it("asking twice leaves one open rebuild: the second call returns the first", () => {
    const first = requestProjectionRebuild(db, "engine");
    const second = requestProjectionRebuild(db, "engine");
    expect(first.registered).toBe(true);
    expect(second.registered).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(openRebuilds()).toHaveLength(1);
    expect(requestProjectionRebuild(db, "vector").registered).toBe(true); // another projection
    expect(first.job).toMatchObject({ priority: "user", sourceId: null, target: "engine" });
  });

  it("forces the rebuild though the projection's sequence equals the store's, then a later request registers anew", async () => {
    const engine = new FakeProjection(() => db);
    const saved = stored("a", "body a");
    engine.upsert(saved.sourceId, saved.version, "body a");
    expect(engine.applied).toBe(readChangeSeq(db)); // nothing is out of date by the sequence
    const runner = runnerOf(ports(["engine", engine]));
    const first = requestProjectionRebuild(db, "engine", { at: new Date(wall) });
    await drain(runner);
    expect(engine.rebuildReads).toEqual([readChangeSeq(db)]);
    expect(job(first.job.id).status).toBe("succeeded");
    const again = requestProjectionRebuild(db, "engine", { at: new Date(wall) });
    expect(again.registered).toBe(true);
    expect(again.job.id).not.toBe(first.job.id);
  });

  it("refuses an empty projection name", () => {
    expect(() => requestProjectionRebuild(db, "")).toThrow(RangeError);
  });
});
