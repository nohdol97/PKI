// I01-T03: the Connector management module's sync v2 (I01-R14, R16 to R21). One
// describe per proof test of the spec's table (`sync.*`). The origin system is the
// scripted Connector of @pki/testkit, which stands in for pages, faults, expiry,
// reordering and cancellation; nothing here reached a real origin system.
import {
  ConnectorError,
  ConnectorListResponseSchema,
  ConnectorRateLimitError,
  SyncResponseSchema,
  type Change,
  type ChangeSet,
  type Connector,
  type ConnectorCapabilities,
} from "@pki/contracts";
import { readCursor, type SqlDriver } from "@pki/storage";
import { ScriptedConnector, dirTemplate } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCanonicalDb } from "./composition.ts";
import { createConnectorManager, tryLockInstance, type ConnectorManager } from "./connectors.ts";
import type { Clock } from "./clock.ts";

const seedDataDir = dirTemplate((path) => openCanonicalDb(path).close());

const AT = "2026-11-22T00:00:00Z";
const CANARY = "CANARY-origin-text-7731";

let dir: string;
let db: SqlDriver;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-sync2-"));
  seedDataDir(join(dir, "data"));
  db = openCanonicalDb(join(dir, "data"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const up = (
  id: string,
  revision = 1,
  extra: Record<string, unknown> = {},
  body = `body of ${id}`,
): Change => ({
  kind: "upsert",
  record: {
    namespace: "",
    externalId: id,
    revision,
    schemaVersion: 2,
    title: `title of ${id}`,
    body,
    ...extra,
  },
});
const del = (id: string, revision: number): Change => ({
  kind: "delete",
  namespace: "",
  externalId: id,
  revision,
  at: AT,
});

/** A clock that does not wait: it records each sleep and moves its time by it. */
function fakeClock() {
  let wall = 0;
  const slept: number[] = [];
  const clock: Clock = {
    now: () => wall,
    monotonic: () => wall,
    sleep: async (ms) => {
      slept.push(ms);
      wall += ms;
    },
  };
  return { slept, clock };
}

async function manager(
  connector: Connector,
  config: unknown,
  clock: Clock = fakeClock().clock,
  id = "s",
): Promise<ConnectorManager> {
  return createConnectorManager(
    db,
    [{ id, kind: "scripted", config }],
    { scripted: () => connector },
    { clock },
  );
}

const caps = (patch: Partial<ConnectorCapabilities> = {}) => ({ capabilities: patch });
const counts = () =>
  ["sources", "source_versions"].map((t) => db.all(`SELECT count(*) AS n FROM ${t}`)[0]?.n);
const pending = (id = "s") =>
  db.all(
    "SELECT rescan_pending AS p, deletions_may_be_missed AS m FROM connector_instances WHERE id = ?",
    [id],
  )[0];

/** A Connector replaying whatever pages the function gives, for shapes the script cannot make. */
function stub(pages: (cursor: string | null) => ChangeSet | Promise<ChangeSet>): Connector {
  return {
    manifest: {
      type: "stub",
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
    getChanges: async (cursor) => pages(cursor),
    getDocument: async () => null,
  };
}

const failOnInsertOf = (externalId: string) =>
  db.exec(`CREATE TRIGGER boom BEFORE INSERT ON sources WHEN new.external_id = '${externalId}'
    BEGIN SELECT RAISE(ABORT, '${CANARY}'); END`);

describe("sync.checkpoint", () => {
  const entries = ["a", "b", "c", "d"].map((id) => up(id));

  it("① a page whose storage fails stops the sync as storage-failed with only the first page and its cursor stored", async () => {
    failOnInsertOf("c");
    const m = await manager(new ScriptedConnector(), { entries });
    const result = await m.sync("s");
    expect(result).toMatchObject({ stopped: "storage-failed", created: 2, received: 2 });
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(counts()).toEqual([2, 2]);
    expect(readCursor(db, "s")).toBe("offset:2");
  });

  it("② syncing again continues from the second page, and the count is what it should be", async () => {
    failOnInsertOf("c");
    const connector = new ScriptedConnector();
    const m = await manager(connector, { entries });
    await m.sync("s");
    db.exec("DROP TRIGGER boom");
    const again = await m.sync("s");
    expect(again).toMatchObject({ created: 2, received: 2 });
    expect(again).not.toHaveProperty("stopped");
    // it resumed at the stored cursor, not from the start
    expect(connector.calls.map((c) => c.cursor)).toEqual([null, "offset:2", "offset:2"]);
    expect(counts()).toEqual([4, 4]);
    expect(readCursor(db, "s")).toBe("offset:4");
  });

  it("③ a cancel during the second page stops as aborted with the cursor after the first", async () => {
    const controller = new AbortController();
    const m = await manager(new ScriptedConnector(), {
      entries,
      beforeAnswer: ({ cursor }: { cursor: string | null }) => {
        if (cursor === "offset:2") controller.abort();
      },
    });
    const result = await m.sync("s", { signal: controller.signal });
    expect(result).toMatchObject({ stopped: "aborted", created: 2 });
    expect(counts()).toEqual([2, 2]);
    expect(readCursor(db, "s")).toBe("offset:2");
  });

  it("a page that arrives after the cut is not stored", async () => {
    const controller = new AbortController();
    const m = await manager(
      stub(async () => {
        controller.abort();
        return { changes: [up("a")], nextCursor: "1", hasMore: false };
      }),
      {},
    );
    expect(await m.sync("s", { signal: controller.signal })).toMatchObject({
      stopped: "aborted",
      created: 0,
    });
    expect(counts()).toEqual([0, 0]);
    expect(readCursor(db, "s")).toBeNull();
  });

  it("a signal already cut does not call the Connector (review W1)", async () => {
    let calls = 0;
    const m = await manager(
      stub(() => {
        calls++;
        return { changes: [], nextCursor: "1", hasMore: false };
      }),
      {},
    );
    expect(await m.sync("s", { signal: AbortSignal.abort() })).toMatchObject({
      stopped: "aborted",
    });
    expect(calls).toBe(0);
  });
});

describe("sync.pagination", () => {
  it("a page with more than `limit` changes is invalid-page and stores nothing", async () => {
    const m = await manager(
      stub(() => ({
        changes: Array.from({ length: 101 }, (_, i) => up(`x${i}`)),
        nextCursor: "1",
        hasMore: false,
      })),
      {},
    );
    expect(await m.sync("s")).toMatchObject({ stopped: "invalid-page", created: 0 });
    expect(counts()).toEqual([0, 0]);
    expect(readCursor(db, "s")).toBeNull();
  });

  it("a page of the wrong outer shape is invalid-page, whatever the rest says", async () => {
    const m = await manager(
      stub(() => ({ changes: "nope", nextCursor: "1", hasMore: false }) as unknown as ChangeSet),
      {},
    );
    expect(await m.sync("s")).toMatchObject({ stopped: "invalid-page" });
    const unknownCode = stub(
      () =>
        ({
          changes: [],
          nextCursor: "1",
          hasMore: false,
          rejected: [{ at: "line:1", code: "whatever" }],
        }) as unknown as ChangeSet,
    );
    expect(await (await manager(unknownCode, {})).sync("s")).toMatchObject({
      stopped: "invalid-page",
    });
  });

  it("hasMore without a moving cursor is no-progress", async () => {
    const m = await manager(
      stub((cursor) =>
        cursor === null
          ? { changes: [up("a")], nextCursor: "1", hasMore: true }
          : { changes: [], nextCursor: "1", hasMore: true },
      ),
      {},
    );
    expect(await m.sync("s")).toMatchObject({ stopped: "no-progress", created: 1 });
    expect(readCursor(db, "s")).toBe("1");
  });
});

describe("sync.capability-violation", () => {
  it("a delete from a Connector that does not declare deletes is refused, and the rest of the page is stored", async () => {
    const m = await manager(new ScriptedConnector(caps({ deletes: false })), {
      entries: [up("a"), del("b", 2), up("c")],
      pageSize: 10,
    });
    const result = await m.sync("s");
    expect(result).toMatchObject({ created: 2, rejectedCount: 1, received: 3 });
    expect(result).toMatchObject({ rejected: [{ at: "change:1", code: "capability-violation" }] });
    expect(counts()).toEqual([2, 2]);
    expect(readCursor(db, "s")).toBe("offset:3");
  });

  it("an upsert without a scope from a Connector declaring accessScope is refused; one with a scope is stored", async () => {
    const m = await manager(new ScriptedConnector(caps({ accessScope: true })), {
      entries: [up("a"), up("b", 1, { accessScope: ["team"] })],
      pageSize: 10,
    });
    expect(await m.sync("s")).toMatchObject({
      created: 1,
      rejected: [{ at: "change:0", code: "capability-violation" }],
    });
  });

  it("a scope or a scope-change from a Connector not declaring accessScope is refused", async () => {
    const scopeChange: Change = {
      kind: "scope-change",
      namespace: "",
      externalId: "a",
      revision: 2,
      accessScope: ["team"],
      at: AT,
    };
    const m = await manager(new ScriptedConnector(), {
      entries: [up("a"), up("b", 1, { accessScope: ["team"] }), scopeChange],
      pageSize: 10,
    });
    const result = await m.sync("s");
    expect(result).toMatchObject({ created: 1 });
    expect(result).toMatchObject({
      rejected: [
        { at: "change:1", code: "capability-violation" },
        { at: "change:2", code: "capability-violation" },
      ],
    });
  });

  it("a record failing the schema or its block rules is refused alone, by its place", async () => {
    const m = await manager(new ScriptedConnector(), {
      entries: [
        up("a"),
        up("b", 1, { dataClass: "synthetic" }),
        up("c", 1, { blocks: [{ start: 0, end: 99, locator: { format: "txt", line: 1 } }] }),
        up("d", 1, { blocks: [{ start: 0, end: 4, locator: { format: "txt", line: 1 } }] }),
      ],
      pageSize: 10,
    });
    expect(await m.sync("s")).toMatchObject({
      created: 2,
      rejected: [
        { at: "change:1", code: "schema" },
        { at: "change:2", code: "invalid-blocks" },
      ],
    });
    expect(counts()).toEqual([2, 2]);
  });

  it("a block naming an attachment past the list is invalid-blocks and the rest is stored (I02C-C2)", async () => {
    const attachments = [
      { name: "a.pdf", mediaType: "application/pdf", size: 1 },
      { name: "b.pdf", mediaType: "application/pdf", size: 2 },
    ];
    const m = await manager(new ScriptedConnector(), {
      entries: [
        up("a"),
        up("b", 1, {
          attachments,
          blocks: [{ start: 0, end: 4, attachment: 2, locator: { format: "pdf", page: 1 } }],
        }),
      ],
      pageSize: 10,
    });
    expect(await m.sync("s")).toMatchObject({
      created: 1,
      rejected: [{ at: "change:1", code: "invalid-blocks" }],
    });
  });

  it("the same revision with other content is refused as revision-conflict, and stores nothing of it", async () => {
    const m = await manager(new ScriptedConnector(), {
      entries: [up("a", 2), up("a", 2, {}, "other body"), up("b")],
      pageSize: 10,
    });
    expect(await m.sync("s")).toMatchObject({
      created: 2,
      rejected: [{ at: "change:1", code: "revision-conflict" }],
    });
    expect(counts()).toEqual([2, 2]);
  });
});

describe("sync.redaction", () => {
  it("keeps a Connector error's text out of the result, whichever kind it is", async () => {
    for (const raise of [
      new ConnectorError(CANARY, { retryable: false }),
      new ConnectorError(CANARY, { retryable: true }),
      new ConnectorRateLimitError(CANARY, { retryAfterMs: 5 }),
      new Error(CANARY),
    ]) {
      const m = await manager(new ScriptedConnector(), {
        entries: [up("a")],
        faults: [{ raise, times: 9 }],
      });
      const result = await m.sync("s");
      expect(result).toHaveProperty("stopped");
      expect(JSON.stringify(result)).not.toContain(CANARY);
    }
  });

  it("replaces a rejection's position that is not a short kind and number by change:<n>", async () => {
    const m = await manager(new ScriptedConnector(), {
      entries: [
        up("a"),
        { kind: "rejected", at: `line:12 ${CANARY}`, code: "schema" },
        { kind: "rejected", at: "line:7", code: "invalid-json" },
      ],
      pageSize: 10,
    });
    const result = await m.sync("s");
    expect(result).toMatchObject({
      rejected: [
        { at: "change:0", code: "schema" },
        { at: "line:7", code: "invalid-json" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it("a storage error's text is not in the result either", async () => {
    failOnInsertOf("a");
    const result = await (await manager(new ScriptedConnector(), { entries: [up("a")] })).sync("s");
    expect(result).toMatchObject({ stopped: "storage-failed" });
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });
});

describe("sync.backoff", () => {
  const rate = (retryAfterMs: number) => new ConnectorRateLimitError("limit", { retryAfterMs });
  const entries = ["a", "b", "c"].map((id) => up(id));

  it("① after a rate limit of 1 second it asks again with the same cursor once, having waited 1 second", async () => {
    const { clock, slept } = fakeClock();
    const connector = new ScriptedConnector();
    const m = await manager(connector, { entries, faults: [{ raise: rate(1000) }] }, clock);
    expect(await m.sync("s")).toMatchObject({ created: 3 });
    expect(connector.calls.slice(0, 2).map((c) => c.cursor)).toEqual([null, null]);
    expect(slept).toEqual([1000]);
  });

  it("② waits at most 30 seconds, whatever retryAfterMs says", async () => {
    const { clock, slept } = fakeClock();
    const m = await manager(
      new ScriptedConnector(),
      { entries, faults: [{ raise: rate(60_000) }] },
      clock,
    );
    await m.sync("s");
    expect(slept).toEqual([30_000]);
  });

  it("③ three rate limits stop as rate-limited, with the last retryAfterMs", async () => {
    const { clock, slept } = fakeClock();
    const faults = [{ raise: rate(1000) }, { raise: rate(2000) }, { raise: rate(90_000) }];
    const connector = new ScriptedConnector();
    const m = await manager(connector, { entries, faults }, clock);
    expect(await m.sync("s")).toMatchObject({ stopped: "rate-limited", retryAfterMs: 90_000 });
    expect(connector.calls).toHaveLength(3);
    expect(slept).toEqual([1000, 2000]);
  });

  it("④ three retryable errors wait 1 and 2 seconds, then stop as connector-error", async () => {
    const { clock, slept } = fakeClock();
    const raise = new ConnectorError("down", { retryable: true });
    const m = await manager(
      new ScriptedConnector(),
      { entries, faults: [{ raise, times: 5 }] },
      clock,
    );
    const result = await m.sync("s");
    expect(result).toMatchObject({ stopped: "connector-error" });
    expect(result).not.toHaveProperty("retryAfterMs");
    expect(slept).toEqual([1000, 2000]);
  });

  it("⑤ an error that cannot be retried stops on the first call as connector-failed", async () => {
    const { clock, slept } = fakeClock();
    const raise = new ConnectorError("no", { retryable: false });
    const connector = new ScriptedConnector();
    const m = await manager(connector, { entries, faults: [{ raise, times: 5 }] }, clock);
    expect(await m.sync("s")).toMatchObject({ stopped: "connector-failed" });
    expect(connector.calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it("⑥ whatever stops it, the cursor stays at the last stored page", async () => {
    const raises = [
      rate(1),
      new ConnectorError("x", { retryable: true }),
      new ConnectorError("x", { retryable: false }),
    ];
    for (const [i, raise] of raises.entries()) {
      const id = `s${i}`;
      const faults = [{ cursor: "offset:2", raise, times: 9 }];
      const m = await manager(new ScriptedConnector(), { entries, faults }, undefined, id);
      await m.sync(id);
      expect(readCursor(db, id)).toBe("offset:2");
    }
  });

  it("the wait is the clock's: a cut signal ends it and the sync is aborted", async () => {
    const controller = new AbortController();
    const waitedOn: (AbortSignal | undefined)[] = [];
    const clock: Clock = {
      now: () => 0,
      monotonic: () => 0,
      sleep: async (_ms, signal) => {
        waitedOn.push(signal);
        controller.abort();
      },
    };
    const m = await manager(
      new ScriptedConnector(),
      { entries, faults: [{ raise: rate(5000) }] },
      clock,
    );
    expect(await m.sync("s", { signal: controller.signal })).toMatchObject({ stopped: "aborted" });
    expect(waitedOn).toEqual([controller.signal]); // the sync's own signal ends the wait early
  });
});

describe("sync.rescan", () => {
  const entries = ["a", "b", "c"].map((id) => up(id));
  const expireAt = (cursor: string, times = 1) => ({ cursor, expire: true as const, times });

  it("① an expired cursor reads again from the start, the sources do not grow, and it says rescanned", async () => {
    const connector = new ScriptedConnector();
    const m = await manager(connector, { entries });
    expect(await m.sync("s")).toMatchObject({ created: 3, rescanned: false });
    await connector.initialize({ entries, faults: [expireAt("offset:3")] });
    const result = await m.sync("s");
    expect(result).toMatchObject({ created: 0, unchanged: 3, rescanned: true });
    expect(result).not.toHaveProperty("stopped");
    expect(counts()).toEqual([3, 3]);
  });

  it("② without deletionsOnRescan it says deletions may be missed; with it a delete event is applied and nothing is said", async () => {
    const without = new ScriptedConnector();
    const m1 = await manager(without, { entries });
    await m1.sync("s");
    await without.initialize({ entries, faults: [expireAt("offset:3")] });
    expect(await m1.sync("s")).toMatchObject({ rescanned: true, deletionsMayBeMissed: true });
    expect(m1.list()).toMatchObject([{ id: "s", deletionsMayBeMissed: true }]);

    const withIt = new ScriptedConnector(caps({ deletes: true, deletionsOnRescan: true }));
    const m2 = await manager(withIt, { entries }, undefined, "t");
    await m2.sync("t");
    await withIt.initialize({
      entries: [...entries, del("a", 2)],
      faults: [expireAt("offset:3")],
    });
    const result = await m2.sync("t");
    expect(result).toMatchObject({ rescanned: true, deletionsMayBeMissed: false, tombstoned: 1 });
    expect(m2.list()[0]).not.toHaveProperty("deletionsMayBeMissed");
    expect(db.all("SELECT count(*) AS n FROM tombstones")[0]?.n).toBe(1);
  });

  it("③ a second expiry during the rescan stops as cursor-expired", async () => {
    const connector = new ScriptedConnector();
    const m = await manager(connector, { entries });
    await m.sync("s");
    await connector.initialize({ entries, faults: [expireAt("offset:3"), expireAt("offset:2")] });
    expect(await m.sync("s")).toMatchObject({ stopped: "cursor-expired", rescanned: true });
  });

  it("④ a Connector without fullRescan stops as cursor-expired without rescanning", async () => {
    const connector = new ScriptedConnector(caps({ fullRescan: false }));
    const m = await manager(connector, { entries });
    await m.sync("s");
    await connector.initialize({ entries, faults: [expireAt("offset:3")] });
    const calls = connector.calls.length;
    const result = await m.sync("s");
    expect(result).toMatchObject({ stopped: "cursor-expired", rescanned: false });
    expect(connector.calls).toHaveLength(calls + 1);
    expect(pending()).toEqual({ p: 0, m: 0 });
  });

  it("⑤ a rescan left unfinished is finished by the next sync, whose result carries both marks", async () => {
    db.run("INSERT INTO connector_instances (id, kind, cursor) VALUES ('s', 'scripted', 'stale')");
    const four = ["a", "b", "c", "d"].map((id) => up(id));
    const connector = new ScriptedConnector();
    const stopping = await manager(connector, {
      entries: four,
      faults: [{ cursor: "offset:2", raise: new ConnectorError("x", { retryable: false }) }],
    });
    const first = await stopping.sync("s");
    expect(first).toMatchObject({ stopped: "connector-failed", rescanned: true, created: 2 });
    expect(pending()).toEqual({ p: 1, m: 1 });
    expect(readCursor(db, "s")).toBe("offset:2");

    // a new run of the application: the pending rescan is in the file, not in memory
    const next = new ScriptedConnector();
    const resumed = await manager(next, { entries: four });
    const second = await resumed.sync("s");
    expect(second).toMatchObject({ created: 2, rescanned: true, deletionsMayBeMissed: true });
    expect(second).not.toHaveProperty("stopped");
    expect(next.calls[0]?.cursor).toBe("offset:2");
    expect(pending()).toEqual({ p: 0, m: 1 });
    expect(resumed.list()).toMatchObject([{ deletionsMayBeMissed: true }]);

    // an ordinary sync after it is not a rescan, and the mark on the list stays
    const third = await resumed.sync("s");
    expect(third).toMatchObject({ rescanned: false, deletionsMayBeMissed: false, received: 0 });
    expect(resumed.list()).toMatchObject([{ deletionsMayBeMissed: true }]);
  });
});

describe("sync.rescan, a carried-over rescan whose cursor expires (review F1)", () => {
  it("restarts the rescan from null in the next sync and completes it, clearing rescan_pending", async () => {
    db.run("INSERT INTO connector_instances (id, kind, cursor) VALUES ('s', 'scripted', 'stale')");
    const four = ["a", "b", "c", "d"].map((id) => up(id));
    const connector = new ScriptedConnector();
    const first = await manager(connector, {
      entries: four,
      faults: [{ cursor: "offset:2", raise: new ConnectorError("x", { retryable: false }) }],
    });
    expect(await first.sync("s")).toMatchObject({ stopped: "connector-failed", rescanned: true });
    expect(pending()).toEqual({ p: 1, m: 1 });

    // the origin expires the cursor the carried-over rescan stopped at
    await connector.initialize({
      entries: four,
      faults: [{ cursor: "offset:2", expire: true }],
    });
    const second = await first.sync("s");
    expect(second).not.toHaveProperty("stopped");
    expect(second).toMatchObject({ rescanned: true, deletionsMayBeMissed: true });
    expect(pending()).toEqual({ p: 0, m: 1 });
    expect(counts()).toEqual([4, 4]);
  });
});

describe("sync.activity-fields", () => {
  it("the result carries the counts I03 reads, and the list API carries deletionsMayBeMissed", async () => {
    const connector = new ScriptedConnector(caps({ deletes: true }));
    const m = await manager(connector, {
      entries: [up("a", 5), del("a", 3), del("a", 6), up("a", 4), up("b"), up("b")],
      pageSize: 10,
    });
    const result = await m.sync("s");
    expect(result).toMatchObject({
      connectorId: "s",
      received: 6,
      created: 2,
      unchanged: 1,
      stale: 0,
      staleTombstone: 1,
      blocked: 1,
      tombstoned: 1,
      scopeUpdated: 0,
      rejected: [],
      rejectedCount: 0,
      rescanned: false,
      deletionsMayBeMissed: false,
    });
    expect(() => SyncResponseSchema.parse(result)).not.toThrow();

    db.run("UPDATE connector_instances SET deletions_may_be_missed = 1 WHERE id = 's'");
    const list = ConnectorListResponseSchema.parse({ connectors: m.list() }).connectors;
    expect(list).toEqual([
      { id: "s", kind: "scripted", state: "ready", deletionsMayBeMissed: true },
    ]);
  });

  it("an older revision is stale and a scope-change on a live source is scopeUpdated", async () => {
    const m = await manager(new ScriptedConnector(caps({ accessScope: true })), {
      entries: [
        up("a", 3, { accessScope: ["team"] }),
        up("a", 2, { accessScope: ["team"] }, "an older body"),
        {
          kind: "scope-change",
          namespace: "",
          externalId: "a",
          revision: 3,
          accessScope: ["team", "all"],
          at: AT,
        },
      ],
      pageSize: 10,
    });
    expect(await m.sync("s")).toMatchObject({ created: 1, stale: 1, scopeUpdated: 1 });
  });
});

describe("sync.exclusive", () => {
  it("① a sync that finds the instance's lock held stops as instance-busy without calling the Connector", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const connector = new ScriptedConnector();
    const m = await manager(connector, {
      entries: [up("a")],
      beforeAnswer: () => held,
    });
    const first = m.sync("s");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(connector.calls).toHaveLength(1);
    expect(await m.sync("s")).toMatchObject({ stopped: "instance-busy", created: 0, received: 0 });
    expect(connector.calls).toHaveLength(1);
    release();
    expect(await first).toMatchObject({ created: 1 });
  });

  it("the lock is the same for every taker of the instance, and each lock is released once", () => {
    const first = tryLockInstance(db, "s");
    expect(first).toBeTypeOf("function");
    expect(tryLockInstance(db, "s")).toBeUndefined();
    expect(tryLockInstance(db, "other")).toBeTypeOf("function");
    (first as () => void)();
    expect(tryLockInstance(db, "s")).toBeTypeOf("function");
  });

  it("③ a storage failure, a cut, a Connector exception and a throw after the commit all release the lock", async () => {
    const entries = [up("a"), up("b")];
    const ok = async (m: ConnectorManager, id: string) =>
      expect(await m.sync(id)).not.toHaveProperty("stopped");

    failOnInsertOf("a");
    const storage = await manager(new ScriptedConnector(), { entries }, undefined, "s1");
    expect(await storage.sync("s1")).toMatchObject({ stopped: "storage-failed" });
    db.exec("DROP TRIGGER boom");
    await ok(storage, "s1");

    const cut = new AbortController();
    const aborting = await manager(
      new ScriptedConnector(),
      { entries, beforeAnswer: () => cut.abort() },
      undefined,
      "s2",
    );
    expect(await aborting.sync("s2", { signal: cut.signal })).toMatchObject({ stopped: "aborted" });
    await ok(await manager(new ScriptedConnector(), { entries }, undefined, "s2"), "s2");

    const raising = await manager(
      new ScriptedConnector(),
      { entries, faults: [{ raise: new Error("boom") }] },
      undefined,
      "s3",
    );
    expect(await raising.sync("s3")).toMatchObject({ stopped: "connector-failed" });
    await ok(raising, "s3");

    // an exception no stop code stands for (a notice delivery after the commit) still frees it
    const throwing = await createConnectorManager(
      db,
      [{ id: "s4", kind: "scripted", config: { entries } }],
      { scripted: () => new ScriptedConnector() },
      {
        projections: {
          notify: () => {
            throw new Error("notice delivery failed");
          },
        },
      },
    );
    await expect(throwing.sync("s4")).rejects.toThrow("notice delivery failed");
    expect(tryLockInstance(db, "s4")).toBeTypeOf("function");
  });
});

describe("sync of a kind that is not ready", () => {
  it("unknown and unavailable instances are answered as before, taking no lock", async () => {
    const m = await manager(new ScriptedConnector({ schemaVersion: 1 }), { entries: [] });
    expect(await m.sync("s")).toEqual({ error: "connector-unavailable" });
    expect(await m.sync("nope")).toEqual({ error: "not-found" });
    expect(tryLockInstance(db, "s")).toBeTypeOf("function");
  });
});
