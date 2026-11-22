// I05-T02 (I05-R10 to R13, I05-C8, C9, C11): the start and the recheck of the Connector instances.
// Time is the fake timers' (the 10 s and 60 s limits are crossed by advancing them, never by waiting);
// a Connector here is a small double whose `initialize` and `healthCheck` the test holds.
import type { Connector } from "@pki/contracts";
import { ConnectorNotImplementedError } from "@pki/contracts";
import { migrate, type SqlDriver } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnectorSyncHandler, recheckInstances } from "./connector-sync-job.ts";
import {
  createConnectorManager,
  INITIALIZE_TIMEOUT_MS,
  RECHECK_LATE_LIMIT,
  type ConnectorFactory,
} from "./connectors.ts";

let db: SqlDriver;
let lines: string[];
beforeEach(() => {
  vi.useFakeTimers();
  db = openBetterSqlite3(":memory:");
  migrate(db);
  lines = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => void lines.push(String(line)));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  db.close();
});

const events = () => lines.map((l) => JSON.parse(l) as { event: string; id?: string });

/** A Connector whose `initialize` is whatever the test gives it, and which counts its calls. */
function made(initialize: () => Promise<void> = async () => {}, health: "ok" | "down" = "ok") {
  const connector = {
    manifest: {
      type: "k",
      schemaVersion: 2,
      capabilities: {
        incremental: true,
        deletes: true,
        accessScope: false,
        fullRescan: true,
        deletionsOnRescan: false,
      },
    },
    initializeCalls: 0,
    changeCalls: 0,
    initialize: async () => {
      connector.initializeCalls++;
      await initialize();
    },
    healthCheck: async () =>
      health === "ok"
        ? { state: "ok" as const }
        : { state: "unavailable" as const, reason: "down" },
    getChanges: async () => {
      connector.changeCalls++;
      return { changes: [], nextCursor: null, hasMore: false };
    },
    getDocument: async () => null,
  };
  return connector;
}
type Made = ReturnType<typeof made>;
const never = () => new Promise<void>(() => {});
const asConnector = (c: Made): Connector => c as unknown as Connector;

const instance = (id: string, kind = "k") => ({ id, kind, config: {} });

describe("connectors.boot-bounded (I05-C8)", () => {
  it("the start ends when the limit passes: the slow instance is unavailable, the other ready, its sync and held job say connector-unavailable", async () => {
    const hung = made(never);
    const fine = made();
    const kinds = { hung: () => asConnector(hung), fine: () => asConnector(fine) };
    let manager: Awaited<ReturnType<typeof createConnectorManager>> | undefined;
    void createConnectorManager(db, [instance("h", "hung"), instance("f", "fine")], kinds).then(
      (m) => (manager = m),
    );
    await vi.advanceTimersByTimeAsync(INITIALIZE_TIMEOUT_MS - 1);
    expect(manager).toBeUndefined(); // the limit has not passed: the start still waits
    await vi.advanceTimersByTimeAsync(1);
    expect(manager?.list()).toEqual([
      { id: "h", kind: "hung", state: "unavailable" },
      { id: "f", kind: "fine", state: "ready" },
    ]);
    expect(events()).toEqual([{ event: "connector-initialize-timeout", id: "h" }]);
    expect(await manager?.sync("h")).toEqual({ error: "connector-unavailable" });
    const handler = createConnectorSyncHandler({ db, manager: () => manager });
    const result = await handler(
      { target: "h", id: 1 } as never,
      {
        signal: new AbortController().signal,
      } as never,
    );
    expect(result).toEqual({ status: "held", reason: "connector-unavailable" });
  });

  it("a result that comes after the limit changes nothing, a success or a failure", async () => {
    let finish!: () => void;
    let fail!: (e: Error) => void;
    const slow = made(() => new Promise<void>((r) => (finish = r)));
    const slowFail = made(() => new Promise<void>((_, r) => (fail = r)));
    const kinds = { a: () => asConnector(slow), b: () => asConnector(slowFail) };
    const pending = createConnectorManager(db, [instance("a", "a"), instance("b", "b")], kinds);
    await vi.advanceTimersByTimeAsync(INITIALIZE_TIMEOUT_MS);
    const manager = await pending;
    finish();
    fail(new Error("late"));
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.list().map((s) => s.state)).toEqual(["unavailable", "unavailable"]);
    expect(await manager.sync("a")).toEqual({ error: "connector-unavailable" });
  });
});

describe("connectors.boot-isolated (I05-C9)", () => {
  it("a factory that throws, an initialize that throws and an unknown kind each leave only that instance unavailable, with a fixed code and no thrown text", async () => {
    const secret = "thrown-text-with-token-abc";
    const kinds: Record<string, ConnectorFactory> = {
      boom: () => {
        throw new Error(secret);
      },
      bad: () => asConnector(made(() => Promise.reject(new Error(secret)))),
      fine: () => asConnector(made()),
    };
    const manager = await createConnectorManager(
      db,
      [
        instance("a", "boom"),
        instance("b", "bad"),
        instance("c", "nowhere"),
        instance("d", "fine"),
      ],
      kinds,
    );
    expect(manager.list().map((s) => [s.id, s.state])).toEqual([
      ["a", "unavailable"],
      ["b", "unavailable"],
      ["c", "unavailable"],
      ["d", "ready"],
    ]);
    expect(events().sort((x, y) => (x.id ?? "").localeCompare(y.id ?? ""))).toEqual([
      { event: "connector-factory-failed", id: "a" },
      { event: "connector-initialize-failed", id: "b" },
      { event: "connector-kind-unknown", id: "c" },
    ]);
    expect(lines.join("\n")).not.toContain(secret);
    expect(JSON.stringify(manager.list())).not.toContain(secret);
    expect(await manager.sync("c")).toEqual({ error: "connector-unavailable" });
  });

  it("a placeholder that is not implemented stays not-implemented and logs nothing", async () => {
    const manager = await createConnectorManager(db, [instance("p")], {
      k: () =>
        asConnector(
          made(() => {
            throw new ConnectorNotImplementedError();
          }),
        ),
    });
    expect(manager.list()).toEqual([{ id: "p", kind: "k", state: "not-implemented" }]);
    expect(events()).toEqual([]);
  });
});

describe("connectors.recheck-fresh (I05-C11)", () => {
  /** A kind whose objects are made one by one by the test; `made` lists them in order. */
  function kindOf(...inits: Array<() => Promise<void>>) {
    const objects: Made[] = [];
    const factory: ConnectorFactory = () => {
      const next = made(inits[Math.min(objects.length, inits.length - 1)]);
      objects.push(next);
      return asConnector(next);
    };
    return { objects, factory };
  }
  const failing = () => Promise.reject(new Error("no"));

  it("① ② ④ a failed instance is made again, becomes ready on a new object, no object is initialized twice, a ready instance keeps its object", async () => {
    const kind = kindOf(failing, async () => {});
    const manager = await createConnectorManager(db, [instance("x")], { k: kind.factory });
    expect(manager.list()[0]?.state).toBe("unavailable");
    expect(await manager.recheck("x")).toBe("ready");
    expect(kind.objects).toHaveLength(2);
    expect(kind.objects.map((o) => o.initializeCalls)).toEqual([1, 1]);
    // the instance now syncs with the new object, never the one whose initialize failed
    expect(await manager.sync("x")).toMatchObject({ connectorId: "x" });
    expect(kind.objects.map((o) => o.changeCalls)).toEqual([0, 1]);
    expect(await manager.recheck("x")).toBe("ready");
    expect(kind.objects).toHaveLength(2);
  });

  it("③ a new object that fails leaves the instance unavailable and the object is dropped", async () => {
    const kind = kindOf(failing);
    const manager = await createConnectorManager(db, [instance("x")], { k: kind.factory });
    expect(await manager.recheck("x")).toBe("unavailable");
    expect(await manager.recheck("x")).toBe("unavailable");
    expect(kind.objects.map((o) => o.initializeCalls)).toEqual([1, 1, 1]);
    expect(await manager.sync("x")).toEqual({ error: "connector-unavailable" });
  });

  it("an object that initializes but is not healthy is not used", async () => {
    let calls = 0;
    const manager = await createConnectorManager(db, [instance("x")], {
      k: () => {
        calls++;
        return asConnector(calls === 1 ? made(failing) : made(async () => {}, "down"));
      },
    });
    expect(await manager.recheck("x")).toBe("unavailable");
    expect(manager.list()[0]?.state).toBe("unavailable");
  });

  it("⑥ a factory that throws in a recheck leaves the instance unavailable, logs the fixed code, and the pass goes on", async () => {
    let calls = 0;
    const factories: Record<string, ConnectorFactory> = {
      a: () => {
        calls++;
        if (calls > 1) throw new Error("secret-factory-text");
        return asConnector(made(failing));
      },
      b: () => asConnector(made(failing)),
    };
    const manager = await createConnectorManager(
      db,
      [instance("x", "a"), instance("y", "b")],
      factories,
    );
    lines.length = 0;
    const woken: string[] = [];
    await recheckInstances({ db, manager, runner: { wake: async () => void woken.push("w") } });
    expect(events()).toEqual([{ event: "connector-factory-failed", id: "x" }]);
    expect(lines.join("\n")).not.toContain("secret-factory-text");
    expect(manager.list().map((s) => s.state)).toEqual(["unavailable", "unavailable"]);
    expect(calls).toBe(2);
  });

  it("⑧ an instance with no kind calls nothing in a recheck and logs only its start line", async () => {
    const manager = await createConnectorManager(db, [instance("x", "nowhere")], {});
    expect(events()).toEqual([{ event: "connector-kind-unknown", id: "x" }]);
    expect(await manager.recheck("x")).toBe("unavailable");
    expect(events()).toHaveLength(1);
  });

  it("⑤ a recheck still pending is not started again by the next pass", async () => {
    const kind = kindOf(failing, never);
    const manager = await createConnectorManager(db, [instance("x")], { k: kind.factory });
    const inFlight = new Set<string>();
    const options = { db, manager, runner: { wake: async () => {} }, timeoutMs: 5, inFlight };
    const first = recheckInstances(options);
    await vi.advanceTimersByTimeAsync(5);
    await first;
    await recheckInstances(options);
    expect(kind.objects).toHaveLength(2);
  });

  it("⑦ a recheck that succeeds after its 60 s is discarded: state and object stay, and the next pass makes a new object", async () => {
    let release!: () => void;
    const kind = kindOf(
      failing,
      () => new Promise<void>((r) => (release = r)),
      async () => {},
    );
    const manager = await createConnectorManager(db, [instance("x")], { k: kind.factory });
    const options = {
      db,
      manager,
      runner: { wake: async () => {} },
      timeoutMs: 60_000,
      inFlight: new Set<string>(),
    };
    const pass = recheckInstances(options);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pass).toEqual([]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.list()[0]?.state).toBe("unavailable");
    expect(await manager.sync("x")).toEqual({ error: "connector-unavailable" });
    expect(await recheckInstances(options)).toEqual(["x"]);
    expect(kind.objects).toHaveLength(3);
    expect(manager.list()[0]?.state).toBe("ready");
  });

  it("⑨ a start attempt past its limit and still running does not hold the first recheck back: a new object is made, and at most two objects are unfinished", async () => {
    const kind = kindOf(never, never);
    const pending = createConnectorManager(db, [instance("x")], { k: kind.factory });
    await vi.advanceTimersByTimeAsync(INITIALIZE_TIMEOUT_MS);
    const manager = await pending;
    const options = {
      db,
      manager,
      runner: { wake: async () => {} },
      timeoutMs: 60_000,
      inFlight: new Set<string>(),
    };
    const first = recheckInstances(options);
    await vi.advanceTimersByTimeAsync(60_000);
    await first;
    expect(kind.objects).toHaveLength(2);
    // the start's object and the recheck's both never finish; the recheck holds the instance
    await recheckInstances(options);
    expect(kind.objects).toHaveLength(2);
  });

  it("⑩ three rechecks in a row that finish late end the rechecks, once logged; one that finishes in time counts again from zero", async () => {
    const releases: Array<() => void> = [];
    const slow = () => new Promise<void>((r) => releases.push(r));
    const kind = kindOf(failing, slow);
    const manager = await createConnectorManager(db, [instance("x")], { k: kind.factory });
    const options = {
      db,
      manager,
      runner: { wake: async () => {} },
      timeoutMs: 60_000,
      inFlight: new Set<string>(),
    };
    const lateTurn = async () => {
      const pass = recheckInstances(options);
      await vi.advanceTimersByTimeAsync(60_000);
      await pass;
      releases.pop()?.();
      await vi.advanceTimersByTimeAsync(0);
    };
    for (let i = 0; i < RECHECK_LATE_LIMIT; i++) await lateTurn();
    expect(kind.objects).toHaveLength(1 + RECHECK_LATE_LIMIT);
    lines.length = 0;
    await recheckInstances(options);
    await recheckInstances(options);
    expect(kind.objects).toHaveLength(1 + RECHECK_LATE_LIMIT); // no factory call from the fourth turn on
    expect(events()).toEqual([{ event: "connector-recheck-abandoned", id: "x" }]);
  });

  it("⑩ an in-time recheck between late ones resets the count", async () => {
    const releases: Array<() => void> = [];
    let turn = 0;
    const objects: Made[] = [];
    const factory: ConnectorFactory = () => {
      const n = turn++;
      const o = made(
        n === 0 || n === 3 ? failing : () => new Promise<void>((r) => releases.push(r)),
      );
      objects.push(o);
      return asConnector(o);
    };
    const manager = await createConnectorManager(db, [instance("x")], { k: factory });
    const options = {
      db,
      manager,
      runner: { wake: async () => {} },
      timeoutMs: 60_000,
      inFlight: new Set<string>(),
    };
    const lateTurn = async () => {
      const pass = recheckInstances(options);
      await vi.advanceTimersByTimeAsync(60_000);
      await pass;
      releases.pop()?.();
      await vi.advanceTimersByTimeAsync(0);
    };
    await lateTurn();
    await lateTurn(); // two late
    await recheckInstances(options); // turn 3: fails in time: the count restarts
    await lateTurn();
    await lateTurn(); // two late again: three in all, counted from the in-time one
    lines.length = 0;
    await lateTurn();
    expect(objects).toHaveLength(7);
    expect(events()).toEqual([]);
  });
});
