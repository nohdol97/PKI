// V01-T13 / R14, R5, C6 `embedding.missing`: the status API reads the embedding
// state from the configured EmbeddingProvider. With no model it says so, never
// prepares one on its own, and keyword search over stored sources keeps working.
import { routes, type EmbeddingProvider } from "@pki/contracts";
import { migrate, registerConnectorInstance, saveSourceRecord } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { FakeEmbedder, send } from "@pki/testkit";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { productAdapters, productEgress } from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import { startServer } from "./server.ts";

const TOKEN = "e".repeat(43);
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };
const db = openBetterSqlite3(":memory:");
migrate(db);
registerConnectorInstance(db, "fixtures", "test-fixtures");
saveSourceRecord(db, "fixtures", { externalId: "m1", title: "합성 등대 점검", body: "합성 자료" });

async function withServer<T>(
  embedder: EmbeddingProvider | null,
  use: (call: (path: string, method?: string, body?: unknown) => ReturnType<typeof send>) => T,
) {
  const server = await startServer({
    token: TOKEN,
    allowedOrigins: [],
    connectors,
    db,
    dataDirectory: "/synthetic/data",
    egress: productEgress(db),
    ...productAdapters("/synthetic/data"),
    embedder,
  });
  const headers = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` };
  try {
    return await use((path, method = "GET", body) =>
      send(server.port, path, headers, method, body),
    );
  } finally {
    await server.close();
  }
}

const embeddingStatus = (embedder: EmbeddingProvider | null) =>
  withServer(embedder, async (call) => {
    const res = await call(routes.status.path);
    expect(res.status).toBe(200);
    return routes.status.response.parse(res.body);
  });

describe("status API: embedding", () => {
  it("reports the API's own word when no embedder is bound", async () => {
    expect((await embeddingStatus(null)).embedding).toEqual({ state: "not-implemented" });
  });

  it("embedding.missing: the product's embedder starts without a model and downloads nothing", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pki-embed-product-"));
    const fetch = vi.fn(() => Promise.reject(new Error("no network in this test")));
    vi.stubGlobal("fetch", fetch);
    try {
      const { embedder } = productAdapters(dataDir);
      expect(embedder?.describe().egress).toBe("local");
      await withServer(embedder, async (call) => {
        for (let i = 0; i < 3; i++) {
          const status = routes.status.response.parse((await call(routes.status.path)).body);
          expect(status.embedding).toEqual({ state: "model-missing", egress: "local" });
        }
        const found = await call(routes.searchSources.path, "POST", { query: "등대" });
        expect(routes.searchSources.response.parse(found.body).sources).toHaveLength(1);
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(readdirSync(dataDir)).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("embedding.missing: reports the missing model, prepares nothing, and keyword search works", async () => {
    const fake = new FakeEmbedder();
    await withServer(fake, async (call) => {
      for (let i = 0; i < 3; i++) {
        const status = routes.status.response.parse((await call(routes.status.path)).body);
        expect(status.embedding).toEqual({ state: "model-missing", egress: "local" });
        expect(status.backend).toEqual({ state: "ready" });
      }
      const found = await call(routes.searchSources.path, "POST", { query: "등대" });
      expect(found.status).toBe(200);
      expect(routes.searchSources.response.parse(found.body).sources).toEqual([
        expect.objectContaining({ title: "합성 등대 점검" }),
      ]);
    });
    expect(fake.calls.status).toBe(3);
    expect(fake.calls.prepare).toEqual([]);
    expect(fake.calls.embed).toEqual([]);
  });

  it("installs the product's models under <dataDir>/models", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pki-embed-location-"));
    try {
      // A leftover staging folder there is swept by the next preparation; one
      // anywhere else is not, so this pins where the product's models live.
      mkdirSync(join(dataDir, "models", ".staging-stale"), { recursive: true });
      const { embedder } = productAdapters(dataDir);
      await expect(
        embedder?.prepare(
          { kind: "local-pack", path: join(dataDir, "no-pack") },
          AbortSignal.timeout(5000),
        ),
      ).rejects.toThrow();
      expect(await embedder?.status()).toEqual({ unavailable: "model file missing" });
      expect(readdirSync(join(dataDir, "models"))).toEqual([]);
      expect(readdirSync(dataDir)).toEqual(["models"]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("reports a prepared model ready, and an external one as such", async () => {
    const local = new FakeEmbedder();
    await local.prepare({ kind: "local-pack", path: "/synthetic/pack" }, AbortSignal.timeout(1000));
    expect((await embeddingStatus(local)).embedding).toEqual({ state: "ready", egress: "local" });
    expect((await embeddingStatus(new FakeEmbedder({ egress: "external" }))).embedding).toEqual({
      state: "model-missing",
      egress: "external",
    });
  });

  it("reports preparing and an unavailable runtime with its reason", async () => {
    const preparing = Object.assign(new FakeEmbedder(), {
      status: async () => "preparing" as const,
    });
    expect((await embeddingStatus(preparing)).embedding).toEqual({
      state: "preparing",
      egress: "local",
    });
    const broken = new FakeEmbedder({ unavailable: "synthetic runtime failure" });
    expect((await embeddingStatus(broken)).embedding).toEqual({
      state: "unavailable",
      reason: "synthetic runtime failure",
      egress: "local",
    });
  });

  it.each([
    ["status throws", { status: async () => Promise.reject(new Error("CANARY")) }],
    [
      "describe throws",
      {
        describe: () => {
          throw new Error("CANARY");
        },
      },
    ],
    ["an unknown state", { status: async () => "warming-up" as never }],
    ["a state only the API may report", { status: async () => "not-implemented" as never }],
    ["an empty reason", { status: async () => ({ unavailable: "" }) }],
    ["a null status", { status: async () => null as never }],
    [
      "an unknown egress",
      { describe: () => ({ ...new FakeEmbedder().describe(), egress: "cloud" as never }) },
    ],
  ])("degrades only the embedding entry when %s", async (_name, override) => {
    const misbehaving = Object.assign(new FakeEmbedder(), override);
    const status = await embeddingStatus(misbehaving);
    expect(status.embedding).toEqual({ state: "unavailable", reason: "status check failed" });
    expect(status.backend).toEqual({ state: "ready" });
    expect(JSON.stringify(status)).not.toContain("CANARY");
  });
});
