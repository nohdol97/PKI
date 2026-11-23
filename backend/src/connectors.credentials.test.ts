// I06-T03 (I06-R6 to R13; I06-C3 ③, C4, C5, C6 ① to ⑤ ⑦ ⑧, C8, C9 ① to ③ ⑤ ⑦ to ⑨, C10, C12): the manager's
// credential path. The store is a memory double that records every call; a Connector is a small double
// that keeps the context it was given. Time is the fake timers' (the 3 s, 10 s, 30 s and 60 s limits are
// crossed by advancing them, never by waiting). Every value is made up.
import {
  CONNECTOR_CREDENTIAL_MESSAGE,
  ConnectorCredentialError,
  HEALTH_REASON_CREDENTIAL_REJECTED,
  type Connector,
  type ConnectorContext,
  type SecretRead,
} from "@pki/contracts";
import { migrate, readCursor, type SqlDriver } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CREDENTIAL_CHECK_TIMEOUT_MS,
  CREDENTIAL_RETRY_MIN_MS,
  connectorCredentialName,
} from "./connector-credentials.ts";
import { recheckInstances, RECHECK_TIMEOUT_MS } from "./connector-sync-job.ts";
import {
  createConnectorManager,
  INITIALIZE_TIMEOUT_MS,
  RECHECK_LATE_LIMIT,
  type ConnectorFactory,
  type ConnectorInstanceConfig,
} from "./connectors.ts";
import { memoryDbTemplate } from "@pki/testkit";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);

let db: SqlDriver;
let lines: string[];
beforeEach(() => {
  vi.useFakeTimers();
  db = freshDb();
  lines = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => void lines.push(String(line)));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  db.close();
});
const events = () => lines.map((l) => JSON.parse(l) as { event: string; id?: string });

type Mode = "normal" | "unavailable" | "hang";
/** A store double: values by name, and what each call was asked. */
function makeStore(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const store = {
    values,
    reads: [] as string[],
    asked: [] as string[],
    deletes: 0,
    readMode: "normal" as Mode,
    hasMode: "normal" as Mode,
    hangHasFor: new Set<string>(),
    async read(name: string): Promise<SecretRead> {
      store.reads.push(name);
      if (store.readMode === "hang") return new Promise<SecretRead>(() => {});
      if (store.readMode === "unavailable") return { state: "unavailable" };
      const value = values.get(name);
      return value === undefined ? { state: "missing" } : { state: "present", value };
    },
    gateNext: undefined as Promise<void> | undefined,
    async has(name: string) {
      store.asked.push(name);
      const gate = store.gateNext;
      store.gateNext = undefined;
      if (gate) await gate; // only the next question waits
      if (store.hangHasFor.has(name) || store.hasMode === "hang")
        return new Promise<never>(() => {});
      if (store.hasMode === "unavailable") return "unavailable" as const;
      return values.has(name) ? ("present" as const) : ("missing" as const);
    },
    async deleteOthers() {
      store.deletes++;
      return "done" as const;
    },
  };
  return store;
}
type Store = ReturnType<typeof makeStore>;

const ID = "x";
const KIND = "k";
const name = (slot: string, id = ID, kind = KIND) => connectorCredentialName(kind, id, slot);
const never = () => new Promise<void>(() => {});

/** One object a factory made: its context, its calls, and what each of them does. */
interface Obj {
  connector: Connector;
  context: ConnectorContext | undefined;
  initializeCalls: number;
  changeCalls: number;
}
interface Script {
  initialize?: (context: ConnectorContext) => Promise<void>;
  health?: () => Promise<{ state: "ok" } | { state: "unavailable"; reason: string }>;
  getChanges?: (n: number) => Promise<unknown>;
}
const PAGE = (cursor: string, hasMore: boolean) => ({
  changes: [
    {
      kind: "upsert" as const,
      record: {
        namespace: "",
        externalId: `r${cursor}`,
        revision: 1,
        schemaVersion: 2 as const,
        title: "t",
        body: "synthetic body",
      },
    },
  ],
  nextCursor: cursor,
  hasMore,
});

/** A kind whose objects the test scripts one by one (the last script repeats). */
function kindOf(...scripts: Script[]) {
  const objects: Obj[] = [];
  const factory: ConnectorFactory = () => {
    const script = scripts[Math.min(objects.length, scripts.length - 1)] ?? {};
    const obj: Obj = {
      context: undefined,
      initializeCalls: 0,
      changeCalls: 0,
      connector: {
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
        initialize: async (_config: unknown, context?: ConnectorContext) => {
          obj.initializeCalls++;
          obj.context = context;
          await script.initialize?.(context as ConnectorContext);
        },
        healthCheck: script.health ?? (async () => ({ state: "ok" as const })),
        getChanges: async () => {
          obj.changeCalls++;
          return script.getChanges ? script.getChanges(obj.changeCalls) : PAGE("1", false);
        },
        getDocument: async () => null,
      } as unknown as Connector,
    };
    objects.push(obj);
    return obj.connector;
  };
  return { objects, factory };
}

const reads =
  (...slots: string[]) =>
  async (context: ConnectorContext) => {
    for (const slot of slots) await context.credentials.read(slot);
  };
const refuse = async () => {
  throw new ConnectorCredentialError();
};
/** An initialize that reads its slots and then is refused by the origin. */
const refusedAfter =
  (...slots: string[]) =>
  async (context: ConnectorContext) => {
    await reads(...slots)(context);
    throw new ConnectorCredentialError();
  };

const declared = (credentials?: readonly string[], id = ID): ConnectorInstanceConfig => ({
  id,
  kind: KIND,
  config: {},
  ...(credentials ? { credentials } : {}),
});
const start = (
  instances: ConnectorInstanceConfig[],
  factory: ConnectorFactory,
  store?: Store,
  kind = KIND,
) => createConnectorManager(db, instances, { [kind]: factory }, store ? { secrets: store } : {});
const stateOf = (manager: Awaited<ReturnType<typeof start>>, id = ID) =>
  manager.list().find((s) => s.id === id);

describe("connectors.credentials-handover (I06-C4, C3 ③)", () => {
  it("① the instance is ready and the Connector reads what is stored; ② every read asks the store again; ③ an undeclared slot never reaches the store", async () => {
    const store = makeStore({
      [name("token")]: "synthetic-token-1",
      [name("user")]: "synthetic-user-1",
    });
    const kind = kindOf({});
    const manager = await start([declared(["token", "user"])], kind.factory, store);
    expect(stateOf(manager)).toMatchObject({ state: "ready" });
    const credentials = kind.objects[0]?.context?.credentials as ConnectorContext["credentials"];
    expect(await credentials.read("token")).toBe("synthetic-token-1");
    expect(await credentials.read("user")).toBe("synthetic-user-1");
    store.reads.length = 0;
    await credentials.read("token");
    await credentials.read("token");
    expect(store.reads).toEqual([name("token"), name("token")]);
    store.reads.length = 0;
    await expect(credentials.read("other")).rejects.toBeInstanceOf(ConnectorCredentialError);
    expect(store.reads).toEqual([]);
  });

  it("④ a store that later says missing, says unavailable or does not answer refuses the read, and the refusal names neither the slot nor the stored name", async () => {
    const store = makeStore({ [name("token")]: "synthetic-token-1" });
    const kind = kindOf({});
    await start([declared(["token"])], kind.factory, store);
    const credentials = (kind.objects[0] as Obj).context
      ?.credentials as ConnectorContext["credentials"];
    const refusals: unknown[] = [];
    const catching = (work: Promise<string>) =>
      work.catch((error: unknown) => refusals.push(error));
    store.values.clear();
    await catching(credentials.read("token"));
    store.values.set(name("token"), "synthetic-token-1");
    store.readMode = "unavailable";
    await catching(credentials.read("token"));
    store.readMode = "hang";
    const late = catching(credentials.read("token"));
    await vi.advanceTimersByTimeAsync(CREDENTIAL_CHECK_TIMEOUT_MS);
    await late;
    expect(refusals).toHaveLength(3);
    for (const refusal of refusals) {
      expect(refusal).toBeInstanceOf(ConnectorCredentialError);
      expect((refusal as Error).message).toBe(CONNECTOR_CREDENTIAL_MESSAGE);
      expect(JSON.stringify(refusal)).not.toContain("token");
    }
  });

  it("⑤ the three kinds of given-up object each lose the accessor: the start's late one, a failed recheck's and the one a rebuild replaced", async () => {
    const store = makeStore({ [name("token")]: "synthetic-token-1" });
    // object 1 never finishes initializing (the start's limit passes), 2 fails in a recheck, 3 is ready, 4 replaces it
    const kind = kindOf({ initialize: never }, { initialize: refusedAfter("token") }, {}, {});
    const pending = start([declared(["token"])], kind.factory, store);
    await vi.advanceTimersByTimeAsync(INITIALIZE_TIMEOUT_MS);
    const manager = await pending;
    expect((await manager.rebuild(ID))?.summary.state).toBe("unavailable"); // object 2: refused
    expect((await manager.rebuild(ID))?.rebuild).toBe("queued"); // the gap of a rejected instance
    await vi.advanceTimersByTimeAsync(CREDENTIAL_RETRY_MIN_MS); // object 3
    expect(stateOf(manager)?.state).toBe("ready");
    expect((await manager.rebuild(ID))?.rebuild).toBe("done"); // object 4 replaces 3
    expect(kind.objects).toHaveLength(4);
    store.reads.length = 0;
    for (const index of [0, 1, 2]) {
      const credentials = kind.objects[index]?.context
        ?.credentials as ConnectorContext["credentials"];
      await expect(credentials.read("token")).rejects.toBeInstanceOf(ConnectorCredentialError);
    }
    expect(store.reads).toEqual([]);
    // the one in use still reads
    const live = kind.objects[3]?.context?.credentials as ConnectorContext["credentials"];
    expect(await live.read("token")).toBe("synthetic-token-1");
  });

  it("⑥ on the start, a recheck and a rebuild the store is asked whether the slots are there before the factory is called", async () => {
    const store = makeStore({ [name("token")]: "synthetic-token-1" });
    const order: string[] = [];
    const asked = store.has.bind(store);
    store.has = async (n: string) => (order.push("has"), asked(n)) as never;
    const kind = kindOf({ initialize: async () => Promise.reject(new Error("no")) }, {});
    const factory: ConnectorFactory = () => (order.push("factory"), kind.factory());
    const manager = await start([declared(["token"])], factory, store);
    await manager.recheck(ID);
    await manager.rebuild(ID);
    expect(order).toEqual(["has", "factory", "has", "factory", "has", "factory"]);
  });

  it("C3 ③ an instance that declares nothing still gets a context, and its accessor refuses everything", async () => {
    const store = makeStore({ [name("token")]: "synthetic-token-1" });
    const kind = kindOf({});
    await start([declared()], kind.factory, store);
    const credentials = (kind.objects[0] as Obj).context
      ?.credentials as ConnectorContext["credentials"];
    await expect(credentials.read("token")).rejects.toBeInstanceOf(ConnectorCredentialError);
    expect(store.reads).toEqual([]);
  });
});

describe("connectors.credentials-absent (I06-C5)", () => {
  it("① a missing slot: no object is made and no initialize runs; the instance says credential-missing", async () => {
    const store = makeStore({ [name("a")]: "synthetic-value-a" });
    const kind = kindOf({});
    const manager = await start([declared(["a", "b"])], kind.factory, store);
    expect(kind.objects).toHaveLength(0);
    expect(stateOf(manager)).toMatchObject({ state: "unavailable", reason: "credential-missing" });
  });

  it("② one slot the store cannot answer makes it credential-store-unavailable, also next to a missing one", async () => {
    const store = makeStore({ [name("a")]: "synthetic-value-a" });
    store.hangHasFor.add(name("c"));
    const kind = kindOf({});
    const pending = start([declared(["a", "b", "c"])], kind.factory, store);
    await vi.advanceTimersByTimeAsync(CREDENTIAL_CHECK_TIMEOUT_MS);
    const manager = await pending;
    expect(stateOf(manager)).toMatchObject({ reason: "credential-store-unavailable" });
    expect(kind.objects).toHaveLength(0);
    const unavailable = makeStore({ [name("a")]: "synthetic-value-a" });
    unavailable.hasMode = "unavailable";
    const second = await start([declared(["a", "b"])], kindOf({}).factory, unavailable);
    expect(stateOf(second)).toMatchObject({ reason: "credential-store-unavailable" });
  });

  it("③ eight slots with one that never answers: the limit is one CREDENTIAL_CHECK_TIMEOUT_MS, not eight, and the start ends", async () => {
    const slots = Array.from({ length: 8 }, (_, i) => `s${i}`);
    const store = makeStore(
      Object.fromEntries(slots.map((s) => [name(s), `synthetic-value-${s}`])),
    );
    store.hangHasFor.add(name("s7"));
    let manager: Awaited<ReturnType<typeof start>> | undefined;
    void start([declared(slots)], kindOf({}).factory, store).then((m) => (manager = m));
    await vi.advanceTimersByTimeAsync(CREDENTIAL_CHECK_TIMEOUT_MS - 1);
    expect(manager).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(manager && stateOf(manager)).toMatchObject({ reason: "credential-store-unavailable" });
  });

  it("④ with no store at all, a canary in the environment and in the config is never used: no object, credential-store-unavailable", async () => {
    const canary = "synthetic-canary-value-0001";
    vi.stubEnv("PKI_TEST_CANARY", canary);
    const kind = kindOf({});
    const manager = await createConnectorManager(
      db,
      [{ id: ID, kind: KIND, config: { token: canary }, credentials: ["token"] }],
      { [KIND]: kind.factory },
    );
    vi.unstubAllEnvs();
    expect(kind.objects).toHaveLength(0);
    expect(stateOf(manager)).toMatchObject({ reason: "credential-store-unavailable" });
  });

  it("⑤ the other instances of the registration are ready", async () => {
    const store = makeStore();
    const kind = kindOf({});
    const manager = await start(
      [declared(["token"], "a"), declared(undefined, "b")],
      kind.factory,
      store,
    );
    expect(stateOf(manager, "a")).toMatchObject({ state: "unavailable" });
    expect(stateOf(manager, "b")).toMatchObject({ state: "ready" });
  });

  it("the reasons are decided from the store, in the order store-unavailable, missing (a slot that cannot be asked is not a value to put in)", async () => {
    const store = makeStore();
    store.hangHasFor.add(name("b"));
    const pending = start([declared(["a", "b"])], kindOf({}).factory, store);
    await vi.advanceTimersByTimeAsync(CREDENTIAL_CHECK_TIMEOUT_MS);
    expect(stateOf(await pending)?.reason).toBe("credential-store-unavailable");
  });
});

describe("connectors.credentials-rejected (I06-C6, I06-R9, R10)", () => {
  it("① initialize refused after every value was read: credential-rejected, and the thrown error is not kept", async () => {
    const store = makeStore({ [name("token")]: "synthetic-token-1" });
    const manager = await start(
      [declared(["token"])],
      kindOf({ initialize: refusedAfter("token") }).factory,
      store,
    );
    expect(stateOf(manager)).toMatchObject({ state: "unavailable", reason: "credential-rejected" });
  });

  it("② a refusal after the accessor met a missing value is credential-missing; a store that cannot be asked again is store-unavailable, which comes first; a read that was unavailable with every slot present is credential-unreadable; a new object starts with no marks", async () => {
    const store = makeStore({ [name("token")]: "synthetic-token-1" });
    const readOnce = async (context: ConnectorContext) => {
      await context.credentials.read("token").catch(() => undefined);
      throw new ConnectorCredentialError();
    };
    // the value goes missing while initialize reads it
    const missingWhileReading = kindOf({
      initialize: async (c) => {
        store.values.clear();
        await readOnce(c);
      },
    });
    const first = await start([declared(["token"], "m")], missingWhileReading.factory, store);
    expect(stateOf(first, "m")).toMatchObject({ reason: "credential-missing" });
    store.values.set(name("token", "u"), "synthetic-token-1");
    // the read said unavailable, but every slot is present when asked again
    const unreadable = kindOf({
      initialize: async (c) => {
        store.readMode = "unavailable";
        try {
          await readOnce(c);
        } finally {
          store.readMode = "normal";
        }
      },
    });
    const second = await start([declared(["token"], "u")], unreadable.factory, store);
    expect(stateOf(second, "u")).toMatchObject({ reason: "credential-unreadable" });
    // the accessor met a missing value, and the store cannot be asked again: the store comes first
    store.values.set(name("token", "p"), "synthetic-token-1");
    const both = kindOf({
      initialize: async (c) => {
        store.values.delete(name("token", "p"));
        await c.credentials.read("token").catch(() => undefined);
        store.hasMode = "unavailable";
        throw new ConnectorCredentialError();
      },
    });
    const third = await start([declared(["token"], "p")], both.factory, store);
    store.hasMode = "normal";
    expect(stateOf(third, "p")).toMatchObject({ reason: "credential-store-unavailable" });
  });

  it("② the marks are the object's: after the value comes back a new object that is refused is credential-rejected, not credential-unreadable", async () => {
    const store = makeStore({ [name("token")]: "synthetic-token-1" });
    const kind = kindOf(
      {
        initialize: async (c) => {
          store.readMode = "unavailable";
          await c.credentials.read("token").catch(() => undefined);
          store.readMode = "normal";
          throw new ConnectorCredentialError();
        },
      },
      { initialize: refusedAfter("token") },
    );
    const manager = await start([declared(["token"])], kind.factory, store);
    expect(stateOf(manager)?.reason).toBe("credential-unreadable");
    expect(await manager.recheck(ID)).toBe("unavailable");
    // unreadable is rechecked every hour; the new object has no marks and reads fine, so its refusal is the origin's
    expect(stateOf(manager)?.reason).toBe("credential-rejected");
  });

  it("③ ④ a second page refused: it stops credential-unusable, the first page and its cursor stay, getChanges is not asked again, and the next sync is connector-unavailable", async () => {
    const store = makeStore({ [name("token")]: "synthetic-token-1" });
    const kind = kindOf({
      getChanges: async (n) => {
        if (n === 1) return PAGE("1", true);
        await kind.objects[0]?.context?.credentials.read("token");
        throw new ConnectorCredentialError();
      },
    });
    const manager = await start([declared(["token"])], kind.factory, store);
    const result = await manager.sync(ID);
    expect(result).toMatchObject({ connectorId: ID, stopped: "credential-unusable", created: 1 });
    expect(kind.objects[0]?.changeCalls).toBe(2);
    expect(readCursor(db, ID)).toBe("1");
    expect(stateOf(manager)).toMatchObject({ state: "unavailable", reason: "credential-rejected" });
    expect(await manager.sync(ID)).toEqual({ error: "connector-unavailable" });
    expect(kind.objects[0]?.changeCalls).toBe(2);
  });

  it("④ the state is judged before the answer returns, also when the store answers the second presence check late", async () => {
    const store = makeStore({ [name("token")]: "synthetic-token-1" });
    const kind = kindOf({
      getChanges: async () => {
        store.hasMode = "hang";
        throw new ConnectorCredentialError();
      },
    });
    const manager = await start([declared(["token"])], kind.factory, store);
    let answered = false;
    const sync = manager.sync(ID).then((answer) => ((answered = true), answer));
    await vi.advanceTimersByTimeAsync(CREDENTIAL_CHECK_TIMEOUT_MS - 1);
    expect(answered).toBe(false);
    expect(stateOf(manager)?.state).toBe("ready"); // not judged yet
    await vi.advanceTimersByTimeAsync(1);
    await sync;
    expect(stateOf(manager)).toMatchObject({
      state: "unavailable",
      reason: "credential-store-unavailable",
    });
  });

  it("⑤ a sync of an object that was replaced stops credential-unusable and changes nothing: the instance stays ready on the new object", async () => {
    const store = makeStore({ [name("token")]: "synthetic-token-1" });
    let release!: () => void;
    const kind = kindOf(
      {
        getChanges: async () => {
          await new Promise<void>((r) => (release = r));
          await kind.objects[0]?.context?.credentials.read("token"); // cut by then: refused
          return PAGE("1", false);
        },
      },
      {},
    );
    const manager = await start([declared(["token"])], kind.factory, store);
    const running = manager.sync(ID);
    await vi.advanceTimersByTimeAsync(0);
    expect((await manager.rebuild(ID))?.rebuild).toBe("done");
    const askedBefore = store.asked.length;
    release();
    expect(await running).toMatchObject({ stopped: "credential-unusable" });
    expect(store.asked.length).toBe(askedBefore); // an old object's stop is not judged at all
    expect(stateOf(manager)).toEqual(expect.objectContaining({ state: "ready" }));
    expect(stateOf(manager)?.reason).toBeUndefined();
    expect(await manager.sync(ID)).toMatchObject({ connectorId: ID });
    expect(kind.objects[1]?.changeCalls).toBe(1);
  });

  it("⑤ a rebuild that finishes while the stopped sync's judgement waits for the store keeps the instance ready on the new object", async () => {
    const store = makeStore({ [name("token")]: "synthetic-token-1" });
    const kind = kindOf(
      {
        getChanges: async () => {
          throw new ConnectorCredentialError();
        },
      },
      {},
    );
    const manager = await start([declared(["token"])], kind.factory, store);
    let open!: () => void;
    store.gateNext = new Promise<void>((r) => (open = r)); // the judgement's presence check waits
    const running = manager.sync(ID);
    await vi.advanceTimersByTimeAsync(0);
    expect((await manager.rebuild(ID))?.rebuild).toBe("done");
    open();
    expect(await running).toMatchObject({ stopped: "credential-unusable" });
    expect(stateOf(manager)).toMatchObject({ state: "ready" });
    expect(await manager.sync(ID)).toMatchObject({ connectorId: ID });
    expect(kind.objects[1]?.changeCalls).toBe(1);
  });

  it("⑦ an instance that declares no slot, or an object that read a slot it did not declare, is refused as a plain unavailable that the hourly recheck tries again", async () => {
    const store = makeStore({ [name("token")]: "synthetic-token-1" });
    const plain = kindOf({ initialize: refuse });
    const manager = await start([declared()], plain.factory, store);
    expect(stateOf(manager)).toEqual({ id: ID, kind: KIND, state: "unavailable" });
    expect(await manager.recheck(ID)).toBe("unavailable");
    expect(plain.objects).toHaveLength(2);
    const wrong = kindOf({
      initialize: async (c) => {
        await c.credentials.read("typo").catch(() => undefined);
        throw new ConnectorCredentialError();
      },
    });
    store.values.set(name("token", "w"), "synthetic-token-1");
    const second = await start([declared(["token"], "w")], wrong.factory, store);
    expect(stateOf(second, "w")).toEqual({
      id: "w",
      kind: KIND,
      state: "unavailable",
      credentials: [{ slot: "token", name: name("token", "w"), state: "present" }],
    });
    expect(await second.recheck("w")).toBe("unavailable");
    expect(wrong.objects).toHaveLength(2);
  });

  it("⑧ on a recheck a healthy initialize whose health says the credential was refused is credential-rejected; any other health text is a plain unavailable", async () => {
    const store = makeStore({ [name("token")]: "synthetic-token-1" });
    const kind = kindOf(
      { initialize: async () => Promise.reject(new Error("no")) },
      { health: async () => ({ state: "unavailable", reason: HEALTH_REASON_CREDENTIAL_REJECTED }) },
      { health: async () => ({ state: "unavailable", reason: "token expired" }) },
    );
    const manager = await start([declared(["token"])], kind.factory, store);
    expect(await manager.recheck(ID)).toBe("unavailable");
    expect(stateOf(manager)?.reason).toBe("credential-rejected");
    expect((await manager.rebuild(ID))?.summary.reason).toBeUndefined();
    expect(stateOf(manager)?.state).toBe("unavailable");
  });

  it("the thrown error's own text is never shown: a canary in the message, name and cause reaches no summary and no log line", async () => {
    const canary = "synthetic-canary-value-0002";
    const store = makeStore({ [name("token")]: canary });
    const leak = async (c: ConnectorContext) => {
      const value = await c.credentials.read("token");
      throw Object.assign(new ConnectorCredentialError(), {
        message: value,
        name: value,
        cause: new Error(value),
      });
    };
    const manager = await start([declared(["token"])], kindOf({ initialize: leak }).factory, store);
    await manager.recheck(ID);
    expect(JSON.stringify(manager.list()) + lines.join("\n")).not.toContain(canary);
  });
});

describe("connectors.credentials-recheck (I06-C8)", () => {
  it("① credential-missing is rechecked by the store alone and the factory is not called while it is still missing; ② once the value is there a new object makes it ready", async () => {
    const store = makeStore();
    const kind = kindOf({});
    const manager = await start([declared(["token"])], kind.factory, store);
    store.asked.length = 0;
    expect(await manager.recheck(ID)).toBe("unavailable");
    expect(store.asked).toEqual([name("token")]);
    expect(kind.objects).toHaveLength(0);
    store.values.set(name("token"), "synthetic-token-1");
    expect(await manager.recheck(ID)).toBe("ready");
    expect(kind.objects).toHaveLength(1);
    expect(stateOf(manager)?.reason).toBeUndefined();
  });

  it("③ a rejected instance is skipped by the hourly pass, whichever way it was refused; the other instances of the pass are rechecked", async () => {
    const store = makeStore({
      [name("token", "a", "ka")]: "v",
      [name("token", "b", "kb")]: "v",
      [name("token", "c", "kc")]: "v",
    });
    const refusedInitialize = kindOf({ initialize: refusedAfter("token") });
    const refusedSync = kindOf({ getChanges: async () => refuse() });
    const refusedHealth = kindOf(
      { initialize: async () => Promise.reject(new Error("no")) },
      { health: async () => ({ state: "unavailable", reason: HEALTH_REASON_CREDENTIAL_REJECTED }) },
    );
    const failing = kindOf({ initialize: async () => Promise.reject(new Error("no")) });
    const manager = await createConnectorManager(
      db,
      [
        { id: "a", kind: "ka", config: {}, credentials: ["token"] },
        { id: "b", kind: "kb", config: {}, credentials: ["token"] },
        { id: "c", kind: "kc", config: {}, credentials: ["token"] },
        { id: "d", kind: "kd", config: {} },
      ],
      {
        ka: refusedInitialize.factory,
        kb: refusedSync.factory,
        kc: refusedHealth.factory,
        kd: failing.factory,
      },
      { secrets: store },
    );
    await manager.sync("b"); // b's refusal comes from getChanges
    await manager.recheck("c"); // c's comes from the health answer
    expect(manager.list().map((s) => s.reason)).toEqual([
      "credential-rejected",
      "credential-rejected",
      "credential-rejected",
      undefined,
    ]);
    const counts = () =>
      [refusedInitialize, refusedSync, refusedHealth, failing].map((k) => k.objects.length);
    const before = counts();
    store.asked.length = 0;
    await recheckInstances({ db, manager, runner: { wake: async () => {} } });
    const after = counts();
    expect(after.slice(0, 3)).toEqual(before.slice(0, 3)); // no factory call for the three
    expect(store.asked).toEqual([]); // and no presence check
    expect(after[3]).toBe((before[3] as number) + 1); // the plain failure is rechecked
    expect(
      [refusedInitialize, refusedSync, refusedHealth].map((k) =>
        k.objects.map((o) => o.initializeCalls),
      ),
    ).toEqual([[1], [1], [1, 1]]);
  });

  it("④ started again on the same store, a rejected instance's initialize is called once", async () => {
    const store = makeStore({ [name("token")]: "synthetic-token-1" });
    const first = kindOf({ initialize: refusedAfter("token") });
    expect(stateOf(await start([declared(["token"])], first.factory, store))?.reason).toBe(
      "credential-rejected",
    );
    const second = kindOf({ initialize: refusedAfter("token") });
    await start([declared(["token"])], second.factory, store);
    expect(second.objects.map((o) => o.initializeCalls)).toEqual([1]);
  });

  it("⑤ credential-unreadable is tried again on a new object and is ready once the read works", async () => {
    const store = makeStore({ [name("token")]: "synthetic-token-1" });
    store.readMode = "unavailable";
    const unreadable = kindOf({
      initialize: async (c) => {
        await c.credentials.read("token").catch(() => undefined);
        await c.credentials.read("token"); // refused while the store is unavailable
      },
    });
    const manager = await start([declared(["token"])], unreadable.factory, store);
    expect(stateOf(manager)?.reason).toBe("credential-unreadable");
    store.readMode = "normal";
    expect(await manager.recheck(ID)).toBe("ready");
    expect(unreadable.objects).toHaveLength(2);
  });
});

describe("connectors.credentials-reload (I06-C9, I06-R12)", () => {
  const ready = async (
    scripts: Script[],
    values: Record<string, string> = { [name("token")]: "synthetic-token-1" },
  ) => {
    const store = makeStore(values);
    const kind = kindOf(...scripts);
    const manager = await start([declared(["token"])], kind.factory, store);
    return { store, kind, manager };
  };

  it("① a rejected instance whose value was changed is made again at once, is ready, and the answer is done", async () => {
    const { store, kind, manager } = await ready([{ initialize: refusedAfter("token") }, {}]);
    expect(stateOf(manager)?.reason).toBe("credential-rejected");
    store.values.set(name("token"), "synthetic-token-2");
    const answer = await manager.rebuild(ID);
    expect(answer).toMatchObject({ rebuild: "done", summary: { state: "ready" } });
    expect(kind.objects).toHaveLength(2);
  });

  it("② a ready instance is made again: the object is a new one and the old one's initialize is not called again; ③ with its value removed it is credential-missing", async () => {
    const { store, kind, manager } = await ready([{}]);
    expect((await manager.rebuild(ID))?.rebuild).toBe("done");
    expect(kind.objects).toHaveLength(2);
    expect(kind.objects.map((o) => o.initializeCalls)).toEqual([1, 1]);
    expect(await manager.sync(ID)).toMatchObject({ connectorId: ID });
    expect(kind.objects.map((o) => o.changeCalls)).toEqual([0, 1]);
    store.values.clear();
    expect((await manager.rebuild(ID))?.summary).toMatchObject({
      state: "unavailable",
      reason: "credential-missing",
    });
    expect(kind.objects).toHaveLength(2);
  });

  it("④ an id that is not known is undefined (the API answers not-found); an instance with no kind is skipped", async () => {
    const { manager } = await ready([{}]);
    expect(await manager.rebuild("nope")).toBeUndefined();
    const lost = await createConnectorManager(db, [declared(["token"])], {});
    expect((await lost.rebuild(ID))?.rebuild).toBe("skipped");
  });

  it("⑤ two more notices during a rebuild are answered queued, and exactly one more rebuild follows", async () => {
    let finish!: () => void;
    const { kind, manager } = await ready([
      {},
      { initialize: () => new Promise<void>((r) => (finish = r)) },
      {},
    ]);
    const first = manager.rebuild(ID);
    await vi.advanceTimersByTimeAsync(0);
    expect((await manager.rebuild(ID))?.rebuild).toBe("queued");
    expect((await manager.rebuild(ID))?.rebuild).toBe("queued");
    finish();
    expect((await first)?.rebuild).toBe("done");
    await vi.advanceTimersByTimeAsync(0);
    expect(kind.objects).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(CREDENTIAL_RETRY_MIN_MS);
    expect(kind.objects).toHaveLength(3);
  });

  it("⑦ a notice during the hourly recheck is queued and rebuilds once after it, even when the recheck made the instance ready; the instance never has more than two objects unfinished; a rebuild under way holds the hourly recheck back", async () => {
    let finishRecheck!: () => void;
    const pendingInit = () => new Promise<void>((r) => (finishRecheck = r));
    const failing = async () => Promise.reject(new Error("no"));
    const { kind, manager } = await ready([
      { initialize: failing },
      { initialize: pendingInit },
      {},
      {},
    ]);
    const recheck = manager.recheck(ID);
    await vi.advanceTimersByTimeAsync(0);
    expect((await manager.rebuild(ID))?.rebuild).toBe("queued");
    finishRecheck();
    expect(await recheck).toBe("ready");
    await vi.advanceTimersByTimeAsync(0);
    expect(kind.objects).toHaveLength(3); // start, the recheck's, the rebuild the notice owed
    expect(stateOf(manager)?.state).toBe("ready");
    // a rebuild under way: the hourly recheck of an instance that is not ready skips it
    const slowKind = kindOf(
      { initialize: async () => Promise.reject(new Error("no")) },
      { initialize: never },
      {},
    );
    const store = makeStore({ [name("token", "s")]: "v" });
    const second = await start([declared(["token"], "s")], slowKind.factory, store);
    void second.rebuild("s");
    await vi.advanceTimersByTimeAsync(0);
    expect(await second.recheck("s")).toBe("unavailable");
    expect(slowKind.objects).toHaveLength(2);
  });

  it("⑧ ten notices in the gap make two objects in all: the first at once and one when the gap has passed", async () => {
    const { kind, manager } = await ready([{ initialize: refusedAfter("token") }]);
    expect((await manager.rebuild(ID))?.rebuild).toBe("done");
    expect(kind.objects).toHaveLength(2);
    for (let i = 0; i < 9; i++) expect((await manager.rebuild(ID))?.rebuild).toBe("queued");
    await vi.advanceTimersByTimeAsync(CREDENTIAL_RETRY_MIN_MS - 1);
    expect(kind.objects).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(kind.objects).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(10 * CREDENTIAL_RETRY_MIN_MS);
    expect(kind.objects).toHaveLength(3);
  });

  it("⑧ a ready instance has no gap: every notice makes an object", async () => {
    const { kind, manager } = await ready([{}]);
    for (let i = 0; i < 4; i++) expect((await manager.rebuild(ID))?.rebuild).toBe("done");
    expect(kind.objects).toHaveLength(5);
  });

  it("⑧ a notice in the gap and a rebuild under way: one rebuild, after the later of the two", async () => {
    let finish!: () => void;
    const { kind, manager } = await ready([
      { initialize: refusedAfter("token") },
      { initialize: refusedAfter("token") },
      {
        initialize: async (c) => (
          await new Promise<void>((r) => (finish = r)),
          refusedAfter("token")(c)
        ),
      },
      {},
    ]);
    expect((await manager.rebuild(ID))?.rebuild).toBe("done"); // object 2, rejected: the gap starts
    await vi.advanceTimersByTimeAsync(CREDENTIAL_RETRY_MIN_MS);
    const third = manager.rebuild(ID); // object 3 starts at once and takes a while
    await vi.advanceTimersByTimeAsync(0);
    expect((await manager.rebuild(ID))?.rebuild).toBe("queued");
    await vi.advanceTimersByTimeAsync(5_000);
    finish();
    await third;
    await vi.advanceTimersByTimeAsync(0);
    expect(kind.objects).toHaveLength(3); // the gap (started with object 3) has not passed
    await vi.advanceTimersByTimeAsync(CREDENTIAL_RETRY_MIN_MS);
    expect(kind.objects).toHaveLength(4);
  });

  it("⑧ an instance whose rebuilds ended late RECHECK_LATE_LIMIT times is skipped, no object is made", async () => {
    const releases: Array<() => void> = [];
    const slow = () => new Promise<void>((r) => releases.push(r));
    const { kind, manager } = await ready([{}, { initialize: slow }]);
    for (let i = 0; i < RECHECK_LATE_LIMIT; i++) {
      const rebuild = manager.rebuild(ID);
      await vi.advanceTimersByTimeAsync(RECHECK_TIMEOUT_MS);
      await rebuild;
      releases.pop()?.();
      await vi.advanceTimersByTimeAsync(0);
    }
    const made = kind.objects.length;
    expect((await manager.rebuild(ID))?.rebuild).toBe("skipped");
    expect(kind.objects).toHaveLength(made);
    expect(events().filter((e) => e.event === "connector-recheck-abandoned")).toHaveLength(1);
  });

  it("⑨ a rebuild of a ready instance that passes the limit is done, the instance is a plain unavailable, the old accessor is cut, the late result changes nothing, and a later recheck brings it back", async () => {
    let release!: () => void;
    const { store, kind, manager } = await ready([
      {},
      { initialize: () => new Promise<void>((r) => (release = r)) },
      {},
    ]);
    const rebuild = manager.rebuild(ID);
    await vi.advanceTimersByTimeAsync(RECHECK_TIMEOUT_MS);
    expect((await rebuild)?.rebuild).toBe("done");
    expect(stateOf(manager)).toMatchObject({ state: "unavailable" });
    expect(stateOf(manager)?.reason).toBeUndefined();
    store.reads.length = 0;
    await expect(kind.objects[0]?.context?.credentials.read("token")).rejects.toBeInstanceOf(
      ConnectorCredentialError,
    );
    expect(store.reads).toEqual([]);
    expect(await manager.sync(ID)).toEqual({ error: "connector-unavailable" });
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(stateOf(manager)).toMatchObject({ state: "unavailable" });
    expect(await manager.recheck(ID)).toBe("ready");
    expect(kind.objects).toHaveLength(3);
  });

  it("⑨ a rebuild of an instance that was not ready keeps its state and reason when it passes the limit", async () => {
    const { manager } = await ready([{ initialize: refusedAfter("token") }, { initialize: never }]);
    const rebuild = manager.rebuild(ID);
    await vi.advanceTimersByTimeAsync(RECHECK_TIMEOUT_MS);
    expect((await rebuild)?.summary.reason).toBe("credential-rejected");
  });

  it("⑨ two late rebuilds, one in time, then two late again: the count started over and the instance is not given up", async () => {
    const releases: Array<() => void> = [];
    let n = 0;
    const kind = kindOf({});
    const store = makeStore({ [name("token")]: "v" });
    const factory: ConnectorFactory = () => {
      const object = kind.factory();
      const index = n++;
      const original = object.initialize.bind(object);
      if (index === 0 || index === 3) return object;
      object.initialize = async (config, context) => {
        await new Promise<void>((r) => releases.push(r));
        return original(config, context);
      };
      return object;
    };
    const manager = await start([declared(["token"])], factory, store);
    const late = async () => {
      const rebuild = manager.rebuild(ID);
      await vi.advanceTimersByTimeAsync(RECHECK_TIMEOUT_MS);
      await rebuild;
      releases.pop()?.();
      await vi.advanceTimersByTimeAsync(0);
    };
    await late();
    await late();
    expect((await manager.rebuild(ID))?.rebuild).toBe("done"); // object 3, in time
    await late();
    await late();
    const last = manager.rebuild(ID);
    await vi.advanceTimersByTimeAsync(RECHECK_TIMEOUT_MS);
    expect((await last)?.rebuild).toBe("done"); // not skipped: the count started over at the rebuild in time
    expect(events().filter((e) => e.event === "connector-recheck-abandoned")).toEqual([]);
  });
});

describe("connectors.credentials-list (I06-C10)", () => {
  it("a declaring instance shows each slot with its stored name and the last presence answer; one that declares nothing has no field", async () => {
    const store = makeStore({ [name("a")]: "v" });
    const manager = await start(
      [declared(["a", "b"]), declared(undefined, "plain")],
      kindOf({}).factory,
      store,
    );
    expect(stateOf(manager)?.credentials).toEqual([
      { slot: "a", name: name("a"), state: "present" },
      { slot: "b", name: name("b"), state: "missing" },
    ]);
    expect(stateOf(manager, "plain")).not.toHaveProperty("credentials");
    store.values.set(name("b"), "v");
    await manager.recheck(ID);
    expect(stateOf(manager)?.credentials?.map((c) => c.state)).toEqual(["present", "present"]);
    const without = await start([declared(["a"])], kindOf({}).factory);
    expect(stateOf(without)?.credentials?.map((c) => c.state)).toEqual(["unavailable"]);
  });
});

describe("connectors.credentials-kept (I06-C12)", () => {
  it("an instance left out of the registration is never deleted from the store; the same id of another kind does not get the old value", async () => {
    const store = makeStore({ [name("token")]: "synthetic-token-1" });
    const kind = kindOf({});
    await createConnectorManager(db, [], { [KIND]: kind.factory }, { secrets: store });
    expect(store.deletes).toBe(0);
    expect([...store.values.keys()]).toEqual([name("token")]);
    expect(store.reads).toEqual([]);
    expect(stateOf(await start([declared(["token"])], kind.factory, store))?.state).toBe("ready");
    const other = kindOf({});
    const manager = await start(
      [{ id: ID, kind: "k2", config: {}, credentials: ["token"] }],
      other.factory,
      store,
      "k2",
    );
    expect(stateOf(manager)).toMatchObject({ reason: "credential-missing" });
    expect(other.objects).toHaveLength(0);
  });
});

describe("connectors.credentials-rework (review fixes)", () => {
  const ok = { [name("token")]: "synthetic-token-1" };
  const plainFailure = async () => Promise.reject(new Error("no"));

  it("B1 a rebuild past its limit: the hung new object's accessor is cut, and reads nothing", async () => {
    const store = makeStore(ok);
    const kind = kindOf({}, { initialize: never });
    const manager = await start([declared(["token"])], kind.factory, store);
    const rebuild = manager.rebuild(ID);
    await vi.advanceTimersByTimeAsync(RECHECK_TIMEOUT_MS);
    await rebuild;
    store.reads.length = 0;
    await expect(kind.objects[1]?.context?.credentials.read("token")).rejects.toBeInstanceOf(
      ConnectorCredentialError,
    );
    expect(store.reads).toEqual([]);
  });

  it("B1 a recheck whose turn the caller closed: the hung new object's accessor is cut, before and after the store answers", async () => {
    const store = makeStore();
    const kind = kindOf({ initialize: never });
    const manager = await start([declared(["token"])], kind.factory, store);
    store.values.set(name("token"), "synthetic-token-1");
    const turn = { open: true };
    void manager.recheck(ID, turn);
    await vi.advanceTimersByTimeAsync(10);
    const context = kind.objects[0]?.context as ConnectorContext;
    // asked while the turn is open: it waits for the store, then the turn closes before the answer is used
    let answer!: (v: SecretRead) => void;
    store.read = () => new Promise<SecretRead>((r) => (answer = r));
    const inFlight = context.credentials.read("token");
    await vi.advanceTimersByTimeAsync(0);
    turn.open = false;
    answer({ state: "present", value: "synthetic-token-1" });
    await expect(inFlight).rejects.toBeInstanceOf(ConnectorCredentialError);
    store.reads.length = 0;
    await expect(context.credentials.read("token")).rejects.toBeInstanceOf(
      ConnectorCredentialError,
    );
    expect(store.reads).toEqual([]);
  });

  it("B2 (I05-R13 kept) an initialize that never settles holds the instance's slot: no third object and the notice is queued; one that settles late frees it (the late-limit test above revives the instance)", async () => {
    const store = makeStore(ok);
    const kind = kindOf({}, { initialize: never }, {});
    const manager = await start([declared(["token"])], kind.factory, store);
    const rebuild = manager.rebuild(ID);
    await vi.advanceTimersByTimeAsync(RECHECK_TIMEOUT_MS);
    await rebuild;
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(await manager.recheck(ID)).toBe("unavailable");
    expect((await manager.rebuild(ID))?.rebuild).toBe("queued");
    expect(kind.objects).toHaveLength(2);
  });

  it("A2 an invalid declaration stays invalid on a recheck and a rebuild: no object, the state does not change", async () => {
    const store = makeStore(ok);
    const kind = kindOf({});
    const manager = await start([declared(["Bad Slot"])], kind.factory, store);
    expect(await manager.recheck(ID)).toBe("unavailable");
    expect((await manager.rebuild(ID))?.rebuild).toBe("skipped");
    expect(kind.objects).toHaveLength(0);
    expect(stateOf(manager)).toMatchObject({ state: "unavailable" });
  });

  it("C-F4 a rebuild that passes its limit after a stop judged the instance rejected leaves it rejected and skipped by the hourly recheck", async () => {
    const store = makeStore(ok);
    const kind = kindOf(
      {
        getChanges: async () => {
          throw new ConnectorCredentialError();
        },
      },
      { initialize: never },
      {},
    );
    const manager = await start([declared(["token"])], kind.factory, store);
    const rebuild = manager.rebuild(ID);
    await vi.advanceTimersByTimeAsync(0);
    expect(await manager.sync(ID)).toMatchObject({ stopped: "credential-unusable" });
    expect(stateOf(manager)?.reason).toBe("credential-rejected");
    await vi.advanceTimersByTimeAsync(RECHECK_TIMEOUT_MS);
    expect((await rebuild)?.summary.reason).toBe("credential-rejected");
    expect(stateOf(manager)?.reason).toBe("credential-rejected");
    expect(await manager.recheck(ID)).toBe("unavailable");
    expect(kind.objects).toHaveLength(2);
  });

  it("C-F2 while the stopped sync's judgement waits for the store no second sync reaches the origin", async () => {
    const store = makeStore(ok);
    const kind = kindOf({
      getChanges: async () => {
        throw new ConnectorCredentialError();
      },
    });
    const manager = await start([declared(["token"])], kind.factory, store);
    let open!: () => void;
    store.gateNext = new Promise<void>((r) => (open = r));
    const first = manager.sync(ID);
    await vi.advanceTimersByTimeAsync(0);
    expect(await manager.sync(ID)).toMatchObject({ stopped: "instance-busy" });
    open();
    expect(await first).toMatchObject({ stopped: "credential-unusable" });
    expect(kind.objects[0]?.changeCalls).toBe(1);
  });

  it("C-F5 the gap starts when the rebuild started, not when it ended", async () => {
    let finish!: () => void;
    const store = makeStore(ok);
    const kind = kindOf(
      { initialize: refusedAfter("token") },
      {
        initialize: async (c) => {
          await new Promise<void>((r) => (finish = r));
          await refusedAfter("token")(c);
        },
      },
      {},
    );
    const manager = await start([declared(["token"])], kind.factory, store);
    const first = manager.rebuild(ID); // starts at t0, takes 20 s, ends rejected
    await vi.advanceTimersByTimeAsync(20_000);
    finish();
    expect((await first)?.summary.reason).toBe("credential-rejected");
    expect((await manager.rebuild(ID))?.rebuild).toBe("queued");
    await vi.advanceTimersByTimeAsync(CREDENTIAL_RETRY_MIN_MS - 20_000 - 1);
    expect(kind.objects).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(kind.objects).toHaveLength(3);
  });

  it.each(["yes", {}, 1, null])(
    "B4 a presence answer of %j is not a presence: credential-store-unavailable, no object",
    async (garbage) => {
      const store = makeStore(ok);
      store.has = (async (n: string) => (store.asked.push(n), garbage)) as never;
      const kind = kindOf({});
      const manager = await start([declared(["token"])], kind.factory, store);
      expect(stateOf(manager)).toMatchObject({ reason: "credential-store-unavailable" });
      expect(stateOf(manager)?.credentials?.map((c) => c.state)).toEqual(["unavailable"]);
      expect(kind.objects).toHaveLength(0);
    },
  );

  it("B5 the object whose sync was refused reads nothing more", async () => {
    const store = makeStore(ok);
    const kind = kindOf({
      getChanges: async () => {
        throw new ConnectorCredentialError();
      },
    });
    const manager = await start([declared(["token"])], kind.factory, store);
    await manager.sync(ID);
    store.reads.length = 0;
    await expect(kind.objects[0]?.context?.credentials.read("token")).rejects.toBeInstanceOf(
      ConnectorCredentialError,
    );
    expect(store.reads).toEqual([]);
  });

  it("A1 the instance's turning ready is announced once, for a rebuild and for a recheck, and not for one that fails", async () => {
    const store = makeStore(ok);
    const readyIds: string[] = [];
    const kind = kindOf({ initialize: plainFailure }, {}, {}, { initialize: plainFailure });
    const manager = await createConnectorManager(
      db,
      [declared(["token"])],
      { [KIND]: kind.factory },
      {
        secrets: store,
        onReady: (id) => void readyIds.push(id),
      },
    );
    expect(readyIds).toEqual([]);
    expect(await manager.recheck(ID)).toBe("ready");
    expect(readyIds).toEqual([ID]);
    await manager.rebuild(ID);
    expect(readyIds).toEqual([ID, ID]);
    await manager.rebuild(ID); // object 4 fails
    expect(readyIds).toEqual([ID, ID]);
  });
});
