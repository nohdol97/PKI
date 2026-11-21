// V01-C5 `secrets`, the backend's half (V01-R13, ADR 0010): the API key reaches the
// endpoint as the request's bearer token and nowhere else — not in Broker results,
// history rows, any API answer, log lines, the data directory's files or new
// temporary files — even when the server fails by echoing it back. Without a usable
// store the Provider is unavailable and nothing is sent. The shell's half (the key
// is only ciphertext on disk; no store, no file) is apps/desktop/src/secret-store.test.ts.
import { OPENAI_API_KEY_SECRET, routes, type SecretRead } from "@pki/contracts";
import {
  createBroker,
  createCallRecorder,
  createEgressPolicy,
  createUserActionLedger,
  OPENAI_BASE_URL_SETTING,
  OPENAI_MODEL_SETTING,
} from "@pki/providers";
import { OpenAICompatibleProvider } from "@pki/providers/adapters";
import { writeSetting, type SqlDriver } from "@pki/storage";
import {
  completion,
  send,
  startFakeOpenAI,
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

function setup(read: SecretRead) {
  const egress = createEgressPolicy({ db, allowLoopbackHttp: true });
  egress.grant("openai-compatible", ["synthetic", "general"], {
    destination: server.host,
    policyVersion: egress.policyVersion(),
  });
  const provider = new OpenAICompatibleProvider({
    db,
    secrets: { read: async () => read },
    allowLoopbackHttp: true,
  });
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
  return { egress, provider, connectionTest };
}

async function apiAnswers(egress: ReturnType<typeof createEgressPolicy>) {
  const api = await startServer({
    token: TOKEN,
    allowedOrigins: [],
    connectors,
    db,
    dataDirectory: dir,
    egress,
    ...productAdapters(),
  });
  const headers = { host: `127.0.0.1:${api.port}`, authorization: `Bearer ${TOKEN}` };
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
    const tempBefore = new Set(readdirSync(tmpdir()));
    const { egress, connectionTest } = setup({ state: "present", value: KEY_CANARY });
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

    const answers = await apiAnswers(egress);
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
    const created = readdirSync(tmpdir()).filter((name) => !tempBefore.has(name));
    for (const name of created) {
      try {
        for (const file of filesUnder(join(tmpdir(), name))) {
          expect(readFileSync(file).includes(KEY_CANARY)).toBe(false);
        }
      } catch {
        // a sibling's directory removed while we looked, or a plain file: not ours
      }
    }
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

  it("asks the store for the key by its fixed name", async () => {
    const asked: string[] = [];
    const provider = new OpenAICompatibleProvider({
      db,
      secrets: { read: async (name) => (asked.push(name), { state: "missing" }) },
      allowLoopbackHttp: true,
    });
    await provider.checkHealth();
    expect(asked).toEqual([OPENAI_API_KEY_SECRET]);
  });
});
