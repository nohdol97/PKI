// V01-C5 `secrets`, the backend's half (V01-R13, ADR 0010): the API key reaches the
// endpoint as the request's bearer token and nowhere else — not in Broker results,
// history rows, any API answer, log lines, the data directory's files or new
// temporary files — even when the server fails by echoing it back. Without a usable
// store the Provider is unavailable and nothing is sent. The shell's half (the key
// is only ciphertext on disk; no store, no file) is apps/desktop/src/secret-store.test.ts.
import { routes, type SecretRead, type SecretSource } from "@pki/contracts";
import {
  createBroker,
  createCallRecorder,
  createEgressPolicy,
  createUserActionLedger,
  OPENAI_BASE_URL_SETTING,
  OPENAI_MODEL_SETTING,
  openaiKeySecretName,
} from "@pki/providers";
import { OpenAICompatibleProvider } from "@pki/providers/adapters";
import { writeSetting, type SqlDriver } from "@pki/storage";
import {
  completion,
  newTempFilesContaining,
  send,
  startFakeOpenAI,
  tempEntries,
  type FakeHttpReply,
  type FakeOpenAIServer,
} from "@pki/testkit";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openCanonicalDb, productAdapters } from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import { startServer } from "./server.ts";

const TOKEN = "k".repeat(43);
const run = randomUUID().slice(0, 8);
const KEY_CANARY = `sk-KEY-CANARY-${run}`;
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };

let dir: string;
let db: SqlDriver;
let server: FakeOpenAIServer;
let replies: ((key: string) => FakeHttpReply)[];
let logged: string[];
let spies: { mockRestore(): void }[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pki-secrets-"));
  db = openCanonicalDb(dir);
  replies = [];
  // Every failure repeats the key it was sent, as a careless server may.
  server = await startFakeOpenAI((request) => {
    const key = String(request.headers.authorization ?? "");
    return (replies.shift() ?? (() => completion('{"reply":"ok"}')))(key);
  });
  writeSetting(db, OPENAI_BASE_URL_SETTING, server.baseUrl);
  writeSetting(db, OPENAI_MODEL_SETTING, "synthetic-model");
  logged = [];
  const keep = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  spies = (["error", "warn", "log", "info", "debug"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(keep),
  );
});
afterEach(async () => {
  for (const spy of spies) spy.mockRestore();
  await server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function filesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

/** The shell's store as the backend sees it: `read` held for the key of `host` only. */
function storeFor(host: string, read: SecretRead): SecretSource & { asked: string[] } {
  const asked: string[] = [];
  const name = openaiKeySecretName(host);
  return {
    asked,
    read: async (n) => (asked.push(n), n === name ? read : { state: "missing" }),
    has: async (n) => (n === name ? read.state : "missing"),
  };
}

function setup(read: SecretRead) {
  const egress = createEgressPolicy({ db, allowLoopbackHttp: true });
  egress.grant("openai-compatible", ["synthetic", "general"], {
    destination: server.host,
    policyVersion: egress.policyVersion(),
  });
  const secrets = storeFor(server.host, read);
  const provider = new OpenAICompatibleProvider({ db, secrets, allowLoopbackHttp: true, egress });
  const ledger = createUserActionLedger();
  const broker = createBroker({
    db,
    provider: () => provider,
    userActions: ledger.redeemer,
    candidates: { lookup: () => undefined },
    egress,
    execution: { decide: () => ({ run: true }) },
    recorder: createCallRecorder(db),
    clock: { now: () => 0, sleep: async () => undefined },
  });
  const connectionTest = () =>
    ledger.issuer.during((userActionId) =>
      broker.call({
        taskKind: "connection-test",
        sourceVersionIds: [],
        candidateItemIds: [],
        origin: { userActionId },
        schemaVersion: 1,
        budget: { timeoutMs: 1000 },
        retryable: false,
      }),
    );
  return { egress, provider, secrets, connectionTest };
}

async function startApi(egress: ReturnType<typeof createEgressPolicy>, secrets?: SecretSource) {
  const api = await startServer({
    token: TOKEN,
    allowedOrigins: [],
    connectors,
    db,
    dataDirectory: dir,
    egress,
    ...(secrets ? { secrets } : {}),
    ...productAdapters(dir),
  });
  const headers = { host: `127.0.0.1:${api.port}`, authorization: `Bearer ${TOKEN}` };
  return { api, headers };
}

async function apiAnswers(egress: ReturnType<typeof createEgressPolicy>, secrets?: SecretSource) {
  const { api, headers } = await startApi(egress, secrets);
  try {
    return await Promise.all(
      [routes.status, routes.activity, routes.settings, routes.consents].map((r) =>
        send(api.port, r.path, headers),
      ),
    );
  } finally {
    await api.close();
  }
}

describe("the API key is used and left nowhere", () => {
  it("in results, history, API answers, logs, data files or temp files", async () => {
    const tempBefore = tempEntries();
    const { egress, secrets, connectionTest } = setup({ state: "present", value: KEY_CANARY });
    replies = [
      () => completion('{"reply":"ok"}'),
      (key) => ({ status: 500, body: { error: { message: `bad key ${key}` } } }),
      (key) => ({ status: 401, body: `invalid api key: ${key}` }),
      (key) => ({ status: 429, headers: { "retry-after": "1" }, body: key }),
      (key) => completion(JSON.stringify({ reply: key, extra: key })),
      (key) => completion(`not json ${key}`),
    ];
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await connectionTest());

    // the key really went out on every call: this test would see an echo leak
    const sent = server.requests.map((r) => r.headers.authorization);
    expect(sent).toEqual(Array(6).fill(`Bearer ${KEY_CANARY}`));
    expect(results.map((r) => r.status)).toEqual([
      "ok",
      "failed",
      "failed",
      "failed",
      "failed",
      "failed",
    ]);

    const answers = await apiAnswers(egress, secrets);
    const texts = [
      JSON.stringify(results),
      JSON.stringify(db.all("SELECT * FROM provider_calls")),
      JSON.stringify(db.all("SELECT * FROM settings")),
      JSON.stringify(answers),
      logged.join("\n"),
    ];
    for (const text of texts) expect(text).not.toContain(KEY_CANARY);
    // the Provider did log its failures, by code
    expect(logged.some((l) => l.includes("provider-call-failed"))).toBe(true);

    db.close();
    for (const file of filesUnder(dir)) {
      expect(readFileSync(file).includes(KEY_CANARY), file).toBe(false);
    }
    db = openCanonicalDb(dir);
    expect(newTempFilesContaining(tempBefore, KEY_CANARY)).toEqual([]);
  });

  it.each([
    ["no usable store", { state: "unavailable" } as const, "secret-store-unavailable"],
    ["no key stored", { state: "missing" } as const, "api-key-missing"],
  ])("with %s the Provider is unavailable and sends nothing", async (_name, read, reason) => {
    const { provider, connectionTest } = setup(read);
    expect(await provider.checkHealth()).toEqual({ state: "unavailable", reason });
    const result = await connectionTest();
    expect(result).toMatchObject({ status: "failed", error: "provider-error" });
    expect(server.requests).toEqual([]);
  });

  // review A-F3/B-B1: what a compromised page could do with the session token alone
  it("sends no key to a host the page re-points the endpoint and grants consent to", async () => {
    const { egress, secrets, connectionTest } = setup({ state: "present", value: KEY_CANARY });
    expect((await connectionTest()).status).toBe("ok");
    const attacker = await startFakeOpenAI();
    const { api, headers } = await startApi(egress, secrets);
    try {
      const moved = await send(api.port, routes.writeSettings.path, headers, "POST", {
        openaiCompatible: { baseUrl: attacker.baseUrl, model: "synthetic-model" },
      });
      expect(moved.body).toMatchObject({ openaiCompatible: { key: "missing" } });
      const consents = await send(api.port, routes.consents.path, headers);
      const { policyVersion } = consents.body as { policyVersion: string };
      const granted = await send(api.port, routes.grantConsent.path, headers, "POST", {
        providerId: "openai-compatible",
        allowedClasses: ["synthetic", "general"],
        destination: attacker.host,
        policyVersion,
      });
      expect(granted.status).toBe(200);
      expect(
        egress.decide({
          providerId: "openai-compatible",
          taskKind: "connection-test",
          classification: "synthetic",
        }),
      ).toMatchObject({ allowed: true, destination: attacker.host });

      const result = await connectionTest();
      expect(result).toMatchObject({ status: "failed", error: "provider-error" });
      expect(attacker.requests).toEqual([]);
      expect(server.requests).toHaveLength(1); // only the first, legitimate call
      expect(secrets.asked.at(-1)).toBe(openaiKeySecretName(attacker.host));
    } finally {
      await api.close();
      await attacker.close();
    }
  });

  // the gap review B4 named: consent revoked after the Broker decided, while the key is read
  it("sends nothing when the consent is revoked while the key is being read", async () => {
    const { egress, secrets, connectionTest } = setup({ state: "present", value: KEY_CANARY });
    const read = secrets.read;
    secrets.read = async (name) => (egress.revoke("openai-compatible"), read(name));
    const result = await connectionTest();
    expect(result).toMatchObject({ status: "failed", error: "provider-error" });
    expect(server.requests).toEqual([]);
  });

  it("checks presence only: health and the Settings answer never read the value", async () => {
    const { provider, secrets, egress } = setup({ state: "present", value: KEY_CANARY });
    expect(await provider.checkHealth()).toEqual({ state: "ok" });
    const [, , settings] = await apiAnswers(egress, secrets);
    expect(settings?.body).toMatchObject({ openaiCompatible: { key: "present" } });
    expect(secrets.asked).toEqual([]);
  });
});
