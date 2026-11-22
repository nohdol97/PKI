// I04-T13 (R9): the user's way back for a deletion. One route lists the sources
// a tombstone blocks, one lifts a tombstone through liftTombstone in a canonical
// transaction. Only that route lifts: no Connector or source event reaches it.
import { ErrorResponseSchema, routes } from "@pki/contracts";
import { registerConnectorInstance, saveSourceRecord, type SqlDriver } from "@pki/storage";
import { send } from "@pki/testkit";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openCanonicalDb, productAdapters, productEgress } from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import { startServer, type RunningServer } from "./server.ts";

const TOKEN = "t".repeat(43);
const DATA_DIR = mkdtempSync(join(tmpdir(), "pki-tombstone-routes-"));
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };
let db: SqlDriver;
let server: RunningServer;
let valid: Record<string, string>;

beforeAll(async () => {
  db = openCanonicalDb(DATA_DIR);
  registerConnectorInstance(db, "fixtures", "test-fixtures");
  server = await startServer({
    token: TOKEN,
    allowedOrigins: [],
    connectors,
    db,
    dataDirectory: DATA_DIR,
    egress: productEgress(db),
    ...productAdapters(DATA_DIR),
  });
  valid = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` };
});
afterAll(async () => {
  await server.close();
  db.close();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

const call = (path: string, method = "GET", body?: unknown) =>
  send(server.port, path, valid, method, body);
const id = (externalId: string) => ({ connectorId: "fixtures", namespace: "", externalId });
const del = (externalId: string) =>
  call(routes.deleteSource.path, routes.deleteSource.method, id(externalId));
const lift = (externalId: string) =>
  call(routes.liftTombstone.path, routes.liftTombstone.method, id(externalId));
const listed = async () =>
  ((await call(routes.tombstones.path)).body as { tombstones: Record<string, unknown>[] })
    .tombstones;
const liftedAt = (externalId: string) =>
  db.all(
    "SELECT t.lifted_at AS at FROM tombstones t JOIN sources s ON s.id = t.source_id WHERE s.external_id = ?",
    [externalId],
  )[0]?.at;

describe("tombstone.lift routes", () => {
  it("lists a user-deleted source with its reason and covered version", async () => {
    saveSourceRecord(db, "fixtures", {
      externalId: "a",
      title: "합성 해제 일지",
      body: "해제 합성",
    });
    expect(await listed()).toEqual([]);
    await del("a");
    expect(await listed()).toEqual([
      {
        connectorId: "fixtures",
        namespace: "",
        externalId: "a",
        reason: "user-deleted",
        coversVersion: 1,
        at: expect.any(String),
      },
    ]);
  });

  it("lifts it: no longer listed, content stays gone, a new version is accepted above the cover", async () => {
    const res = await lift("a");
    expect(res).toMatchObject({ status: 200, body: { outcome: "lifted" } });
    expect(await listed()).toEqual([]);
    expect(db.all("SELECT count(*) AS n FROM source_versions")[0]?.n).toBe(0);
    const saved = saveSourceRecord(db, "fixtures", {
      externalId: "a",
      title: "합성 다시",
      body: "다시 합성",
    });
    expect(saved).toMatchObject({ status: "created", version: 2 });
  });

  it("answers unchanged for an already lifted tombstone, a source without one and an unknown source, touching nothing", async () => {
    const first = liftedAt("a");
    expect(first).toEqual(expect.any(String));
    expect((await lift("a")).body).toEqual({ outcome: "unchanged" });
    expect(liftedAt("a")).toBe(first);
    saveSourceRecord(db, "fixtures", { externalId: "b", title: "합성 b", body: "b 합성" });
    expect((await lift("b")).body).toEqual({ outcome: "unchanged" });
    expect((await lift("nope")).body).toEqual({ outcome: "unchanged" });
    expect(db.all("SELECT count(*) AS n FROM tombstones")[0]?.n).toBe(1);
  });

  it("deletes again after a lift and lists it again", async () => {
    expect((await del("a")).body).toEqual({ outcome: "deleted" });
    expect(await listed()).toEqual([
      expect.objectContaining({ externalId: "a", coversVersion: 2 }),
    ]);
    expect(liftedAt("a")).toBeNull();
  });

  it.each([
    [{ connectorId: "fixtures", externalId: "a" }],
    [{ connectorId: "", namespace: "", externalId: "a" }],
    [{ connectorId: "fixtures", namespace: "", externalId: "" }],
    [{ connectorId: "fixtures", namespace: "", externalId: "a", extra: 1 }],
    [{ connectorId: "fixtures", namespace: 1, externalId: "a" }],
  ])("rejects a malformed lift request %j", async (body) => {
    const res = await call(routes.liftTombstone.path, routes.liftTombstone.method, body);
    expect(res.status).toBe(400);
    expect(ErrorResponseSchema.parse(res.body)).toEqual({ error: "bad-request" });
    expect(liftedAt("a")).toBeNull();
  });

  it("is reached only by the user's route: no other product code calls liftTombstone", () => {
    const root = resolve(import.meta.dirname, "../..");
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          if (/\bliftTombstone\(/.test(readFileSync(path, "utf8")))
            callers.push(path.slice(root.length + 1));
        }
      }
    };
    for (const dir of ["backend", "knowledge-engine", "storage", "apps", "providers", "packages"]) {
      walk(join(root, dir));
    }
    expect(callers).toEqual(["backend/src/server.ts"]);
  });
});
