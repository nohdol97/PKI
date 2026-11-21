// V01-C1 `api.contract`: every API response, success or rejection, matches the
// schema in @pki/contracts that the UI also uses.
import { ErrorResponseSchema, routes, type RouteName } from "@pki/contracts";
import { migrate } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { send } from "@pki/testkit";
import { connectorInstances, connectorKinds, productAdapters } from "./composition.ts";
import { createConnectorManager } from "./connectors.ts";
import { startServer, type RunningServer } from "./server.ts";

const TOKEN = "c".repeat(43);
const FIXTURES = resolve(import.meta.dirname, "../../fixtures/test-connector.jsonl");
const db = openBetterSqlite3(":memory:");
let server: RunningServer;
let valid: Record<string, string>;

// A body for every route that takes one; the schema test below fails for a route missing here.
const requests: Partial<Record<RouteName, unknown>> = {
  syncConnector: { connectorId: "fixtures" },
};

beforeAll(async () => {
  migrate(db);
  const failing = () => ({
    ...connectorKinds["test-fixtures"](),
    getChanges: () => Promise.reject(new Error("connector broke")),
  });
  const connectors = await createConnectorManager(
    db,
    [
      ...connectorInstances(FIXTURES),
      { id: "broken", kind: "failing", config: { file: FIXTURES } },
    ],
    { ...connectorKinds, failing },
  );
  server = await startServer({
    token: TOKEN,
    allowedOrigins: [],
    connectors,
    ...productAdapters(),
  });
  valid = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` };
});
afterAll(async () => {
  await server.close();
  db.close();
});

describe("API responses match @pki/contracts", () => {
  it.each(Object.entries(routes))("%s", async (name, route) => {
    const body = requests[name as RouteName];
    expect(body === undefined).toBe(!("request" in route));
    const res = await send(server.port, route.path, valid, route.method, body);
    expect(res.status).toBe(200);
    expect(route.response.parse(res.body)).toEqual(res.body);
  });

  it("lists the site Connectors as not implemented", async () => {
    const res = await send(server.port, routes.connectors.path, valid);
    expect(res.body).toMatchObject({
      connectors: expect.arrayContaining([
        { id: "fixtures", kind: "test-fixtures", state: "ready" },
        { id: "site-mail", kind: "site-mail", state: "not-implemented" },
        { id: "site-messenger", kind: "site-messenger", state: "not-implemented" },
        { id: "site-wiki", kind: "site-wiki", state: "not-implemented" },
      ]),
    });
  });

  const sync = routes.syncConnector;
  it.each([
    ["bad-request", 400, "not json"],
    ["bad-request", 400, { connectorId: "" }],
    ["bad-request", 400, { connectorId: "fixtures", extra: 1 }],
    ["bad-request", 400, { connectorId: "x".repeat(20_000) }],
    ["not-found", 404, { connectorId: "nope" }],
    ["connector-unavailable", 409, { connectorId: "site-mail" }],
    ["internal-error", 500, { connectorId: "broken" }],
  ])("sync %s rejection (%i)", async (error, status, body) => {
    const res = await send(server.port, sync.path, valid, sync.method, body);
    expect(res.status).toBe(status);
    expect(ErrorResponseSchema.parse(res.body)).toEqual({ error });
  });

  it.each([
    ["unauthorized", "/api/status", "GET", { authorization: "Bearer wrong" }],
    ["forbidden-host", "/api/status", "GET", { host: "evil.example" }],
    ["forbidden-origin", "/api/status", "GET", { origin: "https://evil.example" }],
    ["not-found", "/api/nope", "GET", {}],
    ["method-not-allowed", "/api/status", "POST", {}],
    ["bad-request", "http://evil.example/api/status", "GET", {}],
  ])("%s rejection", async (error, path, method, override) => {
    const res = await send(server.port, path, { ...valid, ...override }, method);
    expect(ErrorResponseSchema.parse(res.body)).toEqual({ error });
  });
});
