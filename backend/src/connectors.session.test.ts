// I06S-C4 (R10, R11): an instance with a session slot (`login`) is `login-required`, not
// `credential-missing` or `credential-rejected`, and shares the rejected instance's retry cap. The store is a
// memory double with a write, the manager the real one, the runner the product's. Every value is made up.
import { ConnectorCredentialError, type Connector, type ConnectorContext } from "@pki/contracts";
import { readJob, registerJob, type SqlDriver, type StoredJob } from "@pki/storage";
import { dirTemplate } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openCanonicalDb, productRunner } from "./composition.ts";
import { connectorCredentialName } from "./connector-credentials.ts";
import { CONNECTOR_SYNC_KIND, recheckInstances, releaseOnReady } from "./connector-sync-job.ts";
import { createConnectorManager, type ConnectorFactory } from "./connectors.ts";
import type { JobRunner } from "./job-runner.ts";

const seedDataDir = dirTemplate((path) => openCanonicalDb(path).close());

let dir: string;
let db: SqlDriver;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-session-"));
  seedDataDir(join(dir, "data"));
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
const broker = { call: async () => ({}) as never, budgetUsage: () => ({}) as never };
const LOGIN = {
  slot: "session",
  startUrl: "https://idp.example.test/login",
  doneUrlPrefix: "https://app.example.test/home",
  cookies: ["sid"],
};

function store(values: Record<string, string>) {
  const held = new Map(Object.entries(values));
  return {
    values: held,
    read: async (n: string) =>
      held.has(n)
        ? { state: "present" as const, value: held.get(n) as string }
        : { state: "missing" as const },
    has: async (n: string) => (held.has(n) ? ("present" as const) : ("missing" as const)),
    write: async (n: string, v: string) => (held.set(n, v), "done" as const),
    deleteOthers: async () => "done" as const,
  };
}

interface Script {
  initialize?: (c: ConnectorContext) => Promise<void>;
  getChanges?: () => Promise<unknown>;
}
function kindOf(...scripts: Script[]) {
  const objects: { initializes: number; changeCalls: number }[] = [];
  const factory: ConnectorFactory = () => {
    const script = scripts[Math.min(objects.length, scripts.length - 1)] ?? {};
    const obj = { initializes: 0, changeCalls: 0 };
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
        obj.initializes++;
        await script.initialize?.(context as ConnectorContext);
      },
      healthCheck: async () => ({ state: "ok" as const }),
      getChanges: async () => {
        obj.changeCalls++;
        return script.getChanges
          ? script.getChanges()
          : { changes: [], nextCursor: "1", hasMore: false };
      },
      getDocument: async () => null,
    } as unknown as Connector;
  };
  return { objects, factory };
}
const expired = async (c: ConnectorContext) => {
  await c.credentials.read("session");
  throw new ConnectorCredentialError();
};

const late: { runner?: JobRunner } = {};
async function setup(
  instance: { id: string; slots: string[]; login?: typeof LOGIN },
  values: Record<string, string>,
  ...scripts: Script[]
) {
  const secrets = store(values);
  const kind = kindOf(...scripts);
  const manager = await createConnectorManager(
    db,
    [
      {
        id: instance.id,
        kind: KIND,
        config: {},
        credentials: instance.slots,
        ...(instance.login ? { login: instance.login } : {}),
      },
    ],
    { [KIND]: kind.factory },
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

describe("connectors.session: login-required (I06S-C4)", () => {
  it("an empty session slot is login-required at the start, no object is made, and the summary marks the session slot", async () => {
    const { manager, kind } = await setup(
      { id: "a", slots: ["session", "token"], login: LOGIN },
      { [name("token", "a")]: "synthetic-token-1" },
    );
    expect(manager.list()[0]).toMatchObject({
      state: "unavailable",
      reason: "login-required",
      credentials: [
        { slot: "session", state: "missing", login: true },
        { slot: "token", state: "present" },
      ],
    });
    expect(manager.list()[0]?.credentials?.[1]).not.toHaveProperty("login");
    expect(kind.objects).toHaveLength(0);
  });

  it("an empty fixed slot of the same instance is still credential-missing", async () => {
    const { manager } = await setup(
      { id: "a", slots: ["session", "token"], login: LOGIN },
      { [name("session", "a")]: "synthetic-session-1" },
    );
    expect(manager.list()[0]?.reason).toBe("credential-missing");
  });

  it("a sync refused by the origin holds the job under login-required; the hourly recheck does not rebuild; a notice after the login rebuilds, the instance is ready and the job runs", async () => {
    const { runner, manager, kind, secrets } = await setup(
      { id: "a", slots: ["session"], login: LOGIN },
      { [name("session", "a")]: "synthetic-session-1" },
      { getChanges: async () => Promise.reject(new ConnectorCredentialError()) },
      {},
    );
    const queued = register("a");
    await runner.runOnce();
    await flush();
    expect(job(queued.id)).toMatchObject({
      status: "held",
      reason: "login-required",
      attempts: 0,
    });
    expect(manager.list()[0]).toMatchObject({ state: "unavailable", reason: "login-required" });
    expect(kind.objects).toHaveLength(1);
    // the hourly pass: nothing is rebuilt (the lock-out cap)
    await recheckInstances({ db, manager, runner });
    await recheckInstances({ db, manager, runner });
    expect(kind.objects).toHaveLength(1);
    // the user logs in (the shell stored a new session), the screen's notice rebuilds
    secrets.values.set(name("session", "a"), "synthetic-session-2");
    expect((await manager.rebuild("a"))?.rebuild).toBe("done");
    await flush();
    expect(manager.list()[0]).toMatchObject({ state: "ready" });
    expect(job(queued.id).status).toBe("succeeded");
  });

  it("an initialize refused after the session was read is login-required and the notices keep the 30 s gap", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { manager, kind } = await setup(
      { id: "a", slots: ["session"], login: LOGIN },
      { [name("session", "a")]: "synthetic-session-1" },
      { initialize: expired },
      { initialize: expired },
      {},
    );
    expect(manager.list()[0]?.reason).toBe("login-required");
    expect((await manager.rebuild("a"))?.summary.reason).toBe("login-required"); // the gap starts
    expect((await manager.rebuild("a"))?.rebuild).toBe("queued");
    expect(kind.objects).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(manager.list()[0]).toMatchObject({ state: "ready" });
    expect(kind.objects).toHaveLength(3);
  });

  it("an instance with fixed slots only still reports credential-rejected", async () => {
    const { manager, runner } = await setup(
      { id: "s", slots: ["token"] },
      { [name("token", "s")]: "synthetic-token-1" },
      { getChanges: async () => Promise.reject(new ConnectorCredentialError()) },
    );
    const queued = register("s");
    await runner.runOnce();
    expect(manager.list()[0]?.reason).toBe("credential-rejected");
    expect(job(queued.id)).toMatchObject({ status: "held", reason: "credential-rejected" });
  });

  it("a login whose slot the instance does not declare is ignored: the instance behaves as before", async () => {
    const { manager } = await setup({ id: "a", slots: ["token"], login: LOGIN }, {});
    expect(manager.list()[0]).toMatchObject({ reason: "credential-missing" });
    expect(manager.list()[0]?.credentials?.[0]).not.toHaveProperty("login");
  });
});
