// The started backend (boot.ts, shared by dev.ts and shell.ts) binds the Broker to
// the connection-test API (V01-R21) and the background setting to the settings API,
// default off (V01-C7 cli-background-default). The product binds the OpenAI-compatible
// Provider (V01-T11): without an endpoint the connection test is blocked by the egress
// decision; with endpoint, model, key and consent it reaches the endpoint, through the
// same egress instance the consent API wrote.
import { routes, type SecretSource } from "@pki/contracts";
import { openaiKeySecretName } from "@pki/providers";
import { send, startFakeOpenAI } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootBackend } from "./boot.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";

const TOKEN = "t".repeat(43);
let dir: string;
let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-boot-"));
});
afterEach(async () => {
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("bootBackend", () => {
  it("serves the connection test and the background setting, default off", async () => {
    booted = await bootBackend({
      dataDir: dir,
      token: TOKEN,
      allowedOrigins: [],
      secrets: NO_SECRET_STORE,
    });
    const { port } = booted.server;
    const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
    const get = (path: string) => send(port, path, headers);
    const post = (path: string, body: unknown) => send(port, path, headers, "POST", body);

    expect((await post(routes.connectionTest.path, { acknowledgeUnverified: true })).body).toEqual({
      outcome: "blocked",
      reason: "destination-unavailable",
      isolation: null,
    });
    expect((await get(routes.executionSettings.path)).body).toEqual({ cliBackground: false });
    expect((await post(routes.setExecutionSettings.path, { cliBackground: true })).body).toEqual({
      cliBackground: true,
    });
    expect((await get(routes.executionSettings.path)).body).toEqual({ cliBackground: true });
    expect((await post(routes.setExecutionSettings.path, { cliBackground: false })).body).toEqual({
      cliBackground: false,
    });
  });

  it("runs a connection test through the bound OpenAI-compatible Provider", async () => {
    const endpoint = await startFakeOpenAI();
    const key = openaiKeySecretName(endpoint.host);
    const secrets: SecretSource = {
      read: async (n) =>
        n === key ? { state: "present", value: "sk-boot" } : { state: "missing" },
      has: async (n) => (n === key ? "present" : "missing"),
    };
    try {
      booted = await bootBackend({ dataDir: dir, token: TOKEN, allowedOrigins: [], secrets });
      const { port } = booted.server;
      const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
      const post = (path: string, body: unknown) => send(port, path, headers, "POST", body);
      await post(routes.writeSettings.path, {
        openaiCompatible: { baseUrl: endpoint.baseUrl, model: "synthetic-model" },
      });
      const consents = await send(port, routes.consents.path, headers);
      await post(routes.grantConsent.path, {
        providerId: "openai-compatible",
        allowedClasses: ["synthetic"],
        destination: endpoint.host,
        policyVersion: (consents.body as { policyVersion: string }).policyVersion,
      });
      expect(
        (await post(routes.connectionTest.path, { acknowledgeUnverified: false })).body,
      ).toEqual({
        outcome: "ok",
        reason: null,
        isolation: null,
      });
      expect(endpoint.requests.map((r) => r.headers.authorization)).toEqual(["Bearer sk-boot"]);
    } finally {
      await endpoint.close();
    }
  });
});
