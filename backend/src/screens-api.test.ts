// V01-R3: the routes behind Sources, Activity and Settings answer from the
// canonical DB and the configured data directory, never from fixed values.
import { ErrorResponseSchema, routes } from "@pki/contracts";
import {
  migrate,
  openBetterSqlite3,
  registerConnectorInstance,
  saveSourceRecord,
} from "@pki/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { send } from "@pki/testkit";
import { productAdapters } from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import { startServer, type RunningServer } from "./server.ts";

const TOKEN = "w".repeat(43);
const DATA_DIR = "/synthetic/PKI-dev";
const db = openBetterSqlite3(":memory:");
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };
let server: RunningServer;
let valid: Record<string, string>;

beforeAll(async () => {
  migrate(db);
  registerConnectorInstance(db, "fixtures", "test-fixtures");
  saveSourceRecord(db, "fixtures", {
    externalId: "x1",
    title: "합성 등대 일지",
    body: "합성 자료",
  });
  db.run(
    `INSERT INTO provider_calls (request_id, attempt, provider, destination, task_kind,
       classification, policy_version, outcome, duration_ms, created_at)
     VALUES ('r1', 1, 'fake', 'synthetic.example', 'connection-test', 'synthetic', 'p1', 'ok', 5,
       '2026-11-21T00:00:00Z')`,
  );
  server = await startServer({
    token: TOKEN,
    allowedOrigins: [],
    connectors,
    db,
    dataDirectory: DATA_DIR,
    ...productAdapters(),
  });
  valid = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` };
});
afterAll(async () => {
  await server.close();
  db.close();
});

const call = (path: string, method = "GET", body?: unknown) =>
  send(server.port, path, valid, method, body);

describe("screen routes", () => {
  it("lists stored sources", async () => {
    const res = await call(routes.sources.path);
    expect(res.body).toEqual({
      sources: [{ id: 1, connectorId: "fixtures", externalId: "x1", title: "합성 등대 일지" }],
    });
  });

  it("searches stored sources by keyword", async () => {
    const { path, method } = routes.searchSources;
    expect((await call(path, method, { query: "등대" })).body).toMatchObject({
      sources: [{ externalId: "x1" }],
    });
    expect((await call(path, method, { query: "없는말" })).body).toEqual({ sources: [] });
  });

  it.each([{ query: "" }, { query: "x".repeat(201) }, { query: "등대", extra: 1 }, {}])(
    "rejects the search body %j",
    async (body) => {
      const { path, method } = routes.searchSources;
      const res = await call(path, method, body);
      expect(res.status).toBe(400);
      expect(ErrorResponseSchema.parse(res.body)).toEqual({ error: "bad-request" });
    },
  );

  it("lists the provider call history", async () => {
    expect((await call(routes.activity.path)).body).toEqual({
      calls: [
        {
          requestId: "r1",
          attempt: 1,
          provider: "fake",
          destination: "synthetic.example",
          taskKind: "connection-test",
          classification: "synthetic",
          policyVersion: "p1",
          outcome: "ok",
          durationMs: 5,
          createdAt: "2026-11-21T00:00:00Z",
        },
      ],
    });
  });

  it("reads the settings that exist so far", async () => {
    expect((await call(routes.settings.path)).body).toEqual({
      dataDirectory: DATA_DIR,
      schemaVersion: 2,
    });
  });
});
