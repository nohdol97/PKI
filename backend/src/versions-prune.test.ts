// I04-R10 optional part (I04-T12): the route that prunes one source's earlier versions. It
// answers through the same checks as every route (Host, Origin, token), changes nothing for a
// request that fails one, and a prune leaves the text only the earlier versions held in no file
// of the data directory (the data-level cases are knowledge-engine/src/prune-versions.test.ts).
import { routes } from "@pki/contracts";
import {
  findSourceId,
  registerConnectorInstance,
  saveSourceRecord,
  type SqlDriver,
} from "@pki/storage";
import { canariesLeft, send } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openCanonicalDb, productAdapters, productEgress } from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import { startServer, type RunningServer } from "./server.ts";

const TOKEN = "t".repeat(43);
const DATA_DIR = mkdtempSync(join(tmpdir(), "pki-versions-prune-"));
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };
const OLD = "mbvoldtext";
const NEW = "jwxnewtext";
let db: SqlDriver;
let server: RunningServer;
let valid: Record<string, string>;
let wakes = 0;

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
    onRunConditionsChanged: () => {
      wakes++;
    },
    ...productAdapters(DATA_DIR),
  });
  valid = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` };
});
afterAll(async () => {
  await server.close();
  db.close();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

const body = (externalId: string) => ({ connectorId: "fixtures", namespace: "", externalId });
const prune = (externalId: string, headers: Record<string, string> = valid) =>
  send(
    server.port,
    routes.pruneVersions.path,
    headers,
    routes.pruneVersions.method,
    body(externalId),
  );
const save = (externalId: string, text: string) =>
  saveSourceRecord(db, "fixtures", { externalId, title: "합성 제목", body: text });
const versionsOf = (externalId: string) =>
  db
    .all("SELECT version FROM source_versions WHERE source_id = ? ORDER BY version", [
      findSourceId(db, "fixtures", "", externalId) ?? 0,
    ])
    .map((r) => r.version);

describe("versions.prune route", () => {
  it("prunes the earlier versions, answers the count and keeps the latest", async () => {
    save("a", `처음 ${OLD} 본문`);
    save("a", `둘째 본문`);
    save("a", `최신 ${NEW} 본문`);
    expect(canariesLeft(DATA_DIR, [OLD])).toEqual([OLD]);
    const wakesBefore = wakes;
    const res = await prune("a");
    expect(wakes).toBe(wakesBefore + 1); // the runner is woken for the removal jobs (I04-R12)
    expect(res).toMatchObject({ status: 200, body: { outcome: "pruned", prunedVersions: 2 } });
    expect(routes.pruneVersions.response.parse(res.body)).toEqual(res.body);
    expect(versionsOf("a")).toEqual([3]);
    expect(canariesLeft(DATA_DIR, [OLD, NEW])).toEqual([NEW]);
  });

  it("answers unchanged for the repeat and for a source with a single version", async () => {
    const wakesBefore = wakes;
    expect((await prune("a")).body).toEqual({ outcome: "unchanged", prunedVersions: 0 });
    save("single", "하나뿐");
    expect((await prune("single")).body).toEqual({ outcome: "unchanged", prunedVersions: 0 });
    expect((await prune("nobody-either")).status).toBe(404);
    expect(wakes).toBe(wakesBefore); // nothing was registered, nothing to wake for
    expect(versionsOf("single")).toEqual([1]);
  });

  it("answers not-found for an unknown source and for a deleted one", async () => {
    expect((await prune("nobody")).status).toBe(404);
    save("gone", "삭제될 본문");
    save("gone", "삭제될 본문 둘째");
    await send(
      server.port,
      routes.deleteSource.path,
      valid,
      routes.deleteSource.method,
      body("gone"),
    );
    expect(await prune("gone")).toMatchObject({ status: 404, body: { error: "not-found" } });
  });

  it("refuses a request that fails the Host, Origin or token check and changes nothing for it", async () => {
    save("guarded", `첫 ${OLD}x 본문`);
    save("guarded", "둘째 본문");
    for (const [header, value, status] of [
      ["authorization", "Bearer wrong", 401],
      ["host", "evil.example", 403],
      ["origin", "https://evil.example", 403],
    ] as const) {
      expect((await prune("guarded", { ...valid, [header]: value })).status).toBe(status);
    }
    const bare = { host: valid.host as string };
    expect((await prune("guarded", bare)).status).toBe(401);
    expect(versionsOf("guarded")).toEqual([1, 2]);
  });

  it("refuses a malformed body", async () => {
    const res = await send(server.port, routes.pruneVersions.path, valid, "POST", {
      connectorId: "fixtures",
      externalId: "a",
    });
    expect(res.status).toBe(400);
  });
});
