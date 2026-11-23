// V01-R14 / T13 handoff 5: "embedding 준비 시작" API. The user's request is the only
// thing that starts a preparation — from a local pack or by the approved download.
// The API answers at once with the state it started (a download takes minutes),
// refuses a second start while one runs, and never repeats an embedder's error text.
import {
  ErrorResponseSchema,
  routes,
  type EmbeddingProvider,
  type PrepareSource,
} from "@pki/contracts";
import { migrate } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { FakeEmbedder, send, memoryDbTemplate } from "@pki/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { productAdapters, productEgress } from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import { startServer, type RunningServer } from "./server.ts";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);

const TOKEN = "p".repeat(43);
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };
const db = freshDb();
const pack: PrepareSource = { kind: "local-pack", path: "/synthetic/pack" };

let server: RunningServer | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await server?.close();
  server = undefined;
});

async function start(embedder: EmbeddingProvider | null) {
  server = await startServer({
    token: TOKEN,
    allowedOrigins: [],
    connectors,
    db,
    dataDirectory: "/synthetic/data",
    egress: productEgress(db),
    ...productAdapters("/synthetic/data"),
    embedder,
  });
  const port = server.port;
  const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
  return {
    prepare: (body: unknown) =>
      send(port, routes.prepareEmbedding.path, headers, routes.prepareEmbedding.method, body),
    status: async () =>
      routes.status.response.parse((await send(port, routes.status.path, headers)).body).embedding,
  };
}

/** A fake whose preparation waits until released, and that records the signal it got. */
function heldEmbedder() {
  const fake = new FakeEmbedder();
  let release: () => void = () => undefined;
  const signals: AbortSignal[] = [];
  let preparing = false;
  Object.assign(fake, {
    status: async () => (preparing ? "preparing" : "model-missing"),
    prepare: async (source: PrepareSource, signal: AbortSignal) => {
      signals.push(signal);
      fake.calls.prepare.push(source);
      preparing = true;
      await new Promise<void>((resolve) => {
        release = resolve;
        signal.addEventListener("abort", () => resolve());
      });
      preparing = false;
      return signal.aborted ? signal.throwIfAborted() : undefined;
    },
  });
  return { fake, signals, release: () => release() };
}

describe("POST embedding prepare", () => {
  it.each([pack, { kind: "download" } as const])(
    "starts the preparation the user asked for (%o) and answers with its state",
    async (source) => {
      const fake = new FakeEmbedder();
      const api = await start(fake);
      const res = await api.prepare({ source });
      expect(res.status).toBe(200);
      const body = routes.prepareEmbedding.response.parse(res.body);
      expect(["preparing", "ready"]).toContain(body.embedding.state);
      expect(fake.calls.prepare).toEqual([source]);
      await vi.waitFor(async () =>
        expect(await api.status()).toEqual({ state: "ready", egress: "local" }),
      );
    },
  );

  it("does not wait for the preparation to finish", async () => {
    const held = heldEmbedder();
    const api = await start(held.fake);
    const res = await api.prepare({ source: pack });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ embedding: { state: "preparing", egress: "local" } });
    held.release();
  });

  it("refuses a second start while one runs", async () => {
    const held = heldEmbedder();
    const api = await start(held.fake);
    await api.prepare({ source: pack });
    const second = await api.prepare({ source: { kind: "download" } });
    expect(second.status).toBe(409);
    expect(ErrorResponseSchema.parse(second.body)).toEqual({ error: "embedding-busy" });
    expect(held.fake.calls.prepare).toEqual([pack]);
    held.release();
  });

  it("answers busy to the second of two simultaneous starts, without logging a failure", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => void lines.push(line));
    const held = heldEmbedder();
    // Both requests read the state before either starts the preparation.
    const status = held.fake.status.bind(held.fake);
    held.fake.status = async () => {
      const state = await status();
      await new Promise((resolve) => setTimeout(resolve, 50));
      return state;
    };
    const api = await start(held.fake);
    const answers = await Promise.all([
      api.prepare({ source: pack }),
      api.prepare({ source: { kind: "download" } }),
    ]);
    expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
    expect(held.fake.calls.prepare).toHaveLength(1);
    expect(lines.join("\n")).not.toContain("embedding-prepare-failed");
    held.release();
  });

  it("does nothing for a model that is already ready", async () => {
    const fake = new FakeEmbedder();
    await fake.prepare(pack, new AbortController().signal);
    const api = await start(fake);
    const res = await api.prepare({ source: { kind: "download" } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ embedding: { state: "ready", egress: "local" } });
    expect(fake.calls.prepare).toEqual([pack]);
  });

  it("answers not implemented when no embedder is bound", async () => {
    const api = await start(null);
    const res = await api.prepare({ source: pack });
    expect(res.status).toBe(409);
    expect(ErrorResponseSchema.parse(res.body)).toEqual({ error: "embedding-not-implemented" });
  });

  it.each([
    {},
    { source: { kind: "url", url: "https://example.invalid/m" } },
    { source: { kind: "download" }, revision: "main" },
  ])("refuses a body outside the schema (%o) without preparing", async (body) => {
    const fake = new FakeEmbedder();
    const api = await start(fake);
    expect((await api.prepare(body)).status).toBe(400);
    expect(fake.calls.prepare).toEqual([]);
  });

  it("keeps an embedder's failure text out of the response and the log", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => void lines.push(line));
    const failing = Object.assign(new FakeEmbedder(), {
      prepare: async () => Promise.reject(new Error("CANARY failure text")),
    });
    const api = await start(failing);
    const res = await api.prepare({ source: pack });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(lines.join("\n")).toContain("embedding-prepare-failed"));
    expect(JSON.stringify(res.body)).not.toContain("CANARY");
    expect(lines.join("\n")).not.toContain("CANARY");
  });

  it("answers with the state, without the text, when the embedder throws at once", async () => {
    const throwing = Object.assign(new FakeEmbedder(), {
      prepare: () => {
        throw new Error("CANARY");
      },
    });
    const api = await start(throwing);
    const res = await api.prepare({ source: pack });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("CANARY");
    expect((await api.status()).state).toBe("model-missing");
  });

  it("aborts a running preparation when the server closes", async () => {
    const held = heldEmbedder();
    const api = await start(held.fake);
    await api.prepare({ source: pack });
    expect(held.signals[0]?.aborted).toBe(false);
    await server?.close();
    server = undefined;
    expect(held.signals[0]?.aborted).toBe(true);
  });
});
