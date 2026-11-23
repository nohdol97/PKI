// I02B-T06 (I02B-R41, C33 "여는 길은 하나다", I06-C4 ⑦): the entry that adds an instance while the backend runs
// makes and initializes the Connector in the one place every other path uses (`openConnector`), so its
// `initialize` gets the second argument (`context`) and the declared slots are asked about first.
import type { Connector, ConnectorContext } from "@pki/contracts";
import { migrate, type SqlDriver } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { memoryDbTemplate } from "@pki/testkit";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConnectorManager, type ConnectorFactory } from "./connectors.ts";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);
let db: SqlDriver;
beforeEach(() => {
  db = freshDb();
});
afterEach(() => db.close());

/** A Connector double that keeps the context its `initialize` got. */
function kind() {
  const seen = { made: 0, context: undefined as ConnectorContext | undefined };
  const factory: ConnectorFactory = () => {
    seen.made++;
    return {
      manifest: {
        type: "k",
        schemaVersion: 2,
        capabilities: {
          incremental: true,
          deletes: false,
          accessScope: false,
          fullRescan: true,
          deletionsOnRescan: false,
        },
      },
      initialize: async (_config: unknown, context?: ConnectorContext) => {
        seen.context = context;
      },
      healthCheck: async () => ({ state: "ok" as const }),
      getChanges: async () => ({ changes: [], nextCursor: "1", hasMore: false }),
      getDocument: async () => null,
    } as unknown as Connector;
  };
  return { seen, factory };
}

describe("connectors.add-instance (I02B-C33, I06-C4 ⑦): one way to open a Connector", () => {
  it("an added instance is ready, its initialize got the context, and it can be removed again", async () => {
    const k = kind();
    const manager = await createConnectorManager(db, [], { k: k.factory });
    expect(await manager.addInstance({ id: "x", kind: "k", config: {} })).toEqual({
      id: "x",
      kind: "k",
      state: "ready",
    });
    expect(k.seen.context?.credentials).toBeDefined();
    expect(manager.list().map((i) => i.id)).toEqual(["x"]);
    expect(manager.configOf("x")).toEqual({});

    expect(manager.removeInstance("x")).toBe(true);
    expect(manager.list()).toEqual([]);
    expect(manager.removeInstance("x")).toBe(false);
    expect(await manager.sync("x")).toEqual({ error: "not-found" });
  });

  it("the declared slots are asked about before the Connector is made: with no store the instance is unavailable and no object exists", async () => {
    const k = kind();
    const manager = await createConnectorManager(db, [], { k: k.factory });
    const summary = await manager.addInstance({
      id: "x",
      kind: "k",
      config: {},
      credentials: ["token"],
    });
    expect(summary).toMatchObject({ state: "unavailable", reason: "credential-store-unavailable" });
    expect(k.seen.made).toBe(0);
  });

  it("a kind this build does not have is an unavailable instance, not a throw", async () => {
    const manager = await createConnectorManager(db, [], {});
    expect(await manager.addInstance({ id: "x", kind: "nope", config: {} })).toMatchObject({
      state: "unavailable",
    });
  });

  it("makes a Connector in exactly one place of the manager's source", () => {
    const source = readFileSync(new URL("./connectors.ts", import.meta.url), "utf8");
    expect(source.match(/\bfactory\(\)/g)).toHaveLength(1);
  });
});
