// I03-T09 (I03-R16 ②′, R18 defaults, R19): the `connector-sync` job kind. The handler
// calls the Connector manager and turns what a sync stopped for into a job result by
// I01's table (`SYNC_OUTCOMES`, read here from the constant); the instance's lock is the
// manager's, so a running sync and an import exclude each other; a held collector is put
// back by a change of its settings, by a start that finds it ready, and by the hourly
// recheck; the default periods are made for the instances that can pull. Time is injected
// and nothing waits; the origin system is the scripted Connector, never a real one.
import { INSTANCE_BUSY_RETRY_MS, SYNC_OUTCOMES, type SyncOutcomeRow } from "@pki/connector-sdk";
import {
  ConnectorError,
  ConnectorNotImplementedError,
  routes,
  type Connector,
  type ConnectorSummary,
} from "@pki/contracts";
import {
  closeJob,
  leaseNextJob,
  readJob,
  registerConnectorInstance,
  registerJob,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { ScriptedConnector, send, dirTemplate } from "@pki/testkit";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJsonlConnector } from "./adapters/jsonl-connector.ts";
import { bootBackend } from "./boot.ts";
import type { Clock } from "./clock.ts";
import { openCanonicalDb, type ConnectorSet } from "./composition.ts";
import {
  createConnectorManager,
  tryLockInstance,
  type ConnectorManager,
  type SyncedResponse,
} from "./connectors.ts";
import {
  CLEANUP_PERIOD,
  CONNECTOR_SYNC_KIND,
  CONNECTOR_SYNC_SETTINGS,
  createConnectorSyncHandler,
  ensureDefaultSchedules,
  recheckInstances,
  releaseHeldCollector,
  releaseReadyCollectors,
  startCollectorUpkeep,
  SYNC_PERIOD,
} from "./connector-sync-job.ts";
import { HELD_REASONS } from "./held-release.ts";
import { createJobRunner } from "./job-runner.ts";
import { JSONL_IMPORT_KIND } from "@pki/connector-sdk";
import { NO_SECRET_STORE } from "./secret-sources.ts";
import { createScheduler, MAINTENANCE_KIND } from "./scheduler.ts";

const seedDataDir = dirTemplate((path) => openCanonicalDb(path).close());

/** One line of the synthetic mail fixture: a valid JSONL record to import. */
const MAIL_LINE = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../fixtures/v02-mail.jsonl"), "utf8").split(
    "\n",
  )[0] as string,
) as Record<string, unknown>;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const T0 = Date.parse("2026-11-22T00:00:00.000Z");

let dir: string;
let db: SqlDriver;
let wall = T0;
const clock: Clock = {
  now: () => wall,
  monotonic: () => 0,
  sleep: () => Promise.reject(new Error("nothing here waits")),
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-sync-job-"));
  seedDataDir(join(dir, "data"));
  db = openCanonicalDb(join(dir, "data"));
  wall = T0;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const ZERO = {
  received: 0,
  created: 0,
  unchanged: 0,
  scopeUpdated: 0,
  stale: 0,
  staleTombstone: 0,
  blocked: 0,
  tombstoned: 0,
  rejected: [],
  rejectedCount: 0,
  rescanned: false,
  deletionsMayBeMissed: false,
};

/** A manager double: one instance, answering with what the test says. */
function fakeManager(
  answer: () => SyncedResponse | { error: "not-found" | "connector-unavailable" },
  summary: Partial<ConnectorSummary> = {},
): Pick<ConnectorManager, "sync" | "list"> & { calls: number } {
  const manager = {
    calls: 0,
    list: (): ConnectorSummary[] => [{ id: "c1", kind: "scripted", state: "ready", ...summary }],
    sync: async () => {
      manager.calls++;
      return answer();
    },
  };
  return manager;
}

function runnerOf(manager: Pick<ConnectorManager, "sync" | "list">) {
  return createJobRunner({
    db,
    clock,
    kinds: { [CONNECTOR_SYNC_KIND]: CONNECTOR_SYNC_SETTINGS },
    handlers: { [CONNECTOR_SYNC_KIND]: createConnectorSyncHandler({ db, manager: () => manager }) },
  });
}

function register(target = "c1"): StoredJob {
  const r = registerJob(db, { kind: CONNECTOR_SYNC_KIND, target, at: new Date(wall) });
  if (!r.registered) throw new Error("expected a new job");
  return r.job;
}
const job = (id: number) => readJob(db, id) as StoredJob;

describe("connector-sync.stop-codes (I03-R19, I01-R20): each end of a sync, by I01's table", () => {
  /** What a sync that ends this way answers, and the instance it answers about. */
  const endings: Record<
    string,
    { answer: () => SyncedResponse | { error: "connector-unavailable" }; summary?: object }
  > = {
    completed: { answer: () => ({ connectorId: "c1", ...ZERO, received: 3, created: 2 }) },
    // the run-time cap's yield (I02B-R21): the sync stored a page and left at its boundary
    yield: {
      answer: () => ({ connectorId: "c1", ...ZERO, received: 1, created: 1, yielded: true }),
    },
    "rate-limited": {
      answer: () => ({
        connectorId: "c1",
        ...ZERO,
        stopped: "rate-limited",
        retryAfterMs: 20 * MINUTE,
      }),
    },
    unavailable: {
      answer: () => ({ error: "connector-unavailable" }),
      summary: { state: "unavailable" },
    },
    "not-implemented": {
      answer: () => ({ error: "connector-unavailable" }),
      summary: { state: "not-implemented" },
    },
  };
  const ending = (end: string) =>
    endings[end] ?? {
      answer: (): SyncedResponse => ({ connectorId: "c1", ...ZERO, stopped: end as never }),
    };

  it("has a case for every row of I01's constant, and the constant has every row of the spec table", () => {
    const covered = SYNC_OUTCOMES.map((row) => row.end);
    expect(new Set(covered).size).toBe(covered.length);
    expect(covered).toHaveLength(14);
  });

  for (const row of SYNC_OUTCOMES) {
    it(`${row.end}: ${row.result}, attempt ${row.attempt}, next run ${row.nextRun}`, async () => {
      const { answer, summary } = ending(row.end);
      const manager = fakeManager(answer, summary);
      const runner = runnerOf(manager);
      const queued = register();
      await runner.runOnce();
      const after = job(queued.id);
      expectRow(row, after);
    });
  }

  function expectRow(row: SyncOutcomeRow, after: StoredJob) {
    switch (row.result) {
      case "done":
        expect(after).toMatchObject({ status: "succeeded", reason: null, attempts: 1 });
        break;
      case "dead_letter":
        expect(after).toMatchObject({ status: "dead_letter", reason: row.end });
        break;
      case "yield":
        // a yield that stored a page: queued a minute later, its attempt given back (I03-R14)
        expect(after).toMatchObject({
          status: "queued",
          attempts: 0,
          runAfter: T0 + INSTANCE_BUSY_RETRY_MS,
        });
        break;
      case "held":
        // the reason is the instance's own: never the Connector's text
        expect(after).toMatchObject({ status: "held", attempts: 0 });
        expect(Object.keys(HELD_REASONS)).toContain(after.reason);
        break;
      case "retry": {
        const wait =
          row.nextRun === "one-minute"
            ? INSTANCE_BUSY_RETRY_MS
            : row.nextRun === "backoff-or-retry-after"
              ? 20 * MINUTE
              : 30 * SECOND;
        expect(after).toMatchObject({
          status: "retry",
          reason: row.end,
          runAfter: T0 + wait,
          attempts: row.attempt === "unspent" ? 0 : 1,
        });
        break;
      }
    }
  }

  it("storage-failed spends an attempt each run and is given up at the fifth", async () => {
    const manager = fakeManager(() => ({ connectorId: "c1", ...ZERO, stopped: "storage-failed" }));
    const runner = runnerOf(manager);
    const queued = register();
    for (let run = 1; run <= 5; run++) {
      const ran = await runner.runOnce();
      expect(ran?.jobId).toBe(queued.id);
      expect(job(queued.id)).toMatchObject({ status: "retry", attempts: run });
      wall = job(queued.id).runAfter;
    }
    // the fifth failure is a retry that the next claim gives up: no attempt is left
    leaseNextJob(db, { kinds: [CONNECTOR_SYNC_KIND], now: new Date(wall), leaseMs: HOUR });
    expect(job(queued.id)).toMatchObject({
      status: "dead_letter",
      reason: "storage-failed",
      attempts: 5,
    });
    expect(manager.calls).toBe(5);
  });

  it("instance-busy runs the Connector no more and gives the attempt back, run after run", async () => {
    const manager = fakeManager(() => ({ connectorId: "c1", ...ZERO, stopped: "instance-busy" }));
    const runner = runnerOf(manager);
    const queued = register();
    for (let run = 1; run <= 8; run++) {
      await runner.runOnce();
      expect(job(queued.id)).toMatchObject({ status: "retry", attempts: 0 });
      wall += INSTANCE_BUSY_RETRY_MS;
    }
    // eight runs, none given up: a held import never exhausts the job
    expect(job(queued.id).status).toBe("retry");
  });

  it("stores the counts of a sync that completed and of one that stopped after storing pages", async () => {
    const done = register("c1");
    const runner = runnerOf(
      fakeManager(() => ({
        connectorId: "c1",
        ...ZERO,
        received: 7,
        created: 4,
        unchanged: 1,
        scopeUpdated: 1,
        tombstoned: 1,
        rejected: [{ at: "change:0", code: "schema" }],
        rejectedCount: 1,
        rescanned: true,
      })),
    );
    await runner.runOnce();
    expect(JSON.parse(job(done.id).resultCounts as string)).toEqual({
      blocked: 0,
      created: 4,
      deletionsMayBeMissed: 0,
      received: 7,
      rejected: 1,
      rescanned: 1,
      scopeUpdated: 1,
      stale: 0,
      staleTombstone: 0,
      tombstoned: 1,
      unchanged: 1,
    });
    const stopped = register("c2");
    const stoppedRunner = runnerOf(
      fakeManager(() => ({
        connectorId: "c2",
        ...ZERO,
        received: 2,
        created: 2,
        stopped: "connector-error",
      })),
    );
    await stoppedRunner.runOnce();
    expect(job(stopped.id)).toMatchObject({ status: "retry", reason: "connector-error" });
    expect(JSON.parse(job(stopped.id).resultCounts as string)).toMatchObject({
      received: 2,
      created: 2,
    });
  });

  it("holds a counts-free record for a sync that never reached the Connector (instance-busy)", async () => {
    const queued = register();
    await runnerOf(
      fakeManager(() => ({ connectorId: "c1", ...ZERO, stopped: "instance-busy" })),
    ).runOnce();
    expect(job(queued.id).resultCounts).toBeNull();
  });

  it("gives up a job whose instance is no longer configured, and never calls anything", async () => {
    const manager = fakeManager(() => ({ error: "not-found" }));
    const queued = register();
    await runnerOf(manager).runOnce();
    expect(job(queued.id)).toMatchObject({ status: "dead_letter", reason: "instance-not-found" });
  });

  it("names the held reason by the instance's own state, never by text", async () => {
    const reasons: [Partial<ConnectorSummary>, string][] = [
      [{ state: "unavailable", reason: "unsupported-sdk-version" }, "unsupported-sdk-version"],
      [{ state: "unavailable", reason: "instance-kind-mismatch" }, "instance-kind-mismatch"],
      [{ state: "unavailable" }, "connector-unavailable"],
      [{ state: "not-implemented" }, "not-implemented"],
    ];
    for (const [summary, expected] of reasons) {
      const target = `i-${expected}`;
      const queued = register(target);
      await runnerOf(
        fakeManager(() => ({ error: "connector-unavailable" }), { ...summary, id: target }),
      ).runOnce();
      expect(job(queued.id)).toMatchObject({ status: "held", reason: expected, attempts: 0 });
      expect(HELD_REASONS).toHaveProperty([expected]);
    }
  });

  it("throws nothing out of a sync that stopped: only a bug in the manager is a handler-error retry", async () => {
    const queued = register();
    const manager = fakeManager(() => {
      throw new Error("CANARY-bug");
    });
    await runnerOf(manager).runOnce();
    expect(job(queued.id)).toMatchObject({ status: "retry", reason: "handler-error" });
  });
});

/** A Connector that waits on the test before it answers a page, to hold a sync open. */
function gatedConnector(): { connector: Connector; entered: Promise<void>; open: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const connector = new ScriptedConnector();
  const initialize = connector.initialize.bind(connector);
  connector.initialize = (config) =>
    initialize({
      ...(config as object),
      beforeAnswer: async () => {
        enter();
        await gate;
      },
    });
  return { connector, entered, open: release };
}

describe("connector-sync.exclusive (I03-R19, I01-R21): one sync or import per instance", () => {
  const ENTRIES = [{ kind: "upsert", record: record("one") }] as never;
  function record(id: string) {
    return {
      namespace: "",
      externalId: id,
      revision: 1,
      schemaVersion: 2,
      title: id,
      body: `body ${id}`,
    };
  }
  const post = (
    booted: Awaited<ReturnType<typeof bootBackend>>,
    id: string,
  ): ReturnType<typeof send> =>
    send(
      booted.server.port,
      routes.importJsonl.path,
      { host: `127.0.0.1:${booted.server.port}`, authorization: `Bearer ${"t".repeat(43)}` },
      "POST",
      { text: `${JSON.stringify({ ...MAIL_LINE, connector_instance_id: id })}\n` },
    );

  /** POST /api/imports: one JSONL line for the named product instance (I01-R24). */
  const postImports = (
    booted: Awaited<ReturnType<typeof bootBackend>>,
    instanceId: string,
  ): ReturnType<typeof send> =>
    send(
      booted.server.port,
      routes.imports.path,
      { host: `127.0.0.1:${booted.server.port}`, authorization: `Bearer ${"t".repeat(43)}` },
      "POST",
      { instanceId, content: `${JSON.stringify(MAIL_LINE)}\n` },
    );

  /** A started backend whose instance A syncs (as `jsonl-import` kind) through a Connector the test gates. */
  async function boot(gated: ReturnType<typeof gatedConnector>) {
    const connectors: ConnectorSet = {
      instances: [{ id: "A", kind: JSONL_IMPORT_KIND, config: { entries: ENTRIES } }],
      kinds: { [JSONL_IMPORT_KIND]: () => gated.connector },
    };
    return bootBackend({
      dataDir: join(dir, "boot"),
      token: "t".repeat(43),
      allowedOrigins: [],
      secrets: NO_SECRET_STORE,
      connectors,
    });
  }
  let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;
  afterEach(async () => {
    await booted?.server.close();
    booted?.db.close();
    booted = undefined;
  });

  it("answers an import into instance A with 409 instance-busy while A's sync job runs, and an import into B with 200", async () => {
    const gated = gatedConnector();
    booted = await boot(gated);
    const queued = registerJob(booted.db, { kind: CONNECTOR_SYNC_KIND, target: "A" });
    if (!queued.registered) throw new Error("expected a new job");
    void booted.runner.wake();
    await gated.entered; // the sync job holds A's lock, inside the Connector
    expect(readJob(booted.db, queued.job.id)?.status).toBe("running");

    const busy = await post(booted, "A");
    expect(busy.status).toBe(409);
    expect(busy.body).toEqual({ error: "instance-busy" });
    expect((await post(booted, "B")).status).toBe(200);

    gated.open();
    for (let i = 0; i < 100 && readJob(booted.db, queued.job.id)?.status !== "succeeded"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(readJob(booted.db, queued.job.id)).toMatchObject({ status: "succeeded", attempts: 1 });
    // the lock is free again: the same import now goes through (A's kind is the JSONL one)
    expect((await post(booted, "A")).status).toBe(200);
  });

  it("answers POST /api/imports into A with 409 instance-busy while A's sync job runs, stores nothing of it, and into B with 200", async () => {
    const gated = gatedConnector();
    booted = await boot(gated);
    const queued = registerJob(booted.db, { kind: CONNECTOR_SYNC_KIND, target: "A" });
    if (!queued.registered) throw new Error("expected a new job");
    void booted.runner.wake();
    await gated.entered;
    const before = booted.db.all("SELECT count(*) AS n FROM sources")[0]?.n;
    const busy = await postImports(booted, "A");
    expect(busy.status).toBe(409);
    expect(busy.body).toEqual({ error: "instance-busy" });
    expect(booted.db.all("SELECT count(*) AS n FROM sources")[0]?.n).toBe(before);
    expect((await postImports(booted, "B")).status).toBe(200);
    gated.open();
    for (let i = 0; i < 100 && readJob(booted.db, queued.job.id)?.status !== "succeeded"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect((await postImports(booted, "A")).status).toBe(200);
  });

  it("refuses the id of a configured collector of another kind for imports, ready or not (I01-T05 A3)", async () => {
    const gated = gatedConnector();
    gated.open();
    const connectors: ConnectorSet = {
      instances: [{ id: "site-x", kind: "site-kind", config: {} }],
      kinds: { "site-kind": () => gated.connector },
    };
    booted = await bootBackend({
      dataDir: join(dir, "boot"),
      token: "t".repeat(43),
      allowedOrigins: [],
      secrets: NO_SECRET_STORE,
      connectors,
    });
    const refused = await postImports(booted, "site-x");
    expect(refused.status).toBe(400);
    expect(booted.db.all("SELECT id FROM connector_instances WHERE id = 'site-x'")).toEqual([]);
  });

  it("refuses the id of a configured collector of another kind on the V02 route too: instance-conflict per line (I01-T05)", async () => {
    const gated = gatedConnector();
    gated.open();
    booted = await bootBackend({
      dataDir: join(dir, "boot"),
      token: "t".repeat(43),
      allowedOrigins: [],
      secrets: NO_SECRET_STORE,
      connectors: {
        instances: [{ id: "site-x", kind: "site-kind", config: {} }],
        kinds: { "site-kind": () => gated.connector },
      },
    });
    const res = await post(booted, "site-x");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ errors: [{ line: 1, reason: "instance-conflict" }] });
    expect(booted.db.all("SELECT id FROM connector_instances WHERE id = 'site-x'")).toEqual([]);
  });

  it("makes an import's lock hold a collected sync: the job gives the attempt back and runs again a minute later", async () => {
    const gated = gatedConnector();
    gated.open(); // never gates: this case holds the instance from the other side
    booted = await boot(gated);
    const release = tryLockInstance(booted.db, "A") as () => void; // the import in progress
    const queued = registerJob(booted.db, { kind: CONNECTOR_SYNC_KIND, target: "A" });
    if (!queued.registered) throw new Error("expected a new job");
    const before = Date.now();
    void booted.runner.wake();
    for (let i = 0; i < 100 && readJob(booted.db, queued.job.id)?.status !== "retry"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const held = readJob(booted.db, queued.job.id) as StoredJob;
    expect(held).toMatchObject({ status: "retry", reason: "instance-busy", attempts: 0 });
    expect(held.runAfter).toBeGreaterThanOrEqual(before + INSTANCE_BUSY_RETRY_MS);
    expect(held.runAfter).toBeLessThan(before + INSTANCE_BUSY_RETRY_MS + 30 * SECOND);
    release();
  });

  it("B-F2: an instance bound to another kind is refused line by line even when its lock is held, and never makes the request a 409", async () => {
    const gated = gatedConnector();
    gated.open();
    booted = await boot(gated);
    registerConnectorInstance(booted.db, "K", "other-kind");
    const release = tryLockInstance(booted.db, "K") as () => void;
    const conflict = await post(booted, "K");
    expect(conflict.status).toBe(200);
    expect(conflict.body).toMatchObject({ errors: [{ reason: "instance-conflict" }] });
    release();
  });

  it("does not hold instance B while A's sync runs", async () => {
    const a = gatedConnector();
    const manager = await createConnectorManager(
      db,
      [
        { id: "A", kind: "gated", config: { entries: ENTRIES } },
        { id: "B", kind: "plain", config: { entries: ENTRIES } },
      ],
      { gated: () => a.connector, plain: () => new ScriptedConnector() },
    );
    const syncingA = manager.sync("A");
    await a.entered;
    expect(await manager.sync("B")).toMatchObject({ created: 1 });
    expect(await manager.sync("A")).toMatchObject({ stopped: "instance-busy" });
    a.open();
    expect(await syncingA).toMatchObject({ created: 1 });
  });
});

describe("connector-sync.held (I03-R16 ②′, R20): a collector that cannot run is held, and put back when it can", () => {
  /** A Connector that fails to initialize until `ready` is set. */
  function lateConnector() {
    const state = { ready: false };
    const inner = new ScriptedConnector();
    const connector: Connector = {
      manifest: inner.manifest,
      initialize: async (config: unknown) => {
        if (!state.ready) throw new ConnectorNotImplementedError();
        await inner.initialize(config);
      },
      healthCheck: () => inner.healthCheck(),
      getChanges: inner.getChanges.bind(inner),
      getDocument: inner.getDocument.bind(inner),
    };
    return { state, connector };
  }

  async function lateManager() {
    const late = lateConnector();
    const manager = await createConnectorManager(
      db,
      [{ id: "site-x", kind: "late", config: { entries: [] } }],
      { late: () => late.connector },
    );
    return { ...late, manager };
  }

  it("holds the job by the instance's reason, attempt unspent, and shows the period as paused (held) with the slots as merged while held", async () => {
    const { manager } = await lateManager();
    const scheduler = createScheduler({ db, clock, timeZone: () => "UTC" });
    const { schedule } = scheduler.ensureSchedule({
      kind: CONNECTOR_SYNC_KIND,
      target: "site-x",
      period: SYNC_PERIOD,
    });
    const runner = runnerOf(manager);
    wall = T0 + HOUR;
    const first = scheduler.check().due[0];
    expect(first?.outcome).toBe("registered");
    await runner.runOnce();
    const held = job(first?.jobId as number);
    expect(held).toMatchObject({ status: "held", reason: "not-implemented", attempts: 0 });
    expect(scheduler.get(schedule.id)?.pause).toEqual({ kind: "held", reason: "not-implemented" });

    wall = T0 + 4 * HOUR; // three more slots pass while it is held
    expect(scheduler.check().due[0]?.outcome).toBe("coalesced");
    expect(scheduler.get(schedule.id)?.counts.heldCoalesced).toBe(1);
    expect(job(held.id).status).toBe("held");
  });

  it("is put back by the transaction that changes the instance's settings, and by that one only when it commits", async () => {
    const { manager } = await lateManager();
    const queued = register("site-x");
    await runnerOf(manager).runOnce();
    const other = register("site-y");
    db.run("UPDATE jobs SET status = 'held', reason = 'not-implemented' WHERE id = ?", [other.id]);
    expect(job(queued.id).status).toBe("held");

    expect(() =>
      db.transaction(() => {
        expect(releaseHeldCollector(db, "site-x", new Date(wall))).toBe(1);
        throw new Error("the settings write failed");
      }),
    ).toThrow("the settings write failed");
    expect(job(queued.id)).toMatchObject({ status: "held", reason: "not-implemented" });

    db.transaction(() => releaseHeldCollector(db, "site-x", new Date(wall)));
    expect(job(queued.id)).toMatchObject({ status: "queued", reason: null, attempts: 0 });
    expect(job(other.id).status).toBe("held"); // another instance's job is not touched
  });

  it("is put back at a start that finds the instance ready, and stays held where it is not", async () => {
    const late = await lateManager();
    const queued = register("site-x");
    await runnerOf(late.manager).runOnce();
    expect(job(queued.id).status).toBe("held");

    expect(releaseReadyCollectors(db, late.manager.list(), new Date(wall))).toEqual([]);
    expect(job(queued.id).status).toBe("held");

    // the next start: the app is another version and the instance now initializes
    const next = await createConnectorManager(
      db,
      [{ id: "site-x", kind: "scripted", config: { entries: [] } }],
      { scripted: () => new ScriptedConnector() },
    );
    expect(releaseReadyCollectors(db, next.list(), new Date(wall))).toEqual(["site-x"]);
    expect(job(queued.id)).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("is put back by the hourly recheck once the instance's health is ok, and not before", async () => {
    const late = await lateManager();
    const queued = register("site-x");
    await runnerOf(late.manager).runOnce();
    const woken: number[] = [];
    const made: string[] = [];
    const recheck = () =>
      recheckInstances({
        db,
        manager: late.manager,
        runner: { wake: async () => void woken.push(1) },
        onUsable: (summary) => void made.push(summary.id),
        at: () => new Date(wall),
      });

    expect(await recheck()).toEqual([]);
    expect(job(queued.id).status).toBe("held");
    late.state.ready = true;
    expect(await recheck()).toEqual(["site-x"]);
    expect(job(queued.id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(woken).toEqual([1]);
    expect(made).toEqual(["site-x"]); // a new usable instance gets its default period
    expect(late.manager.list()[0]).toMatchObject({ state: "ready" });
    expect(await recheck()).toEqual([]); // a ready instance is not rechecked
  });

  it("an instance whose health is not ok after it initialized is not ready", async () => {
    const connector = new ScriptedConnector();
    const sick: Connector = {
      manifest: connector.manifest,
      initialize: async () => {
        throw new ConnectorError("later", { retryable: true });
      },
      healthCheck: async () => ({ state: "unavailable" as const, reason: "down" }),
      getChanges: connector.getChanges.bind(connector),
      getDocument: connector.getDocument.bind(connector),
    };
    const manager = await createConnectorManager(db, [{ id: "s", kind: "sick", config: {} }], {
      sick: () => sick,
    });
    expect(await manager.recheck("s")).toBe("unavailable");
    expect(await manager.recheck("nobody")).toBeUndefined();
  });

  it("ignores a held job of another kind or reason", async () => {
    await lateManager();
    const extract = registerJob(db, { kind: "maintenance", target: "site-x" });
    if (!extract.registered) throw new Error("expected a new job");
    db.run("UPDATE jobs SET status = 'held', reason = 'not-implemented' WHERE id = ?", [
      extract.job.id,
    ]);
    expect(releaseHeldCollector(db, "site-x")).toBe(0);
  });
});

describe("schedule.defaults through the boot path (I01-T05 N2)", () => {
  it("a jsonl-import instance with a { path } config gets the hourly sync schedule, one with parsed lines none", async () => {
    const file = join(dir, "pull.jsonl");
    writeFileSync(file, "");
    const connectors: ConnectorSet = {
      instances: [
        { id: "file-inst", kind: JSONL_IMPORT_KIND, config: { path: file } },
        { id: "lines-inst", kind: JSONL_IMPORT_KIND, config: { records: [] } },
      ],
      kinds: { [JSONL_IMPORT_KIND]: createJsonlConnector },
    };
    const booted = await bootBackend({
      dataDir: join(dir, "boot-sched"),
      token: "t".repeat(43),
      allowedOrigins: [],
      secrets: NO_SECRET_STORE,
      connectors,
    });
    try {
      expect(
        booted.db.all("SELECT kind, target, period FROM schedules WHERE kind = 'connector-sync'"),
      ).toEqual([{ kind: "connector-sync", target: "file-inst", period: expect.any(String) }]);
    } finally {
      await booted.server.close();
      booted.db.close();
    }
  });
});

describe("schedule.defaults (I03-R18): the default periods", () => {
  const summaries: ConnectorSummary[] = [
    { id: "ok", kind: "scripted", state: "ready" },
    { id: "also-ok", kind: "other", state: "ready" },
    { id: "site-mail", kind: "site-mail", state: "not-implemented" },
    { id: "broken", kind: "scripted", state: "unavailable" },
    { id: "old-sdk", kind: "scripted", state: "unavailable", reason: "unsupported-sdk-version" },
    { id: "api-only", kind: JSONL_IMPORT_KIND, state: "ready" },
    { id: "file-inst", kind: JSONL_IMPORT_KIND, state: "ready" },
  ];
  /** Only the file instance has a pull configuration (I01-R23); `api-only` has none. */
  const configOf = (id: string) => (id === "file-inst" ? { path: "/synthetic/file.jsonl" } : {});

  it("makes an hourly sync for each usable instance and a daily 03:00 cleanup, and none for the others", () => {
    const scheduler = createScheduler({ db, clock, timeZone: () => "UTC" });
    const created = ensureDefaultSchedules(scheduler, summaries, configOf);
    expect(created.sort()).toEqual([
      `${CONNECTOR_SYNC_KIND}:also-ok`,
      `${CONNECTOR_SYNC_KIND}:file-inst`,
      `${CONNECTOR_SYNC_KIND}:ok`,
      MAINTENANCE_KIND,
    ]);
    const stored = scheduler
      .list()
      .map((s) => [s.kind, s.target, s.period, s.enabled])
      .sort();
    expect(stored).toEqual(
      [
        [CONNECTOR_SYNC_KIND, "also-ok", { kind: "hourly" }, true],
        [CONNECTOR_SYNC_KIND, "file-inst", { kind: "hourly" }, true],
        [CONNECTOR_SYNC_KIND, "ok", { kind: "hourly" }, true],
        [MAINTENANCE_KIND, "", { kind: "daily", at: { hour: 3, minute: 0 } }, true],
      ].sort(),
    );
    expect(SYNC_PERIOD).toEqual({ kind: "hourly" });
    expect(CLEANUP_PERIOD).toEqual({ kind: "daily", at: { hour: 3, minute: 0 } });
  });

  it("leaves a period the user changed or turned off as it is", () => {
    const scheduler = createScheduler({ db, clock, timeZone: () => "UTC" });
    ensureDefaultSchedules(scheduler, summaries, configOf);
    const mine = scheduler.list().find((s) => s.target === "ok");
    const other = scheduler.list().find((s) => s.target === "also-ok");
    scheduler.change(mine?.id as number, { kind: "every-10-minutes" });
    scheduler.disable(other?.id as number);
    expect(ensureDefaultSchedules(scheduler, summaries, configOf)).toEqual([]);
    expect(scheduler.get(mine?.id as number)?.period).toEqual({ kind: "every-10-minutes" });
    expect(scheduler.get(other?.id as number)?.enabled).toBe(false);
  });

  it("makes the cleanup even when no instance can pull", () => {
    const scheduler = createScheduler({ db, clock, timeZone: () => "UTC" });
    expect(ensureDefaultSchedules(scheduler, [])).toEqual([MAINTENANCE_KIND]);
  });
});

describe("the product's composition (bootBackend)", () => {
  let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;
  afterEach(async () => {
    await booted?.server.close();
    booted?.db.close();
    booted = undefined;
  });

  it("makes the default periods at start and runs a collected sync through the registered handler into the knowledge store", async () => {
    const connectors: ConnectorSet = {
      instances: [
        { id: "pull", kind: "scripted", config: { entries: [{ kind: "upsert", record: rec() }] } },
        { id: "site-mail", kind: "site-mail", config: {} },
      ],
      kinds: {
        scripted: () => new ScriptedConnector(),
        "site-mail": () => new ScriptedConnector(), // initialize needs {entries}: not ready
      },
    };
    booted = await bootBackend({
      dataDir: join(dir, "boot"),
      token: "t".repeat(43),
      allowedOrigins: [],
      secrets: NO_SECRET_STORE,
      connectors,
    });
    const schedules = booted.scheduler.list();
    expect(schedules.map((s) => `${s.kind}:${s.target}`).sort()).toEqual([
      `${CONNECTOR_SYNC_KIND}:pull`,
      `${MAINTENANCE_KIND}:`,
      "notify:daily", // P02-R3: the notification job's three periods
      "notify:scan",
      "notify:weekly",
      "reflect:daily", // K02-R2: the re-review's two periods
      "reflect:weekly",
    ]);
    const sync = schedules.find((s) => s.kind === CONNECTOR_SYNC_KIND);
    const ran = booted.scheduler.runNow(sync?.id as number);
    void booted.runner.wake();
    for (let i = 0; i < 100 && readJob(booted.db, ran.job.id)?.status !== "succeeded"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(readJob(booted.db, ran.job.id)).toMatchObject({ status: "succeeded", priority: "user" });
    expect(JSON.parse(readJob(booted.db, ran.job.id)?.resultCounts as string)).toMatchObject({
      created: 1,
    });
    expect(booted.db.all("SELECT count(*) AS n FROM sources")[0]?.n).toBe(1);
  });

  it("runs the cleanup period's job through the registered handler: an old ended row goes", async () => {
    booted = await bootBackend({
      dataDir: join(dir, "boot"),
      token: "t".repeat(43),
      allowedOrigins: [],
      secrets: NO_SECRET_STORE,
      connectors: { instances: [], kinds: {} },
    });
    const old = registerJob(booted.db, { kind: "extract-like", target: "old" });
    if (!old.registered) throw new Error("expected a new job");
    booted.db.run("UPDATE jobs SET status = 'succeeded', finished_at = ? WHERE id = ?", [
      Date.now() - 40 * 24 * HOUR,
      old.job.id,
    ]);
    const cleanup = booted.scheduler.list().find((s) => s.kind === MAINTENANCE_KIND);
    const ran = booted.scheduler.runNow(cleanup?.id as number);
    void booted.runner.wake();
    for (let i = 0; i < 100 && readJob(booted.db, ran.job.id)?.status !== "succeeded"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(readJob(booted.db, ran.job.id)?.status).toBe("succeeded");
    expect(readJob(booted.db, old.job.id)).toBeUndefined();
  });

  it("B-F3: closing the backend stops the hourly recheck (removing stop() from close goes red)", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      let initializations = 0;
      const sleeper = (): Connector => ({
        ...new ScriptedConnector(),
        manifest: new ScriptedConnector().manifest,
        initialize: async () => {
          initializations++;
          throw new ConnectorNotImplementedError();
        },
        healthCheck: async () => ({ state: "unavailable", reason: "x" }),
        getChanges: async () => ({ changes: [], nextCursor: "0", hasMore: false }),
        getDocument: async () => null,
      });
      booted = await bootBackend({
        dataDir: join(dir, "boot"),
        token: "t".repeat(43),
        allowedOrigins: [],
        secrets: NO_SECRET_STORE,
        connectors: {
          instances: [{ id: "later", kind: "sleeper", config: {} }],
          kinds: { sleeper },
        },
      });
      await new Promise((r) => setTimeout(r, 50)); // the pass at start has run
      await booted.server.close();
      const db = booted.db; // still open: a pass that is not stopped would reach the Connector
      booted = undefined;
      const before = initializations;
      vi.advanceTimersByTime(3 * 60 * 60_000);
      await new Promise((r) => setTimeout(r, 50));
      db.close();
      expect(initializations).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  function rec() {
    return {
      namespace: "",
      externalId: "doc-1",
      revision: 1,
      schemaVersion: 2,
      title: "a",
      body: "b",
    };
  }
});

describe("review rework 1 (I03-T09 reviewer A)", () => {
  it("F1: a fractional retryAfterMs from the origin closes as a retry on a whole millisecond, never leaves the job running", async () => {
    const queued = register();
    await runnerOf(
      fakeManager(() => ({
        connectorId: "c1",
        ...ZERO,
        stopped: "rate-limited",
        retryAfterMs: 600_000.5,
      })),
    ).runOnce();
    const after = job(queued.id);
    expect(after).toMatchObject({ status: "retry", reason: "rate-limited" });
    expect(after.runAfter).toBe(T0 + 600_001);
  });

  it("F6: every retry row whose attempt is not spent waits one minute by the table, so the handler's one fixed delay cannot drift", () => {
    const unspent = SYNC_OUTCOMES.filter((r) => r.result === "retry" && r.attempt === "unspent");
    expect(unspent.length).toBeGreaterThan(0);
    for (const row of unspent) expect(row.nextRun).toBe("one-minute");
  });

  async function late() {
    const state = { ready: false };
    const inner = new ScriptedConnector();
    const connector: Connector = {
      manifest: inner.manifest,
      initialize: async (config: unknown) => {
        if (!state.ready) throw new ConnectorNotImplementedError();
        await inner.initialize(config);
      },
      healthCheck: () => inner.healthCheck(),
      getChanges: inner.getChanges.bind(inner),
      getDocument: inner.getDocument.bind(inner),
    };
    const manager = await createConnectorManager(
      db,
      [{ id: "site-x", kind: "late", config: { entries: [] } }],
      { late: () => connector },
    );
    return { state, manager };
  }

  it("F2: an instance that becomes ready while its sync job is closing as held is released by the next pass", async () => {
    const { state, manager } = await late();
    const racing: Pick<ConnectorManager, "sync" | "list"> = {
      list: () => manager.list(),
      sync: async () => {
        // the recheck runs inside the job: the job is `running`, so it releases nothing
        state.ready = true;
        await manager.recheck("site-x");
        return { error: "connector-unavailable" };
      },
    };
    const queued = register("site-x");
    await runnerOf(racing).runOnce();
    expect(job(queued.id)).toMatchObject({ status: "held", attempts: 0 });
    expect(manager.list()[0]?.state).toBe("ready");

    const woken: number[] = [];
    await recheckInstances({
      db,
      manager,
      runner: { wake: async () => void woken.push(1) },
      at: () => new Date(wall),
    });
    expect(job(queued.id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(woken).toEqual([1]);
  });

  it("F3: a run that lost its lease and then stops after storing pages writes no counts", async () => {
    const queued = register();
    const stale = leaseNextJob(db, {
      kinds: [CONNECTOR_SYNC_KIND],
      now: new Date(wall),
      leaseMs: HOUR,
      owner: "old",
    }) as StoredJob;
    // the lease is lost: the job is closed and claimed again under a new token
    closeJob(db, stale, { status: "retry", reason: "run-timeout", runAfter: wall }, new Date(wall));
    const fresh = leaseNextJob(db, {
      kinds: [CONNECTOR_SYNC_KIND],
      now: new Date(wall),
      leaseMs: HOUR,
      owner: "new",
    }) as StoredJob;
    expect(fresh.leaseToken).not.toBe(stale.leaseToken);
    const manager = fakeManager(() => ({
      connectorId: "c1",
      ...ZERO,
      received: 5,
      created: 5,
      stopped: "connector-error",
    }));
    const handler = createConnectorSyncHandler({ db, manager: () => manager });
    await handler(stale, { signal: new AbortController().signal } as never);
    expect(job(queued.id).resultCounts).toBeNull();
    await handler(fresh, { signal: new AbortController().signal } as never);
    expect(JSON.parse(job(queued.id).resultCounts as string)).toMatchObject({ created: 5 });
  });

  it("F4: a recheck that never answers is cut at the timeout, the others are still checked, and it is not started again while pending", async () => {
    const hung = { calls: 0 };
    const manager = {
      list: (): ConnectorSummary[] => [
        { id: "hung", kind: "k", state: "unavailable" },
        { id: "ok", kind: "k", state: "unavailable" },
      ],
      recheck: (id: string) => {
        if (id === "hung") {
          hung.calls++;
          return new Promise<never>(() => {});
        }
        return Promise.resolve("unavailable" as const);
      },
    };
    const inFlight = new Set<string>();
    const options = { db, manager, runner: { wake: async () => {} }, timeoutMs: 5, inFlight };
    expect(await recheckInstances(options)).toEqual([]);
    expect(await recheckInstances(options)).toEqual([]);
    expect(hung.calls).toBe(1);
  });

  it("F4: upkeep passes do not overlap: while a slow recheck is pending the other instance is not rechecked again", async () => {
    const calls = { slow: 0, quick: 0 };
    const manager = {
      list: (): ConnectorSummary[] => [
        { id: "slow", kind: "k", state: "unavailable" },
        { id: "quick", kind: "k", state: "unavailable" },
      ],
      recheck: async (id: string) => {
        if (id === "slow") {
          calls.slow++;
          await new Promise((r) => setTimeout(r, 40));
        } else calls.quick++;
        return "unavailable" as const;
      },
    };
    const scheduler = createScheduler({ db, clock, timeZone: () => "UTC" });
    const upkeep = startCollectorUpkeep({
      db,
      manager,
      scheduler,
      runner: { wake: async () => {} },
      intervalMs: 5,
    });
    await new Promise((r) => setTimeout(r, 150));
    await upkeep.stop();
    expect(calls.slow).toBeGreaterThan(1);
    // each pass checks slow, then quick: quick is never ahead of slow, and behind by the pass cut short
    expect(calls.quick).toBeLessThanOrEqual(calls.slow);
    expect(calls.slow - calls.quick).toBeLessThanOrEqual(1);
  });

  it("B-F3: stop ends a pass under way without another write, and clears the timer", async () => {
    const { state, manager } = await late();
    const queued = register("site-x");
    await runnerOf(manager).runOnce(); // held: the instance is not ready
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => (finish = resolve));
    const slow = {
      list: () => manager.list(),
      recheck: async (id: string) => {
        await pending; // the recheck is in flight when stop is called
        state.ready = true;
        return manager.recheck(id);
      },
    };
    const scheduler = createScheduler({ db, clock, timeZone: () => "UTC" });
    const upkeep = startCollectorUpkeep({
      db,
      manager: slow,
      scheduler,
      runner: { wake: async () => {} },
      intervalMs: 5,
    });
    await upkeep.stop();
    finish();
    await new Promise((r) => setTimeout(r, 30));
    expect(job(queued.id).status).toBe("held"); // nothing was released after stop
  });

  it("N1: a recheck leaves no abort listener behind on the stop signal", async () => {
    let listeners = 0;
    const signal = {
      aborted: false,
      addEventListener: () => void listeners++,
      removeEventListener: () => void listeners--,
    } as unknown as AbortSignal;
    const manager = {
      list: (): ConnectorSummary[] => [
        { id: "a", kind: "k", state: "unavailable" },
        { id: "b", kind: "k", state: "unavailable" },
      ],
      recheck: async () => "unavailable" as const,
    };
    for (let pass = 0; pass < 4; pass++) {
      await recheckInstances({ db, manager, runner: { wake: async () => {} }, signal });
    }
    expect(listeners).toBe(0);
  });

  it("quit: stop resolves at once even when the recheck of an instance never settles", async () => {
    const manager = {
      list: (): ConnectorSummary[] => [{ id: "hung", kind: "k", state: "unavailable" }],
      recheck: () => new Promise<never>(() => {}),
    };
    const upkeep = startCollectorUpkeep({
      db,
      manager,
      scheduler: createScheduler({ db, clock, timeZone: () => "UTC" }),
      runner: { wake: async () => {} },
      intervalMs: 3_600_000,
    });
    const began = Date.now();
    await upkeep.stop();
    expect(Date.now() - began).toBeLessThan(500); // far under STOP_GRACE_MS: the abort ends the pass
  });

  it("B-F3: a pass cut by stop does not go on to release ready instances", async () => {
    const queued = register("ready-one");
    db.run("UPDATE jobs SET status = 'held', reason = 'not-implemented' WHERE id = ?", [queued.id]);
    const manager = {
      list: (): ConnectorSummary[] => [
        { id: "hung", kind: "k", state: "unavailable" },
        { id: "ready-one", kind: "k", state: "ready" },
      ],
      recheck: () => new Promise<never>(() => {}),
    };
    const scheduler = createScheduler({ db, clock, timeZone: () => "UTC" });
    const upkeep = startCollectorUpkeep({
      db,
      manager,
      scheduler,
      runner: { wake: async () => {} },
      intervalMs: 3_600_000,
    });
    db.run("UPDATE jobs SET status = 'held', reason = 'not-implemented' WHERE id = ?", [queued.id]); // the start release put it back
    await upkeep.stop();
    expect(job(queued.id).status).toBe("held");
  });

  it("B-F4: a claim that meets no manager yet is deferred with a code, its attempt unspent", async () => {
    const queued = register();
    const runner = createJobRunner({
      db,
      clock,
      handlers: {
        [CONNECTOR_SYNC_KIND]: createConnectorSyncHandler({ db, manager: () => undefined }),
      },
    });
    await runner.runOnce();
    expect(job(queued.id)).toMatchObject({
      status: "retry",
      reason: "manager-not-ready",
      attempts: 0,
    });
  });
});
