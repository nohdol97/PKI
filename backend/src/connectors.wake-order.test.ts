// A page with a new version and a deletion (review B4, V02-R13): the runner is woken once, after the
// page's notices are delivered, so a proposing engine knows what is extracted; the deletion's removal jobs
// (I04-R12) are picked up by that same wake. A page with only a deletion wakes at once.
import type { ChangeSet, Connector } from "@pki/contracts";
import { migrate, registerConnectorInstance, saveSourceRecord, type SqlDriver } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncConnector } from "./connectors.ts";

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c", "k");
  saveSourceRecord(db, "c", { externalId: "x", title: "x", body: "본문" });
});
afterEach(() => db.close());

const connector = (changes: ChangeSet["changes"]): Connector => ({
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
  initialize: async () => {},
  healthCheck: async () => ({ state: "ok" }),
  getChanges: async () => ({ changes, nextCursor: "1", hasMore: false }),
  getDocument: async () => null,
});
const upsert = {
  kind: "upsert" as const,
  record: {
    namespace: "",
    externalId: "n",
    revision: 1,
    schemaVersion: 2 as const,
    title: "n",
    body: "새 본문",
  },
};
const remove = {
  kind: "delete" as const,
  namespace: "",
  externalId: "x",
  revision: 2,
  at: "2026-11-21T00:00:00Z",
};

describe("the runner's wake after a page", () => {
  it("on a page with a new version and a deletion comes after the notices are delivered", async () => {
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const projections = {
      notify: async () => {
        order.push("notify");
        await held;
        order.push("delivered");
      },
    };
    const runner = { wake: vi.fn(async () => void order.push("wake")) };
    const done = syncConnector(db, "c", "k", connector([upsert, remove]), { projections, runner });
    await done;
    await Promise.resolve();
    expect(order).toEqual(["notify"]); // not woken before the delivery
    release();
    await vi.waitFor(() => expect(order).toEqual(["notify", "delivered", "wake"]));
    expect(runner.wake).toHaveBeenCalledTimes(1);
  });

  it("on a page with only a deletion wakes the runner for the removal jobs", async () => {
    const runner = { wake: vi.fn(async () => {}) };
    await syncConnector(db, "c", "k", connector([remove]), { runner });
    expect(runner.wake).toHaveBeenCalledTimes(1);
  });
});
