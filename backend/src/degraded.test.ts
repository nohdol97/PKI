// V01-T16 / R5, C3, C6: the five degraded states — CLI 없음, 네트워크 없음, 전송 거부,
// embedding 모델 없음, 벡터 색인 사용 불가. From a healthy configuration, each test
// takes one part away: the status API names what no longer works, the stored sources
// still list and keyword search still finds them, and a blocked Provider is never
// replaced by another one. The last test boots the product as it ships, on a PC with
// no CLI and no network, where all five hold at once. No real CLI, network or model:
// the fake CLI, a rejecting fetch, the fake embedder.
import {
  routes,
  type EmbeddingProvider,
  type SecretSource,
  type StatusResponse,
  type VectorIndex,
} from "@pki/contracts";
import {
  DEFAULT_PROVIDER_SETTING,
  OPENAI_BASE_URL_SETTING,
  OPENAI_MODEL_SETTING,
  openaiKeySecretName,
} from "@pki/providers";
import {
  createClaudeCodeProvider,
  createCodexProvider,
  OpenAICompatibleProvider,
} from "@pki/providers/adapters";
import { registerConnectorInstance, saveSourceRecord, writeSetting } from "@pki/storage";
import type { SqlDriver } from "@pki/storage";
import { EmptyVectorIndex } from "@pki/storage/adapters";
import { FakeEmbedder, installFakeCli, MemoryVectorIndex, send, type FakeCli } from "@pki/testkit";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootBackend, type BootedBackend } from "./boot.ts";
import { openCanonicalDb, productAdapters, productCalls, productEgress } from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";
import { startServer, type RunningServer } from "./server.ts";

// fake CLI runs are Node starts: slow when the whole suite runs in parallel
vi.setConfig({ testTimeout: 30_000 });

const TOKEN = "d".repeat(43);
const ENDPOINT = "https://api.synthetic.example/v1";
const KEY = openaiKeySecretName("api.synthetic.example");
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };
/** Whether the synthetic key is stored; a test may save it while the server runs. */
let keyStored = true;
const keyStore: SecretSource = {
  read: async (n) =>
    n === KEY && keyStored ? { state: "present", value: "sk-synthetic" } : { state: "missing" },
  has: async (n) => (n === KEY && keyStored ? "present" : "missing"),
  deleteOthers: async () => "done",
};

let dir: string;
let db: SqlDriver;
let fake: FakeCli;
let server: RunningServer | undefined;
let headers: Record<string, string>;
let fetchCalls: string[];

interface Parts {
  /** PATH the CLI Providers search; default: the fake CLI's folder. */
  path?: string;
  embedder?: EmbeddingProvider | null;
  vectorIndex?: VectorIndex;
  /** The server's clock for the Provider check's reuse window (default: real time). */
  now?: () => number;
  egress?: ReturnType<typeof productEgress>;
}

async function start(parts: Parts = {}) {
  const egress = parts.egress ?? productEgress(db);
  const env = { PATH: parts.path ?? fake.bin };
  const providers = [
    createClaudeCodeProvider({ env }),
    createCodexProvider({ env }),
    new OpenAICompatibleProvider({ db, secrets: keyStore, allowLoopbackHttp: false, egress }),
  ];
  const embedder = parts.embedder === undefined ? await readyEmbedder() : parts.embedder;
  server = await startServer({
    token: TOKEN,
    allowedOrigins: [],
    connectors,
    db,
    dataDirectory: dir,
    egress,
    secrets: keyStore,
    calls: productCalls(db, egress, { providers }),
    vectorIndex: parts.vectorIndex ?? new MemoryVectorIndex(),
    embedder,
    ...(parts.now ? { now: parts.now } : {}),
  });
  headers = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` };
}

async function readyEmbedder() {
  const embedder = new FakeEmbedder();
  await embedder.prepare({ kind: "download" }, new AbortController().signal);
  return embedder;
}

const port = () => server?.port ?? 0;
const get = (path: string) => send(port(), path, headers);
const post = (path: string, body?: unknown) => send(port(), path, headers, "POST", body);
const status = async (): Promise<StatusResponse> =>
  routes.status.response.parse((await get(routes.status.path)).body);

function grant(
  providerId: "claude-code" | "codex" | "openai-compatible",
  classes: ("synthetic" | "general")[] = ["synthetic", "general"],
) {
  const egress = productEgress(db);
  const current = egress.destination(providerId);
  if (!("destination" in current)) throw new Error("no destination to consent to");
  egress.grant(providerId, classes, {
    destination: current.destination,
    policyVersion: egress.policyVersion(),
  });
}

/** What every degraded state must keep (V01-R5): the stored list and keyword search. */
async function explorationWorks() {
  const listed = routes.sources.response.parse((await get(routes.sources.path)).body);
  expect(listed.sources.map((s) => s.title).sort()).toEqual(["합성 등대 점검", "합성 부두 공지"]);
  const found = routes.searchSources.response.parse(
    (await post(routes.searchSources.path, { query: "등대" })).body,
  );
  expect(found.sources.map((s) => s.title)).toEqual(["합성 등대 점검"]);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-degraded-"));
  db = openCanonicalDb(join(dir, "data"));
  registerConnectorInstance(db, "fixtures", "test-fixtures");
  saveSourceRecord(db, "fixtures", {
    externalId: "d1",
    title: "합성 등대 점검",
    body: "합성 자료",
  });
  saveSourceRecord(db, "fixtures", {
    externalId: "d2",
    title: "합성 부두 공지",
    body: "합성 자료",
  });
  // codex: the one fake CLI with a login status command
  fake = installFakeCli({ auth: "logged-in" }, dir);
  writeSetting(db, DEFAULT_PROVIDER_SETTING, "codex");
  grant("codex");
  fetchCalls = [];
  keyStored = true;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown) => {
      fetchCalls.push(String(url));
      return Promise.reject(new TypeError("fetch failed"));
    }),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await server?.close();
  server = undefined;
  expect(await fake.leftovers()).toEqual([]);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("degraded states (V01-R5)", () => {
  it("starts from a configuration where every part works", async () => {
    await start();
    expect(await status()).toEqual({
      backend: { state: "ready" },
      provider: { state: "ready", providerId: "codex" },
      embedding: { state: "ready", egress: "local" },
      vectorIndex: { state: "ready" },
      invalidations: { recent: [] },
    });
    await explorationWorks();
  });

  it("CLI 없음: the default CLI is reported missing with what was found, and nothing else runs", async () => {
    const empty = join(dir, "empty-bin");
    mkdirSync(empty);
    await start({ path: empty });
    const { provider, ...rest } = await status();
    expect(provider).toEqual({
      state: "unavailable",
      providerId: "codex",
      reason: "cli-not-installed",
      check: { providerId: "codex", installed: false, version: null, authentication: "unknown" },
    });
    expect(rest.embedding.state).toBe("ready");
    await explorationWorks();
    // the OpenAI-compatible Provider has an endpoint, a key and is not the default: not called
    writeSetting(db, OPENAI_BASE_URL_SETTING, ENDPOINT);
    writeSetting(db, OPENAI_MODEL_SETTING, "synthetic-model");
    grant("openai-compatible");
    const test = await post(routes.connectionTest.path, { acknowledgeUnverified: false });
    expect(test.body).toMatchObject({ outcome: "blocked" });
    expect(fetchCalls).toEqual([]);
  });

  it("CLI 로그인 안 됨: a logged-out default CLI is reported with the login state", async () => {
    fake.configure({ auth: "logged-out" });
    await start();
    expect((await status()).provider).toEqual({
      state: "unavailable",
      providerId: "codex",
      reason: "cli-not-logged-in",
      check: {
        providerId: "codex",
        installed: true,
        version: "2.1.3",
        authentication: "unauthenticated",
      },
    });
    await explorationWorks();
    expect(fake.modelCalls()).toBe(0);
  });

  it("네트워크 없음: the download and the HTTP call fail where they are made; no other Provider runs", async () => {
    // the product's embedder, its download going through the rejecting fetch
    const { embedder } = productAdapters(join(dir, "data"));
    await start({ embedder });
    // the first status read runs the default CLI's check; the polls below reuse it
    expect((await status()).provider.state).toBe("ready");
    const prepared = await post(routes.prepareEmbedding.path, { source: { kind: "download" } });
    expect(prepared.status).toBe(200);
    await expect
      .poll(async () => (await status()).embedding)
      .toEqual({ state: "unavailable", reason: "model download failed", egress: "local" });
    expect(fetchCalls.length).toBeGreaterThan(0);
    expect(fetchCalls.every((u) => u.startsWith("https://huggingface.co/"))).toBe(true);

    fetchCalls.length = 0;
    writeSetting(db, OPENAI_BASE_URL_SETTING, ENDPOINT);
    writeSetting(db, OPENAI_MODEL_SETTING, "synthetic-model");
    writeSetting(db, DEFAULT_PROVIDER_SETTING, "openai-compatible");
    grant("openai-compatible");
    // the status reads settings and the key's presence only: no probe goes out
    expect((await status()).provider).toEqual({ state: "ready", providerId: "openai-compatible" });
    expect(fetchCalls).toEqual([]);
    const test = await post(routes.connectionTest.path, { acknowledgeUnverified: false });
    expect(test.body).toMatchObject({ outcome: "failed" });
    expect(fetchCalls.every((u) => u.startsWith(ENDPOINT))).toBe(true);
    // the logged-in, consented fake CLI is not used instead
    expect(fake.modelCalls()).toBe(0);
    await explorationWorks();
  });

  it("전송 거부: without consent the default is reported blocked, and no call goes anywhere", async () => {
    productEgress(db).revoke("codex");
    await start();
    expect((await status()).provider).toEqual({
      state: "unavailable",
      providerId: "codex",
      reason: "no-consent",
    });
    const test = await post(routes.connectionTest.path, { acknowledgeUnverified: false });
    expect(test.body).toMatchObject({ outcome: "blocked", reason: "no-consent" });
    expect(fake.modelCalls()).toBe(0);
    expect(fetchCalls).toEqual([]);
    await explorationWorks();
  });

  it("전송 거부: no default chosen is its own reason", async () => {
    db.run("DELETE FROM settings WHERE key = ?", [DEFAULT_PROVIDER_SETTING]);
    await start();
    expect((await status()).provider).toEqual({
      state: "unavailable",
      providerId: null,
      reason: "no-provider",
    });
    expect(fake.runs()).toEqual([]);
    await explorationWorks();
  });

  it("Claude Code has no login status command: ready, with the unknown login carried for guidance", async () => {
    writeSetting(db, DEFAULT_PROVIDER_SETTING, "claude-code");
    grant("claude-code");
    await start();
    expect((await status()).provider).toEqual({
      state: "ready",
      providerId: "claude-code",
      check: {
        providerId: "claude-code",
        installed: true,
        version: "2.1.3",
        authentication: "unknown",
      },
    });
  });

  it("전송 거부: a consent for synthetic material only does not cover a general document", async () => {
    productEgress(db).revoke("codex");
    grant("codex", ["synthetic"]);
    await start();
    expect((await status()).provider).toEqual({
      state: "unavailable",
      providerId: "codex",
      reason: "no-matching-rule",
    });
    await explorationWorks();
  });

  it("a Provider status that cannot be read degrades only its own row", async () => {
    const egress = productEgress(db);
    await start({
      egress: {
        ...egress,
        decide: () => {
          throw new TypeError("corrupt rules");
        },
      },
    });
    expect(await status()).toEqual({
      backend: { state: "ready" },
      provider: { state: "unavailable", providerId: null, reason: "status-check-failed" },
      embedding: { state: "ready", egress: "local" },
      vectorIndex: { state: "ready" },
      invalidations: { recent: [] },
    });
    await explorationWorks();
  });

  it("embedding 모델 없음: the model is reported missing and nothing prepares it", async () => {
    const embedder = new FakeEmbedder();
    await start({ embedder });
    expect((await status()).embedding).toEqual({ state: "model-missing", egress: "local" });
    await explorationWorks();
    expect(embedder.calls.prepare).toEqual([]);
    expect(embedder.calls.embed).toEqual([]);
  });

  it("벡터 색인 사용 불가: the index is reported unavailable with its reason", async () => {
    await start({ vectorIndex: new EmptyVectorIndex() });
    expect((await status()).vectorIndex).toEqual({
      state: "unavailable",
      reason: "no vector index module in this build",
    });
    await explorationWorks();
  });
});

describe("the product on a PC with no CLI and no network (all five at once)", () => {
  let booted: BootedBackend | undefined;
  afterEach(async () => {
    await booted?.server.close();
    booted?.db.close();
    booted = undefined;
  });

  it("starts, lists and searches; Home's status names each missing part", async () => {
    const dataDir = join(dir, "product");
    const fixtures = join(dir, "seed.jsonl");
    writeFileSync(
      fixtures,
      [
        { externalId: "p1", title: "합성 등대 점검", body: "합성 자료" },
        { externalId: "p2", title: "합성 부두 공지", body: "합성 자료" },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n"),
    );
    const empty = join(dir, "no-cli");
    mkdirSync(empty);
    vi.stubEnv("PATH", empty);
    try {
      booted = await bootBackend({
        dataDir,
        fixtures,
        token: TOKEN,
        allowedOrigins: [],
        secrets: NO_SECRET_STORE,
      });
      server = undefined;
      const p = booted.server.port;
      headers = { host: `127.0.0.1:${p}`, authorization: `Bearer ${TOKEN}` };
      const call = (path: string, body?: unknown) =>
        send(p, path, headers, body === undefined ? "GET" : "POST", body);
      expect((await call(routes.syncConnector.path, { connectorId: "fixtures" })).status).toBe(200);
      const read = async () => routes.status.response.parse((await call(routes.status.path)).body);
      expect(await read()).toEqual({
        backend: { state: "ready" },
        provider: { state: "unavailable", providerId: null, reason: "no-provider" },
        embedding: { state: "model-missing", egress: "local" },
        vectorIndex: { state: "unavailable", reason: "no vector index module in this build" },
        invalidations: { recent: [] },
      });
      await call(routes.setDefaultProvider.path, { providerId: "claude-code" });
      expect((await read()).provider).toMatchObject({
        state: "unavailable",
        providerId: "claude-code",
        reason: "cli-not-installed",
      });
      const listed = routes.sources.response.parse((await call(routes.sources.path)).body);
      expect(listed.sources).toHaveLength(2);
      const found = routes.searchSources.response.parse(
        (await call(routes.searchSources.path, { query: "부두" })).body,
      );
      expect(found.sources.map((s) => s.title)).toEqual(["합성 부두 공지"]);
      expect(fetchCalls).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("the Provider check behind the status (T16 handoff 2)", () => {
  const queries = () => fake.runs().filter((r) => r.kind === "version" || r.kind === "auth");
  let clock: number;
  beforeEach(() => {
    clock = 1_000_000;
  });

  it("status reads that come together share one set of queries", async () => {
    await start({ now: () => clock });
    const all = await Promise.all([status(), status(), status()]);
    expect(all.map((s) => s.provider.state)).toEqual(["ready", "ready", "ready"]);
    expect(
      queries()
        .map((r) => r.kind)
        .sort(),
    ).toEqual(["auth", "version"]);
  });

  it("reuses the last check for 60 s, so reading status again runs nothing", async () => {
    await start({ now: () => clock });
    await status();
    fake.reset();
    clock += 59_000;
    for (let i = 0; i < 3; i++) await status();
    expect(queries()).toEqual([]);
    clock += 2_000;
    await status();
    expect(
      queries()
        .map((r) => r.kind)
        .sort(),
    ).toEqual(["auth", "version"]);
  });

  it('"Provider 확인" runs the queries again and the status shows what it found', async () => {
    await start({ now: () => clock });
    expect((await status()).provider.state).toBe("ready");
    fake.configure({ auth: "logged-out" });
    fake.reset();
    await post(routes.checkProviders.path);
    const ran = queries().length;
    expect(ran).toBeGreaterThan(0);
    expect((await status()).provider).toMatchObject({ reason: "cli-not-logged-in" });
    expect(queries()).toHaveLength(ran);
  });

  it("an HTTP default is read fresh: saving its endpoint or key shows at once", async () => {
    writeSetting(db, DEFAULT_PROVIDER_SETTING, "openai-compatible");
    await start({ now: () => clock });
    expect((await status()).provider).toMatchObject({ reason: "destination-unavailable" });
    const saved = await post(routes.writeSettings.path, {
      openaiCompatible: { baseUrl: ENDPOINT, model: "synthetic-model" },
    });
    expect(saved.status).toBe(200);
    grant("openai-compatible");
    expect((await status()).provider).toEqual({ state: "ready", providerId: "openai-compatible" });
    // a key saved in the shell's store reaches the backend without any API call here
    keyStored = false;
    expect((await status()).provider).toMatchObject({ reason: "api-key-missing" });
    keyStored = true;
    expect((await status()).provider.state).toBe("ready");
    expect(fetchCalls).toEqual([]);
  });

  it("choosing the default again forgets the CLI's kept check", async () => {
    await start({ now: () => clock });
    expect((await status()).provider.state).toBe("ready");
    fake.configure({ auth: "logged-out" });
    expect((await post(routes.setDefaultProvider.path, { providerId: "codex" })).status).toBe(200);
    expect((await status()).provider).toMatchObject({ reason: "cli-not-logged-in" });
  });

  it("saving the provider settings forgets the CLI's kept check too", async () => {
    await start({ now: () => clock });
    expect((await status()).provider.state).toBe("ready");
    fake.configure({ auth: "logged-out" });
    await post(routes.writeSettings.path, {
      openaiCompatible: { baseUrl: ENDPOINT, model: "synthetic-model" },
    });
    expect((await status()).provider).toMatchObject({ reason: "cli-not-logged-in" });
  });
});
