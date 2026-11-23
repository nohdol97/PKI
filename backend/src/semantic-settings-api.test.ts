// S01-T05: the settings API of `semantic.autoVerify` (S01-R9 1, provisional decision 3): default OFF,
// written only through this route as a boolean, kept across a restart, behind the token, Host and
// Origin checks every route has. Turning it on changes no row by itself: the judgement runs at the
// next extraction or propagation (auto-verify.test.ts, auto-verify-flow.test.ts).
import { ErrorResponseSchema, routes } from "@pki/contracts";
import { AUTO_VERIFY_SETTING } from "@pki/knowledge-engine";
import { readSetting, type SqlDriver } from "@pki/storage";
import { send } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCanonicalDb, productAdapters, productEgress } from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import { startServer, type RunningServer } from "./server.ts";

const TOKEN = "a".repeat(43);
const ORIGIN = "http://localhost:5173";
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };
let dir: string;
let db: SqlDriver;
let server: RunningServer;

async function boot() {
  db = openCanonicalDb(dir);
  server = await startServer({
    token: TOKEN,
    allowedOrigins: [ORIGIN],
    connectors,
    db,
    dataDirectory: dir,
    egress: productEgress(db),
    ...productAdapters(dir),
  });
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pki-semantic-settings-"));
  await boot();
});
afterEach(async () => {
  await server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const good = () => ({ host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` });
const read = (headers: Record<string, string> = good()) =>
  send(server.port, routes.semanticSettings.path, headers, routes.semanticSettings.method);
const write = (body: unknown, headers: Record<string, string> = good()) =>
  send(
    server.port,
    routes.setSemanticSettings.path,
    headers,
    routes.setSemanticSettings.method,
    body,
  );

describe("semantic settings API", () => {
  it("is /api/settings/semantic and starts OFF without writing anything", async () => {
    expect(routes.semanticSettings).toMatchObject({
      method: "GET",
      path: "/api/settings/semantic",
    });
    expect(routes.setSemanticSettings).toMatchObject({
      method: "POST",
      path: "/api/settings/semantic",
    });
    const res = await read();
    expect(res).toEqual({ status: 200, body: { autoVerify: false, autoDispute: false } });
    expect(readSetting(db, AUTO_VERIFY_SETTING)).toBeUndefined();
  });

  it("turns it on and off, the response is the new value and the answer matches the contract", async () => {
    const on = await write({ autoVerify: true });
    expect(on.status).toBe(200);
    expect(routes.setSemanticSettings.response.parse(on.body)).toEqual({
      autoVerify: true,
      autoDispute: false,
    });
    expect(readSetting(db, AUTO_VERIFY_SETTING)).toBe("on");
    expect((await read()).body).toEqual({ autoVerify: true, autoDispute: false });
    expect((await write({ autoVerify: false })).body).toEqual({
      autoVerify: false,
      autoDispute: false,
    });
    expect(readSetting(db, AUTO_VERIFY_SETTING)).toBe("off");
    expect((await read()).body).toEqual({ autoVerify: false, autoDispute: false });
  });

  it("autoDispute (S02-R20) is off by default, round-trips, and is left alone when the request omits it", async () => {
    expect((await write({ autoVerify: false, autoDispute: true })).body).toEqual({
      autoVerify: false,
      autoDispute: true,
    });
    expect(readSetting(db, "semantic.autoDispute")).toBe("on");
    expect((await write({ autoVerify: true })).body).toEqual({
      autoVerify: true,
      autoDispute: true,
    });
  });

  it("is still on after the app restarts", async () => {
    await write({ autoVerify: true });
    await server.close();
    db.close();
    await boot();
    expect((await read()).body).toEqual({ autoVerify: true, autoDispute: false });
  });

  it.each([
    ["a string", { autoVerify: "on" }],
    ["a number", { autoVerify: 1 }],
    ["null", { autoVerify: null }],
    ["a missing value", {}],
    ["an extra key", { autoVerify: true, other: 1 }],
    ["not json", "not json"],
  ])("rejects %s with bad-request and stores nothing", async (_name, body) => {
    await write({ autoVerify: false });
    const res = await write(body);
    expect(res.status).toBe(400);
    expect(ErrorResponseSchema.parse(res.body)).toEqual({ error: "bad-request" });
    expect(readSetting(db, AUTO_VERIFY_SETTING)).toBe("off");
  });

  it("rejects a missing or wrong token, a foreign Host and a foreign Origin, writing nothing", async () => {
    const { host } = good();
    const cases: [string, Record<string, string>, number, string][] = [
      ["no token", { host }, 401, "unauthorized"],
      ["wrong token", { host, authorization: `Bearer ${"b".repeat(43)}` }, 401, "unauthorized"],
      ["foreign host", { ...good(), host: "evil.example" }, 403, "forbidden-host"],
      ["foreign origin", { ...good(), origin: "https://evil.example" }, 403, "forbidden-origin"],
    ];
    for (const [, headers, status, error] of cases) {
      for (const res of [await write({ autoVerify: true }, headers), await read(headers)]) {
        expect(res.status).toBe(status);
        expect(ErrorResponseSchema.parse(res.body)).toEqual({ error });
      }
    }
    expect(readSetting(db, AUTO_VERIFY_SETTING)).toBeUndefined();
  });

  it("accepts the allowed Origin and refuses another method on the path", async () => {
    expect((await write({ autoVerify: true }, { ...good(), origin: ORIGIN })).status).toBe(200);
    const res = await send(server.port, routes.semanticSettings.path, good(), "DELETE");
    expect(res.status).toBe(405);
    expect(ErrorResponseSchema.parse(res.body)).toEqual({ error: "method-not-allowed" });
  });
});
