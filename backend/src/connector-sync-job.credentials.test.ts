// I06-T03 (I06-R10; I06-C6 ⑥, C7 ② to ⑤): a scheduled sync whose Connector refused the credential. The
// runner is the product's (`productRunner`, which wires the release that follows a held close), the manager
// the real one over a store double, and the origin system a scripted Connector. Waits are gates the test
// opens, never sleeps.
import { ConnectorCredentialError, type Connector, type ConnectorContext } from "@pki/contracts";
import { readJob, registerJob, type SqlDriver, type StoredJob } from "@pki/storage";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openCanonicalDb, productRunner } from "./composition.ts";
import { connectorCredentialName } from "./connector-credentials.ts";
import { CONNECTOR_SYNC_KIND, recheckInstances, releaseOnReady } from "./connector-sync-job.ts";
import { createConnectorManager, type ConnectorFactory } from "./connectors.ts";
import type { JobRunner } from "./job-runner.ts";

let dir: string;
let db: SqlDriver;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-sync-cred-"));
  db = openCanonicalDb(join(dir, "data"));
});
afterEach(() => {
  vi.useRealTimers();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const KIND = "k";
const name = (slot: string, id: string) => connectorCredentialName(KIND, id, slot);
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
};
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
};
const broker = { call: async () => ({}) as never, budgetUsage: () => ({}) as never };

function store(values: Record<string, string>) {
  const held = new Map(Object.entries(values));
  const state = {
    values: held,
    hasGate: undefined as Promise<void> | undefined,
    hasMode: "normal" as "normal" | "unavailable",
    read: async (n: string) =>
      held.has(n)
        ? { state: "present" as const, value: held.get(n) as string }
        : { state: "missing" as const },
    has: async (n: string) => {
      await state.hasGate;
      if (state.hasMode === "unavailable") return "unavailable" as const;
      return held.has(n) ? ("present" as const) : ("missing" as const);
    },
    deleteOthers: async () => "done" as const,
  };
  return state;
}

interface Script {
  initialize?: (c: ConnectorContext) => Promise<void>;
  getChanges?: (n: number) => Promise<unknown>;
}
function kindOf(...scripts: Script[]) {
  const objects: { changeCalls: number; context?: ConnectorContext | undefined }[] = [];
  const factory: ConnectorFactory = () => {
    const script = scripts[Math.min(objects.length, scripts.length - 1)] ?? {};
    const obj: { changeCalls: number; context?: ConnectorContext | undefined } = { changeCalls: 0 };
    objects.push(obj);
    return {
      manifest: {
        type: KIND,
        schemaVersion: 2,
        capabilities: {
          incremental: true,
          deletes: true,
          accessScope: false,
          fullRescan: true,
          deletionsOnRescan: false,
        },
      },
      initialize: async (_c: unknown, context?: ConnectorContext) => {
        obj.context = context;
        await script.initialize?.(context as ConnectorContext);
      },
      healthCheck: async () => ({ state: "ok" as const }),
      getChanges: async () => {
        obj.changeCalls++;
        return script.getChanges
          ? script.getChanges(obj.changeCalls)
          : { changes: [], nextCursor: "1", hasMore: false };
      },
      getDocument: async () => null,
    } as unknown as Connector;
  };
  return { objects, factory };
}
const refusedAfterReading = (slot: string) => async (c: ConnectorContext) => {
  await c.credentials.read(slot);
  throw new ConnectorCredentialError();
};

const late: { runner?: JobRunner } = {};

async function setup(
  instances: { id: string; slots?: string[] }[],
  values: Record<string, string>,
  ...scripts: Script[]
) {
  const secrets = store(values);
  const kind = kindOf(...scripts);
  const manager = await createConnectorManager(
    db,
    instances.map(({ id, slots }) => ({
      id,
      kind: KIND,
      config: {},
      ...(slots ? { credentials: slots } : {}),
    })),
    { [KIND]: kind.factory },
    // as boot.ts wires it: a new object that turns an instance ready releases its held jobs
    { secrets, onReady: releaseOnReady(db, { wake: () => (late.runner as JobRunner).wake() }) },
  );
  const runner = productRunner(db, broker, { connectors: () => manager });
  late.runner = runner;
  return { secrets, kind, manager, runner };
}
const register = (target: string): StoredJob => {
  const r = registerJob(db, { kind: CONNECTOR_SYNC_KIND, target });
  if (!r.registered) throw new Error("expected a new job");
  return r.job;
};
const job = (id: number) => readJob(db, id) as StoredJob;

describe("connector-sync-job: a refused credential holds the job for the instance's reason (I06-C7)", () => {
  it("② a sync stopped by the current object closes held, spends no attempt, and the reason is the instance's; the job is not put back", async () => {
    const { runner, kind } = await setup(
      [{ id: "a", slots: ["token"] }],
      { [name("token", "a")]: "synthetic-value-a" },
      {
        getChanges: async () => {
          throw new ConnectorCredentialError();
        },
      },
    );
    const queued = register("a");
    await runner.runOnce();
    await flush();
    expect(job(queued.id)).toMatchObject({
      status: "held",
      reason: "credential-rejected",
      attempts: 0,
    });
    expect(kind.objects[0]?.changeCalls).toBe(1);
  });

  it("⑥ the manager judges before it answers: while the second presence check waits the job is still running, and it closes with the reason the judge found, never put back", async () => {
    const { runner, secrets, kind } = await setup(
      [{ id: "a", slots: ["token"] }],
      { [name("token", "a")]: "synthetic-value-a" },
      {
        getChanges: async () => {
          throw new ConnectorCredentialError();
        },
      },
    );
    const wait = gate();
    secrets.hasGate = wait.opened;
    const queued = register("a");
    const run = runner.runOnce();
    await flush();
    expect(job(queued.id).status).toBe("running"); // judging: the close has not read a state yet
    wait.open();
    await run;
    await flush();
    expect(job(queued.id)).toMatchObject({ status: "held", reason: "credential-rejected" });
    expect(kind.objects[0]?.changeCalls).toBe(1);
  });

  it("③ a missing value and a refusal of the origin each hold the job under that reason, not connector-unavailable", async () => {
    const { runner, manager } = await setup(
      [
        { id: "missing", slots: ["token"] },
        { id: "rejected", slots: ["token"] },
      ],
      { [name("token", "rejected")]: "synthetic-value-r" },
      { getChanges: async () => Promise.reject(new ConnectorCredentialError()) },
    );
    const missing = register("missing");
    const rejected = register("rejected");
    await runner.runOnce();
    await runner.runOnce();
    await flush();
    expect(manager.list().map((s) => s.reason)).toEqual([
      "credential-missing",
      "credential-rejected",
    ]);
    expect(job(missing.id)).toMatchObject({
      status: "held",
      reason: "credential-missing",
      attempts: 0,
    });
    expect(job(rejected.id)).toMatchObject({
      status: "held",
      reason: "credential-rejected",
      attempts: 0,
    });
  });

  it("③ the store-unavailable and unreadable reasons hold the job the same way", async () => {
    const secrets = store({ [name("token", "s")]: "v" });
    secrets.hasMode = "unavailable";
    const manager = await createConnectorManager(
      db,
      [{ id: "s", kind: KIND, config: {}, credentials: ["token"] }],
      { [KIND]: kindOf({}).factory },
      { secrets },
    );
    const runner = productRunner(db, broker, { connectors: () => manager });
    const queued = register("s");
    await runner.runOnce();
    expect(job(queued.id)).toMatchObject({
      status: "held",
      reason: "credential-store-unavailable",
    });
    const unreadable = store({ [name("token", "u")]: "v" });
    const readsFail = { ...unreadable, read: async () => ({ state: "unavailable" as const }) };
    const manager2 = await createConnectorManager(
      db,
      [{ id: "u", kind: KIND, config: {}, credentials: ["token"] }],
      {
        [KIND]: kindOf({
          initialize: async (c) => {
            await c.credentials.read("token").catch(() => undefined);
            throw new ConnectorCredentialError();
          },
        }).factory,
      },
      { secrets: readsFail },
    );
    const runner2 = productRunner(db, broker, { connectors: () => manager2 });
    const second = register("u");
    await runner2.runOnce();
    expect(job(second.id)).toMatchObject({
      status: "held",
      reason: "credential-unreadable",
      attempts: 0,
    });
  });

  it("⑤ an instance that becomes ready releases the jobs held for its reason, and only its own", async () => {
    const { runner, manager, secrets } = await setup(
      [
        { id: "a", slots: ["token"] },
        { id: "b", slots: ["token"] },
      ],
      {},
      {},
    );
    const a = register("a");
    const b = register("b");
    await runner.runOnce();
    await runner.runOnce();
    await flush();
    expect(job(a.id)).toMatchObject({ status: "held", reason: "credential-missing" });
    expect(job(b.id)).toMatchObject({ status: "held", reason: "credential-missing" });
    secrets.values.set(name("token", "a"), "synthetic-value-a");
    await recheckInstances({ db, manager, runner });
    await flush();
    expect(job(a.id).status).not.toBe("held");
    expect(job(b.id)).toMatchObject({ status: "held", reason: "credential-missing" });
  });
});

describe("connector-sync-job: a stale object's sync (I06-C6 ⑥)", () => {
  it("closes held on connector-unavailable because the instance is ready on the new object, is put back at once, and finishes on the new object", async () => {
    const hold = gate();
    const { runner, manager, kind } = await setup(
      [{ id: "a", slots: ["token"] }],
      { [name("token", "a")]: "synthetic-value-a" },
      {
        getChanges: async () => {
          await hold.opened;
          throw new ConnectorCredentialError(); // its accessor was cut by the rebuild
        },
      },
      {},
    );
    const queued = register("a");
    const run = runner.runOnce();
    await flush();
    expect((await manager.rebuild("a"))?.rebuild).toBe("done");
    hold.open();
    await run;
    await flush();
    const after = job(queued.id);
    expect({ status: after.status, reason: after.reason }).toEqual({
      status: "succeeded",
      reason: null,
    });
    expect(after.reason).toBeNull();
    expect(kind.objects.map((o) => o.changeCalls)).toEqual([1, 1]);
    expect(manager.list()[0]).toMatchObject({ state: "ready" });
  });

  it("when the new object fails too the job stays held for the instance's reason and does not run again", async () => {
    const hold = gate();
    const { runner, manager, kind } = await setup(
      [{ id: "a", slots: ["token"] }],
      { [name("token", "a")]: "synthetic-value-a" },
      {
        getChanges: async () => {
          await hold.opened;
          throw new ConnectorCredentialError();
        },
      },
      { initialize: refusedAfterReading("token") },
    );
    const queued = register("a");
    const run = runner.runOnce();
    await flush();
    expect((await manager.rebuild("a"))?.summary).toMatchObject({ reason: "credential-rejected" });
    hold.open();
    await run;
    await flush();
    expect(job(queued.id)).toMatchObject({ status: "held", reason: "credential-rejected" });
    expect(kind.objects.map((o) => o.changeCalls)).toEqual([1, 0]);
  });
});

describe("connector-sync-job: a rebuild that turns the instance ready releases its held jobs (I06-R12, C9 ①)", () => {
  const rejectedThenFine = [{ initialize: refusedAfterReading("token") }, {}];

  it("the immediate rebuild: the job held for credential-rejected runs without the hourly pass", async () => {
    const { runner, manager } = await setup(
      [{ id: "a", slots: ["token"] }],
      { [name("token", "a")]: "synthetic-value-a" },
      ...rejectedThenFine,
    );
    const queued = register("a");
    await runner.runOnce();
    expect(job(queued.id)).toMatchObject({ status: "held", reason: "credential-rejected" });
    expect((await manager.rebuild("a"))?.rebuild).toBe("done");
    await flush();
    expect(job(queued.id).status).toBe("succeeded");
  });

  it("the owed rebuild (behind the 30 s gap) releases the job as well", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { runner, manager } = await setup(
      [{ id: "a", slots: ["token"] }],
      { [name("token", "a")]: "synthetic-value-a" },
      { initialize: refusedAfterReading("token") },
      { initialize: refusedAfterReading("token") },
      {},
    );
    const queued = register("a");
    await runner.runOnce();
    expect((await manager.rebuild("a"))?.summary.reason).toBe("credential-rejected"); // the gap starts
    expect((await manager.rebuild("a"))?.rebuild).toBe("queued");
    expect(job(queued.id).status).toBe("held");
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(manager.list()[0]).toMatchObject({ state: "ready" });
    expect(job(queued.id).status).toBe("succeeded");
  });
});

describe("connector-sync-job: only a replaced object's stop is put back at close (I06-R10)", () => {
  it("a held close on the current object is never requeued, even when the instance reads ready", async () => {
    let calls = 0;
    const manager = {
      list: () => [{ id: "a", kind: KIND, state: "ready" as const }],
      sync: async () => {
        calls++;
        // a loop would end by itself here so that the test fails by its assertion, not by hanging
        if (calls > 5) return { error: "not-found" as const };
        return {
          connectorId: "a",
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
          stopped: "credential-unusable" as const,
        };
      },
    };
    const runner = productRunner(db, broker, { connectors: () => manager });
    const queued = register("a");
    await runner.runOnce();
    await flush();
    expect(calls).toBe(1);
    expect(job(queued.id)).toMatchObject({ status: "held", reason: "connector-unavailable" });
  });
});
