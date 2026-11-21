// The settings API that writes the OpenAI-compatible endpoint and model (V01-R11,
// spec "T08이 넘기는 것" 4). Only an `https` address, or `http` to loopback, without
// user info, query or fragment, is stored; whether loopback `http` is then used is
// the egress policy's call (build kind). The API key is never a setting.
import { ErrorResponseSchema, routes, type SecretSource } from "@pki/contracts";
import {
  BUILD_KIND,
  OPENAI_BASE_URL_SETTING,
  OPENAI_MODEL_SETTING,
  openaiKeySecretName,
} from "@pki/providers";
import { readSetting, type SqlDriver } from "@pki/storage";
import { send } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCanonicalDb, productAdapters, productEgress } from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import { startServer, type RunningServer } from "./server.ts";

const TOKEN = "s".repeat(43);
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };
let dir: string;
let db: SqlDriver;
let server: RunningServer;
/** The key store the backend asks (the shell in Electron): one key, for one host. */
const stored = new Set<string>();
const secrets: SecretSource = {
  read: async () => ({ state: "unavailable" }),
  has: async (name) => (stored.has(name) ? "present" : "missing"),
};

beforeEach(async () => {
  stored.clear();
  dir = mkdtempSync(join(tmpdir(), "pki-settings-"));
  db = openCanonicalDb(dir);
  server = await startServer({
    token: TOKEN,
    allowedOrigins: [],
    connectors,
    db,
    dataDirectory: dir,
    egress: productEgress(db),
    secrets,
    ...productAdapters(dir),
  });
});
afterEach(async () => {
  await server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = (method: string, body?: unknown) =>
  send(
    server.port,
    routes.settings.path,
    { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` },
    method,
    body,
  );
const write = (baseUrl: string, model = "synthetic-model") =>
  call("POST", { openaiCompatible: { baseUrl, model } });

describe("settings API: the OpenAI-compatible endpoint", () => {
  it("starts unset", async () => {
    expect((await call("GET")).body).toMatchObject({
      openaiCompatible: { baseUrl: null, model: null, host: null, keyName: null, key: null },
    });
  });

  // review A-F3/B-B1: a key belongs to the host it was entered for
  it("shows the key for the endpoint's host only; a new host needs the key again", async () => {
    stored.add(openaiKeySecretName("one.synthetic.example"));
    await write("https://one.synthetic.example/v1");
    expect((await call("GET")).body).toMatchObject({
      openaiCompatible: {
        host: "one.synthetic.example",
        keyName: openaiKeySecretName("one.synthetic.example"),
        key: "present",
      },
    });
    const moved = await write("https://two.synthetic.example/v1");
    expect(moved.body).toMatchObject({
      openaiCompatible: {
        host: "two.synthetic.example",
        keyName: openaiKeySecretName("two.synthetic.example"),
        key: "missing",
      },
    });
  });

  it("stores an https endpoint and the model, which the consent list then names", async () => {
    const res = await write("https://api.synthetic.example:8443/v1");
    expect(res.status).toBe(200);
    expect(routes.writeSettings.response.parse(res.body)).toMatchObject({
      openaiCompatible: {
        baseUrl: "https://api.synthetic.example:8443/v1",
        model: "synthetic-model",
      },
    });
    expect((await call("GET")).body).toMatchObject({
      openaiCompatible: {
        baseUrl: "https://api.synthetic.example:8443/v1",
        model: "synthetic-model",
      },
    });
    expect(productEgress(db).destination("openai-compatible")).toEqual({
      destination: "api.synthetic.example:8443",
    });
  });

  it("stores the parsed form, so what is shown is what the Provider sends to", async () => {
    await write("HTTPS://API.Synthetic.Example/v1");
    expect(readSetting(db, OPENAI_BASE_URL_SETTING)).toBe("https://api.synthetic.example/v1");
  });

  // whether loopback http is then used is the build kind's (providers/src/build-kind.test.ts)
  it("stores loopback http; this test build's egress policy then takes it", async () => {
    expect(BUILD_KIND).toBe("test");
    expect((await write("http://127.0.0.1:9/v1")).status).toBe(200);
    expect(productEgress(db).destination("openai-compatible")).toEqual({
      destination: "127.0.0.1:9",
    });
  });

  it.each([
    "http://api.synthetic.example/v1",
    "ftp://api.synthetic.example/v1",
    "https://user:pw@api.synthetic.example/v1",
    "https://user@api.synthetic.example/v1",
    "https://api.synthetic.example/v1?key=x",
    "https://api.synthetic.example/v1#x",
    "not a url",
  ])("refuses %s and keeps the earlier value", async (url) => {
    await write("https://api.synthetic.example/v1", "kept-model");
    const res = await write(url);
    expect(res.status).toBe(400);
    expect(ErrorResponseSchema.parse(res.body)).toEqual({ error: "invalid-endpoint" });
    expect(readSetting(db, OPENAI_BASE_URL_SETTING)).toBe("https://api.synthetic.example/v1");
    expect(readSetting(db, OPENAI_MODEL_SETTING)).toBe("kept-model");
  });

  it.each([
    [{ openaiCompatible: { baseUrl: "https://a.example/v1" } }],
    [{ openaiCompatible: { baseUrl: "https://a.example/v1", model: "" } }],
    [{ openaiCompatible: { baseUrl: "https://a.example/v1", model: "m", apiKey: "sk-x" } }],
    [{ openaiCompatible: { baseUrl: "https://a.example/v1", model: "m" }, apiKey: "sk-x" }],
  ])("rejects a malformed body, an API key field included: %j", async (body) => {
    const res = await call("POST", body);
    expect(res).toEqual({ status: 400, body: { error: "bad-request" } });
    expect(readSetting(db, OPENAI_BASE_URL_SETTING)).toBeUndefined();
  });
});
