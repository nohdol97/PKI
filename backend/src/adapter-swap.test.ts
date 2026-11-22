// V01-C7 `adapter-swap` (V01-R17, spec "T17이 넘기는 것" 2·3): the backend booted as
// the product composes it (bootBackend, fixtureConnectors) and booted again with the
// Provider and the Embedding implementations replaced by doubles. The same API
// procedure a user's screens send runs against both: every response passes its
// @pki/contracts schema with no field outside it, and in the swapped configuration
// the doubles are the ones answering (the connection test reaches the Provider
// double, the preparation and the status reach the embedder double). The doubles
// are called only after the user's steps: the default Provider (providers.default,
// T10 handoff 11) and consent, both through the API. No real CLI, network or model.
import { routes, type RouteName } from "@pki/contracts";
import { FakeEmbedder, FakeProvider, send } from "@pki/testkit";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootBackend, type BootedBackend, type BootOptions } from "./boot.ts";
import { fixtureConnectors } from "./composition.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";

vi.setConfig({ testTimeout: 30_000 });

const TOKEN = "s".repeat(43);
const FIXTURES = resolve(import.meta.dirname, "../../fixtures/test-connector.jsonl");
/** What the search for "등대" finds in the fixtures, under either configuration. */
const FOUND = ["주간 회의록: 등대 점검", "회의 메모(악성 변형)"];

let dir: string;
let booted: BootedBackend | undefined;
let fetchCalls: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-adapter-swap-"));
  const noCli = join(dir, "no-cli");
  mkdirSync(noCli);
  // the product's CLI Providers find nothing; nothing may leave this process
  vi.stubEnv("PATH", noCli);
  fetchCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown) => {
      fetchCalls.push(String(url));
      return Promise.reject(new TypeError("fetch failed"));
    }),
  );
});

afterEach(async () => {
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

type Answer = { status: number; body: unknown };

/** Boots on a fresh data directory and returns a caller that checks each response against its schema. */
async function boot(swap: Pick<BootOptions, "providers" | "embedder">) {
  booted = await bootBackend({
    dataDir: join(dir, "data"),
    connectors: fixtureConnectors(FIXTURES),
    token: TOKEN,
    allowedOrigins: [],
    secrets: NO_SECRET_STORE,
    ...swap,
  });
  const port = booted.server.port;
  const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
  return async <Name extends RouteName>(name: Name, body?: unknown): Promise<Answer> => {
    const route = routes[name];
    const res = await send(port, route.path, headers, route.method, body);
    expect(res.status, name).toBe(200);
    // the schema the screens use, with nothing outside it
    expect(route.response.parse(res.body), name).toEqual(res.body);
    return res;
  };
}

/** What the screens send, in order: sync, list, search, pick and consent, test, prepare, status. */
async function procedure(call: Awaited<ReturnType<typeof boot>>, providerId: string, pack: string) {
  await call("syncConnector", { connectorId: "fixtures" });
  const listed = (await call("sources")).body as { sources: { title: string }[] };
  const found = (await call("searchSources", { query: "등대" })).body as {
    sources: { title: string }[];
  };
  const providers = (await call("providers")).body as { providers: { providerId: string }[] };
  await call("setDefaultProvider", { providerId });
  const overview = (await call("consents")).body as {
    policyVersion: string;
    providers: { providerId: string; destination: string | null }[];
  };
  const shown = overview.providers.find((p) => p.providerId === providerId);
  await call("grantConsent", {
    providerId,
    allowedClasses: ["synthetic", "general"],
    destination: shown?.destination ?? "",
    policyVersion: overview.policyVersion,
  });
  const test = (await call("connectionTest", { acknowledgeUnverified: false })).body;
  await call("prepareEmbedding", { source: { kind: "local-pack", path: pack } });
  let status = (await call("status")).body as { embedding: { state: string } };
  await expect
    .poll(async () => {
      status = (await call("status")).body as { embedding: { state: string } };
      return status.embedding.state;
    })
    .not.toBe("preparing");
  return {
    titles: listed.sources.map((s) => s.title).sort(),
    found: found.sources.map((s) => s.title).sort(),
    providerIds: providers.providers.map((p) => p.providerId),
    test,
    status,
  };
}

describe("adapter-swap (V01-C7, R17)", () => {
  it("the product's composition answers the procedure in schema, with no CLI and no network", async () => {
    const call = await boot({});
    const pack = join(dir, "missing-pack");
    const seen = await procedure(call, "claude-code", pack);
    expect(seen.titles).toHaveLength(5);
    expect(seen.found).toEqual(FOUND);
    expect(seen.providerIds).toEqual(["claude-code", "codex", "openai-compatible"]);
    expect(seen.test).toMatchObject({ outcome: "blocked", reason: "cli-not-verified" });
    expect(seen.status).toMatchObject({
      provider: { state: "unavailable", providerId: "claude-code", reason: "cli-not-installed" },
      embedding: { state: "unavailable", reason: "model file missing", egress: "local" },
    });
    expect(fetchCalls).toEqual([]);
  });

  it("with the Provider and the Embedding replaced, the same procedure answers in the same schema, from the doubles", async () => {
    const provider = new FakeProvider({
      id: "local-model",
      transport: "http",
      answer: (r) =>
        r.taskKind === "extract"
          ? { items: [], facts: [], relations: [], terms: [], definitions: [] }
          : { reply: "ok" },
    });
    const embedder = new FakeEmbedder();
    const call = await boot({ providers: [provider], embedder });
    // the boot read the status of nothing yet: the doubles start untouched
    expect(provider.requests).toEqual([]);
    expect(embedder.calls.prepare).toEqual([]);
    const pack = join(dir, "pack");
    const seen = await procedure(call, "local-model", pack);

    // what does not depend on the swapped parts is the product's
    expect(seen.titles).toHaveLength(5);
    expect(seen.found).toEqual(FOUND);
    expect(seen.providerIds).toEqual(["local-model"]);
    // the connection test reached the Provider double, once
    expect(seen.test).toEqual({ outcome: "ok", reason: null, isolation: null });
    expect(provider.requests.filter((r) => r.taskKind === "connection-test")).toHaveLength(1);
    // the preparation and the status reached the embedder double
    expect(embedder.calls.prepare).toEqual([{ kind: "local-pack", path: pack }]);
    expect(embedder.calls.status).toBeGreaterThan(0);
    expect(seen.status).toMatchObject({
      provider: { state: "ready", providerId: "local-model" },
      embedding: { state: "ready", egress: "local" },
    });
    expect(fetchCalls).toEqual([]);
  });

  it("without the user's default the Provider double is never called (T10 handoff 11)", async () => {
    const provider = new FakeProvider({ id: "local-model", transport: "http" });
    const call = await boot({ providers: [provider], embedder: new FakeEmbedder() });
    expect((await call("connectionTest", { acknowledgeUnverified: false })).body).toEqual({
      outcome: "blocked",
      reason: "no-provider",
      isolation: null,
    });
    expect(provider.requests).toEqual([]);
  });
});
