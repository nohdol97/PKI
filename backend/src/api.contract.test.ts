// V01-C1 `api.contract`: every API response, success or rejection, matches the
// schema in @pki/contracts that the UI also uses.
import { ErrorResponseSchema, routes } from "@pki/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { send } from "@pki/testkit";
import { productAdapters } from "./composition.ts";
import { startServer, type RunningServer } from "./server.ts";

const TOKEN = "c".repeat(43);
let server: RunningServer;
let valid: Record<string, string>;

beforeAll(async () => {
  server = await startServer({ token: TOKEN, allowedOrigins: [], ...productAdapters() });
  valid = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` };
});
afterAll(() => server.close());

describe("API responses match @pki/contracts", () => {
  it.each(Object.entries(routes))("%s", async (_name, route) => {
    const res = await send(server.port, route.path, valid, route.method);
    expect(res.status).toBe(200);
    expect(route.response.parse(res.body)).toEqual(res.body);
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
