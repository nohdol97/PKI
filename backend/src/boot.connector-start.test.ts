// I05-T02 on the real bootBackend: a start with a Connector that never initializes ends at the
// time limit (I05-C8), and what the stored data says about instances the present set does not
// match (I05-R12, C10 ① ②: `boot.stored-mismatch`, held by tests, not changed by I05).
import { routes, type Connector } from "@pki/contracts";
import { readJob, registerConnectorInstance, registerJob, saveSourceRecord } from "@pki/storage";
import { send } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootBackend } from "./boot.ts";
import { openCanonicalDb, type ConnectorSet } from "./composition.ts";
import { INITIALIZE_TIMEOUT_MS } from "./connectors.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";

const TOKEN = "t".repeat(43);
let dir: string;
let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-boot-start-"));
});
afterEach(async () => {
  vi.useRealTimers();
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const connector = (initialize: () => Promise<void>, upserts = 1): Connector => ({
  manifest: {
    type: "k",
    schemaVersion: 2,
    capabilities: {
      incremental: true,
      deletes: true,
      accessScope: false,
      fullRescan: true,
      deletionsOnRescan: false,
    },
  },
  initialize,
  healthCheck: async () => ({ state: "ok" }),
  getChanges: async () => ({
    changes: Array.from({ length: upserts }, (_, i) => ({
      kind: "upsert" as const,
      record: {
        namespace: "",
        externalId: `r${i}`,
        revision: 1,
        schemaVersion: 2 as const,
        title: "t",
        body: "synthetic body",
      },
    })),
    nextCursor: "1",
    hasMore: false,
  }),
  getDocument: async () => null,
});

const boot = (connectors: ConnectorSet) =>
  bootBackend({
    dataDir: dir,
    token: TOKEN,
    allowedOrigins: [],
    secrets: NO_SECRET_STORE,
    connectors,
  });
const api = () => {
  const port = booted?.server.port as number;
  const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
  return {
    get: (path: string) => send(port, path, headers),
    sync: (connectorId: string) =>
      send(port, routes.syncConnector.path, headers, "POST", { connectorId }),
  };
};
const ok = async () => {};

describe("connectors.boot-bounded on the real start (I05-C8)", () => {
  it("the start ends at the limit with the slow instance unavailable and the other one syncing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const finishes: Array<() => void> = [];
    let asked = false;
    const pending = boot({
      instances: [
        { id: "slow", kind: "slow", config: {} },
        { id: "fine", kind: "fine", config: {} },
      ],
      kinds: {
        slow: () => {
          asked = true;
          return connector(() => new Promise<void>((r) => finishes.push(r)));
        },
        fine: () => connector(ok),
      },
    });
    let started = false;
    void pending.then(() => (started = true));
    // the start does its own work before the instances: wait (on real ticks) until it asks for them
    while (!asked) await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(INITIALIZE_TIMEOUT_MS - 1);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    booted = await pending;
    vi.useRealTimers();
    expect((await api().get(routes.connectors.path)).body).toMatchObject({
      connectors: expect.arrayContaining([
        { id: "slow", kind: "slow", state: "unavailable" },
        { id: "fine", kind: "fine", state: "ready" },
      ]),
    });
    expect((await api().sync("slow")).body).toMatchObject({ error: "connector-unavailable" });
    finishes[0]?.(); // the start's object ends late (the start's own recheck made another): nothing changes
    await new Promise((r) => setTimeout(r, 20));
    expect((await api().sync("slow")).body).toMatchObject({ error: "connector-unavailable" });
    expect((await api().sync("fine")).body).toMatchObject({ connectorId: "fine", created: 1 });
  });
});

describe("boot.stored-mismatch (I05-R12, C10 ① ②)", () => {
  it("① a stored instance, period and job that the present set lacks close as instance-not-found, and another instance still syncs", async () => {
    const db = openCanonicalDb(dir);
    registerConnectorInstance(db, "gone", "vanished-kind");
    const queued = registerJob(db, { kind: "connector-sync", target: "gone" });
    if (!queued.registered) throw new Error("expected a new job");
    db.close();
    booted = await boot({
      instances: [{ id: "fine", kind: "fine", config: {} }],
      kinds: { fine: () => connector(ok) },
    });
    const { db: stored } = booted;
    await vi.waitFor(() =>
      expect(readJob(stored, queued.job.id)).toMatchObject({
        status: "dead_letter",
        reason: "instance-not-found",
      }),
    );
    expect((await api().sync("fine")).body).toMatchObject({ connectorId: "fine", created: 1 });
  });

  it("② an instance id the stored data binds to another kind: only its sync fails, the other syncs, the stored source is unchanged", async () => {
    const db = openCanonicalDb(dir);
    registerConnectorInstance(db, "bound", "jsonl-import");
    saveSourceRecord(db, "bound", { externalId: "kept", title: "kept", body: "kept body" });
    db.close();
    booted = await boot({
      instances: [
        { id: "bound", kind: "fine", config: {} },
        { id: "other", kind: "fine", config: {} },
      ],
      kinds: { fine: () => connector(ok) },
    });
    const first = await api().sync("bound");
    expect(first.status).not.toBe(200);
    expect((await api().sync("other")).body).toMatchObject({ connectorId: "other", created: 1 });
    const sources = (await api().get("/api/sources")).body as {
      sources: Array<{ externalId: string; title: string }>;
    };
    expect(sources.sources.filter((s) => s.externalId === "kept")).toMatchObject([
      { title: "kept" },
    ]);
    expect(sources.sources.filter((s) => s.externalId === "r0")).toHaveLength(1); // only other's
  });
});
