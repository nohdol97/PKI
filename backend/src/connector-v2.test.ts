// I01-T01 integration: `connector.sdk-version` (I01-C1, R1) and `interim.identity`
// (I01-C2, R8 with the spec's "T01과 T02 사이": before I01-T02's arrival rule).
import {
  CONNECTOR_SDK_VERSION,
  ConnectorListResponseSchema,
  type ChangeSet,
  type Connector,
} from "@pki/contracts";
import { readCursor, type SqlDriver } from "@pki/storage";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCanonicalDb } from "./composition.ts";
import { createConnectorManager, siteCheck, syncConnector } from "./connectors.ts";

let dir: string;
let db: SqlDriver;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-connector-v2-"));
  db = openCanonicalDb(join(dir, "data"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function scripted(pages: (cursor: string | null) => ChangeSet, schemaVersion = 2) {
  let initialized = 0;
  const connector: Connector = {
    manifest: {
      type: "scripted",
      schemaVersion,
      capabilities: {
        incremental: true,
        deletes: true,
        accessScope: false,
        fullRescan: true,
        deletionsOnRescan: false,
      },
    },
    initialize: async () => {
      initialized++;
    },
    healthCheck: async () => ({ state: "ok" }),
    getChanges: async (cursor) => pages(cursor),
    getDocument: async () => null,
  };
  return { connector, initialized: () => initialized };
}

describe("connector.sdk-version", () => {
  it("runs only Connectors of this build's SDK version", () => {
    expect(CONNECTOR_SDK_VERSION).toBe(2);
  });

  it.each([1, 3])(
    "leaves a schemaVersion %i Connector uninitialized and unavailable, and refuses its sync",
    async (version) => {
      let reads = 0;
      const old = scripted(() => {
        reads++;
        return { changes: [], nextCursor: "0", hasMore: false };
      }, version);
      const manager = await createConnectorManager(db, [{ id: "old-1", kind: "old", config: {} }], {
        old: () => old.connector,
      });
      expect(old.initialized()).toBe(0);
      const list = manager.list();
      expect(list).toEqual([
        { id: "old-1", kind: "old", state: "unavailable", reason: "unsupported-sdk-version" },
      ]);
      expect(ConnectorListResponseSchema.parse({ connectors: list }).connectors).toEqual(list);
      expect(await manager.sync("old-1")).toEqual({ error: "connector-unavailable" });
      expect(reads).toBe(0);
    },
  );

  it("initializes a Connector of the supported version and reports no reason", async () => {
    const current = scripted(() => ({ changes: [], nextCursor: "0", hasMore: false }));
    const manager = await createConnectorManager(db, [{ id: "c", kind: "k", config: {} }], {
      k: () => current.connector,
    });
    expect(current.initialized()).toBe(1);
    expect(manager.list()).toEqual([{ id: "c", kind: "k", state: "ready" }]);
  });

  // review B-S2: a manifest that cannot be read fails only its own instance, closed
  it.each([
    ["missing", () => undefined],
    [
      "throwing",
      () => {
        throw new Error("SECRET-origin-text");
      },
    ],
  ])("keeps the other instances when one manifest is %s", async (_, manifest) => {
    const broken = scripted(() => ({ changes: [], nextCursor: "0", hasMore: false }));
    Object.defineProperty(broken.connector, "manifest", { get: manifest });
    const good = scripted(() => ({ changes: [], nextCursor: "0", hasMore: false }));
    const manager = await createConnectorManager(
      db,
      [
        { id: "broken-1", kind: "broken", config: {} },
        { id: "good-1", kind: "good", config: {} },
      ],
      { broken: () => broken.connector, good: () => good.connector },
    );
    expect(broken.initialized()).toBe(0);
    expect(manager.list()).toEqual([
      { id: "broken-1", kind: "broken", state: "unavailable", reason: "unsupported-sdk-version" },
      { id: "good-1", kind: "good", state: "ready" },
    ]);
    expect(await manager.sync("broken-1")).toEqual({ error: "connector-unavailable" });
    expect(await manager.sync("good-1")).toMatchObject({ connectorId: "good-1" });
    const check = await siteCheck("broken", () => broken.connector);
    expect(check).toEqual({ ok: false, line: "broken: unsupported-sdk-version" });
    expect(JSON.stringify([manager.list(), check])).not.toContain("SECRET");
  });

  it("shows the reason in site-check, which exits non-zero without initializing", async () => {
    const old = scripted(() => ({ changes: [], nextCursor: "0", hasMore: false }), 1);
    expect(await siteCheck("old", () => old.connector)).toEqual({
      ok: false,
      line: "old: unsupported-sdk-version",
    });
    expect(old.initialized()).toBe(0);
    const current = scripted(() => ({ changes: [], nextCursor: "0", hasMore: false }));
    expect(await siteCheck("k", () => current.connector)).toEqual({ ok: true, line: "k: ok" });
  });
});

describe("interim.identity", () => {
  const AT = "2026-11-21T00:00:00Z";
  const upsert = (namespace: string, revision: number, body: string) => ({
    kind: "upsert" as const,
    record: { namespace, externalId: "e", revision, schemaVersion: 2 as const, title: "t", body },
  });
  const page = (changes: ChangeSet["changes"], nextCursor: string) =>
    scripted(() => ({ changes, nextCursor, hasMore: false })).connector;

  it("keeps one external id in two namespaces as two sources, even with the same content", async () => {
    await syncConnector(
      db,
      "s",
      "scripted",
      page([upsert("a", 7, "same"), upsert("b", 7, "same")], "1"),
    );
    expect(
      db.all(
        `SELECT s.namespace, s.external_id, v.version, v.revision
           FROM sources s JOIN source_versions v ON v.source_id = s.id ORDER BY s.id`,
      ),
    ).toEqual([
      { namespace: "a", external_id: "e", version: 1, revision: 7 },
      { namespace: "b", external_id: "e", version: 1, revision: 7 },
    ]);
  });

  it("deletes through V02's path at the latest product version, not the event's revision", async () => {
    await syncConnector(
      db,
      "s",
      "scripted",
      page([upsert("a", 7, "one"), upsert("a", 8, "two"), upsert("b", 7, "kept")], "1"),
    );
    await syncConnector(
      db,
      "s",
      "scripted",
      page([{ kind: "delete", namespace: "a", externalId: "e", revision: 9, at: AT }], "2"),
    );
    expect(
      db.all(
        "SELECT s.namespace, t.version, t.reason FROM tombstones t JOIN sources s ON s.id = t.source_id",
      ),
    ).toEqual([{ namespace: "a", version: 2, reason: "source-deleted" }]);
    expect(
      db.all(
        "SELECT s.namespace, v.body FROM source_versions v JOIN sources s ON s.id = v.source_id",
      ),
    ).toEqual([{ namespace: "b", body: "kept" }]);
  });

  it("leaves an unknown namespace's tombstone event as nothing to delete", async () => {
    await syncConnector(db, "s", "scripted", page([upsert("a", 1, "x")], "1"));
    await syncConnector(
      db,
      "s",
      "scripted",
      page([{ kind: "access-revoked", namespace: "z", externalId: "e", revision: 2, at: AT }], "2"),
    );
    expect(db.all("SELECT count(*) AS n FROM tombstones")).toEqual([{ n: 0 }]);
    expect(db.all("SELECT count(*) AS n FROM source_versions")).toEqual([{ n: 1 }]);
  });

  it("fails the page of a scope change, which has no store before I01-T02", async () => {
    await syncConnector(db, "s", "scripted", page([upsert("a", 1, "x")], "1"));
    const scope = {
      kind: "scope-change" as const,
      namespace: "a",
      externalId: "e",
      revision: 2,
      at: AT,
      accessScope: ["team"],
    };
    await expect(
      syncConnector(db, "s", "scripted", page([upsert("b", 1, "y"), scope], "2")),
    ).rejects.toThrow(/scope-change/);
    expect(readCursor(db, "s")).toBe("1");
    expect(db.all("SELECT namespace, access_scope FROM sources")).toEqual([
      { namespace: "a", access_scope: null },
    ]);
  });
});
