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
import { createConnectorManager, syncConnector } from "./connectors.ts";

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
    const connector = scripted(() => ({
      changes: [
        upsert("a"),
        { kind: "delete", externalId: "a", version: 1, at: "2026-11-21T00:00:00Z" },
      ],
      nextCursor: "9",
      hasMore: false,
    }));
    await expect(syncConnector(db, "s", "scripted", connector)).rejects.toThrow(/delete/);
    expect(readCursor(db, "s")).toBeNull();
    expect(counts()).toEqual([0, 0]);
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
