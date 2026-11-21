// V01-R7, C3 (data) integration: syncing the test Connector into a real SQLite
// file; re-running does not grow sources or versions, the cursor is committed
// only with the saved records, and the synced records are keyword-searchable.
import type { ChangeSet, Connector } from "@pki/contracts";
import { readCursor, searchKeyword, type SqlDriver } from "@pki/storage";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectorInstances, connectorKinds, openCanonicalDb } from "./composition.ts";
import { createConnectorManager, EXTRACT_JOB_KIND, syncConnector } from "./connectors.ts";

const FIXTURES = resolve(import.meta.dirname, "../../fixtures/test-connector.jsonl");

let dir: string;
let db: SqlDriver;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-sync-"));
  db = openCanonicalDb(join(dir, "data"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const counts = () =>
  ["sources", "source_versions"].map((t) => db.all(`SELECT count(*) AS n FROM ${t}`)[0]?.n);

/** A Connector replaying fixed pages, for the failure paths the fixtures cannot produce. */
function scripted(pages: (cursor: string | null) => ChangeSet): Connector {
  return {
    manifest: {
      type: "scripted",
      schemaVersion: 1,
      capabilities: { incremental: true, deletes: true, accessScope: false, fullRescan: true },
    },
    initialize: async () => {},
    healthCheck: async () => ({ state: "ok" }),
    getChanges: async (cursor) => pages(cursor),
    getDocument: async () => null,
  };
}

const upsert = (externalId: string, body = "b") => ({
  kind: "upsert" as const,
  record: { externalId, title: "t", body },
});

describe("sync of the test Connector", () => {
  it("stores every fixture once and does not grow when re-run", async () => {
    const manager = await createConnectorManager(db, connectorInstances(FIXTURES), connectorKinds);
    const first = await manager.sync("fixtures");
    expect(first).toEqual({ connectorId: "fixtures", received: 5, created: 5 });
    expect(counts()).toEqual([5, 5]);

    expect(await manager.sync("fixtures")).toEqual({
      connectorId: "fixtures",
      received: 0,
      created: 0,
    });
    expect(counts()).toEqual([5, 5]);
  });

  it("creates no versions on a full rescan of unchanged content (content hash)", async () => {
    const manager = await createConnectorManager(db, connectorInstances(FIXTURES), connectorKinds);
    await manager.sync("fixtures");
    db.run("UPDATE connector_instances SET cursor = NULL WHERE id = 'fixtures'");
    expect(await manager.sync("fixtures")).toEqual({
      connectorId: "fixtures",
      received: 5,
      created: 0,
    });
    expect(counts()).toEqual([5, 5]);
  });

  it("records the instance's kind, not its id, for the site-* origin rule", async () => {
    const instances = [{ id: "mail-1", kind: "test-fixtures", config: { file: FIXTURES } }];
    const manager = await createConnectorManager(db, instances, connectorKinds);
    await manager.sync("mail-1");
    expect(db.all("SELECT id, kind FROM connector_instances")).toEqual([
      { id: "mail-1", kind: "test-fixtures" },
    ]);
    expect(db.all("SELECT DISTINCT connector_instance_id AS id FROM sources")).toEqual([
      { id: "mail-1" },
    ]);
  });

  it("makes the synced records keyword-searchable", async () => {
    const manager = await createConnectorManager(db, connectorInstances(FIXTURES), connectorKinds);
    await manager.sync("fixtures");
    expect(searchKeyword(db, "등대")).toHaveLength(2);
  });

  it("refuses to sync a not-implemented site Connector", async () => {
    const manager = await createConnectorManager(db, connectorInstances(), connectorKinds);
    expect(manager.list().map((c) => [c.id, c.state])).toEqual([
      ["site-mail", "not-implemented"],
      ["site-messenger", "not-implemented"],
      ["site-wiki", "not-implemented"],
    ]);
    expect(await manager.sync("site-mail")).toEqual({ error: "connector-unavailable" });
    expect(await manager.sync("nope")).toEqual({ error: "not-found" });
  });
});

describe("cursor after save", () => {
  it("advances the cursor page by page together with the saved records", async () => {
    const connector = scripted((cursor) =>
      cursor === null
        ? { changes: [upsert("a")], nextCursor: "1", hasMore: true }
        : { changes: [upsert("b")], nextCursor: "2", hasMore: false },
    );
    expect(await syncConnector(db, "s", "scripted", connector)).toEqual({
      received: 2,
      created: 2,
    });
    expect(readCursor(db, "s")).toBe("2");
  });

  it("keeps the old cursor and saves nothing when a page cannot be stored", async () => {
    const page = (changes: ChangeSet["changes"], nextCursor: string) =>
      scripted(() => ({ changes, nextCursor, hasMore: false }));
    const revised = (revision: number, body: string) => ({
      kind: "upsert" as const,
      record: { externalId: "r", title: "t", body, revision },
    });
    await syncConnector(db, "s", "scripted", page([revised(2, "b")], "1"));
    const jobs = db.all("SELECT count(*) AS n FROM jobs");
    await expect(
      syncConnector(db, "s", "scripted", page([upsert("a"), revised(1, "older")], "9")),
    ).rejects.toThrow(/revision-not-newer/);
    expect(readCursor(db, "s")).toBe("1");
    expect(counts()).toEqual([1, 1]);
    expect(db.all("SELECT count(*) AS n FROM jobs")).toEqual(jobs);
  });

  it("skips an upsert of a deleted source and commits the rest of the page with its cursor (review A-M1)", async () => {
    // x is stored, then deleted (V02-R12): a later upsert of x stores nothing,
    // and neither stalls the instance's cursor nor loses the page's other changes
    const page = (changes: ChangeSet["changes"], nextCursor: string) =>
      scripted(() => ({ changes, nextCursor, hasMore: false }));
    await syncConnector(db, "s", "scripted", page([upsert("x")], "1"));
    const at = "2026-11-21T00:00:00Z";
    await syncConnector(
      db,
      "s",
      "scripted",
      page([{ kind: "delete", externalId: "x", version: 2, at }], "2"),
    );
    const refused: [string, string][] = [];
    const result = await syncConnector(
      db,
      "s",
      "scripted",
      page([upsert("a"), upsert("x", "again")], "9"),
      {
        onRefused: (change, reason) =>
          refused.push([change.kind === "upsert" ? change.record.externalId : "?", reason]),
      },
    );
    expect(result).toEqual({ received: 2, created: 1 });
    expect(refused).toEqual([["x", "tombstoned"]]);
    expect(readCursor(db, "s")).toBe("9");
    expect(
      db.all("SELECT s.external_id FROM source_versions v JOIN sources s ON s.id = v.source_id"),
    ).toEqual([{ external_id: "a" }]);
    // without onRefused (the Connector manager's sync) the page commits the same way
    expect(
      await syncConnector(db, "s", "scripted", page([upsert("x", "once more"), upsert("b")], "10")),
    ).toEqual({ received: 2, created: 1 });
    expect(readCursor(db, "s")).toBe("10");
  });

  it.each([
    ["delete", "source-deleted"],
    ["access-revoked", "access-revoked"],
  ] as const)(
    "tombstones and purges a source on a %s change, with the page and its cursor (V02-R12)",
    async (kind, reason) => {
      const at = "2026-11-21T00:00:00Z";
      const connector = scripted((cursor) =>
        cursor === null
          ? { changes: [upsert("a"), upsert("b")], nextCursor: "1", hasMore: true }
          : {
              changes: [{ kind, externalId: "a", version: 3, at }],
              nextCursor: "2",
              hasMore: false,
            },
      );
      expect(await syncConnector(db, "s", "scripted", connector)).toEqual({
        received: 3,
        created: 2,
      });
      expect(readCursor(db, "s")).toBe("2");
      expect(counts()).toEqual([2, 1]);
      expect(db.all("SELECT source_id, version, reason FROM tombstones")).toEqual([
        { source_id: 1, version: 1, reason },
      ]);
    },
  );

  it("registers one extraction job per new version, fenced at it, with the page (V02-R4)", async () => {
    const connector = scripted(() => ({
      changes: [upsert("a"), upsert("a"), upsert("b"), upsert("a", "b2")],
      nextCursor: "1",
      hasMore: false,
    }));
    expect(await syncConnector(db, "s", "scripted", connector)).toEqual({
      received: 4,
      created: 3,
    });
    expect(
      db.all(
        `SELECT s.external_id, j.kind, j.fence_version, j.status
           FROM jobs j JOIN sources s ON s.id = j.source_id ORDER BY j.id`,
      ),
    ).toEqual([
      { external_id: "a", kind: EXTRACT_JOB_KIND, fence_version: 1, status: "queued" },
      { external_id: "b", kind: EXTRACT_JOB_KIND, fence_version: 1, status: "queued" },
      { external_id: "a", kind: EXTRACT_JOB_KIND, fence_version: 2, status: "queued" },
    ]);
  });

  it("rejects a malformed page before storing anything", async () => {
    const connector = scripted(
      () =>
        ({
          changes: [
            {
              kind: "upsert",
              record: { externalId: "a", title: "t", body: "b", classification: "synthetic" },
            },
          ],
          nextCursor: "1",
          hasMore: false,
        }) as unknown as ChangeSet,
    );
    await expect(syncConnector(db, "s", "scripted", connector)).rejects.toThrow();
    expect(counts()).toEqual([0, 0]);
    expect(readCursor(db, "s")).toBeNull();
  });

  it("rescans from the start when the Connector reports the cursor expired", async () => {
    db.run("INSERT INTO connector_instances (id, kind, cursor) VALUES ('s', 'scripted', 'old')");
    const seen: (string | null)[] = [];
    const connector = scripted((cursor) => {
      seen.push(cursor);
      return cursor === "old"
        ? { changes: [], nextCursor: "old", hasMore: false, cursorExpired: true }
        : { changes: [upsert("a")], nextCursor: "1", hasMore: false };
    });
    expect(await syncConnector(db, "s", "scripted", connector)).toEqual({
      received: 1,
      created: 1,
    });
    expect(seen).toEqual(["old", null]);
    expect(readCursor(db, "s")).toBe("1");
  });

  it("gives up when the cursor expires again later in the same rescan", async () => {
    db.run("INSERT INTO connector_instances (id, kind, cursor) VALUES ('s', 'scripted', 'old')");
    let calls = 0;
    const connector = scripted((cursor) => {
      if (++calls > 10) throw new Error("sync did not stop");
      return cursor === null
        ? { changes: [upsert("a")], nextCursor: "1", hasMore: true }
        : { changes: [], nextCursor: "x", hasMore: false, cursorExpired: true };
    });
    await expect(syncConnector(db, "s", "scripted", connector)).rejects.toThrow(/expired/);
    expect(calls).toBe(3);
  });

  it("gives up on a page that reports more without making progress", async () => {
    let calls = 0;
    const connector = scripted((cursor) => {
      if (++calls > 10) throw new Error("sync did not stop");
      return cursor === null
        ? { changes: [upsert("a")], nextCursor: "1", hasMore: true }
        : { changes: [], nextCursor: "1", hasMore: true };
    });
    await expect(syncConnector(db, "s", "scripted", connector)).rejects.toThrow(/progress/);
    expect(calls).toBe(2);
    expect(readCursor(db, "s")).toBe("1");
  });

  it("gives up when the cursor does not move even though the page has changes", async () => {
    let calls = 0;
    const connector = scripted((cursor) => {
      if (++calls > 10) throw new Error("sync did not stop");
      return cursor === null
        ? { changes: [upsert("a")], nextCursor: "1", hasMore: true }
        : { changes: [upsert("b")], nextCursor: "1", hasMore: true };
    });
    await expect(syncConnector(db, "s", "scripted", connector)).rejects.toThrow(/progress/);
    expect(calls).toBe(2);
    expect(readCursor(db, "s")).toBe("1");
  });

  it("gives up when a full rescan is itself reported expired", async () => {
    const connector = scripted(() => ({
      changes: [],
      nextCursor: "x",
      hasMore: false,
      cursorExpired: true,
    }));
    await expect(syncConnector(db, "s", "scripted", connector)).rejects.toThrow(/expired/);
  });
});
