// H01C3-C5: the real `bootBackend` with the `vectorIndexing` option. A start that finds the index behind asks
// for a `projection-rebuild` job and embeds nothing itself; once the job has run the status API says ready;
// a deleted source's ref is gone from the index file. Without the option the product keeps the empty index
// and removes a `vectors/` folder left behind.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routes, type EmbeddingKind, type VectorIndex } from "@pki/contracts";
import { vectorRefOf } from "@pki/knowledge-engine";
import {
  findSourceId,
  registerConnectorInstance,
  saveSourceRecord,
  type SqlDriver,
} from "@pki/storage";
import { EmptyVectorIndex, openBetterSqlite3, SqliteVectorIndex } from "@pki/storage/adapters";
import { FakeEmbedder, send } from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootBackend } from "./boot.ts";
import { CANONICAL_DB_FILE, productEngine, productRegistry } from "./composition.ts";
import { checkDataDirectory } from "./derivative-coverage.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";

const TOKEN = "v".repeat(43);
let dir: string;
let running: Awaited<ReturnType<typeof bootBackend>> | undefined;
let probe: SqlDriver | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-vector-boot-"));
});
afterEach(async () => {
  await stop();
  rmSync(dir, { recursive: true, force: true });
});

/** Embeds like the fake, and notes whether a `projection-rebuild` job was running at each call. */
class WatchedEmbedder extends FakeEmbedder {
  inJob: boolean[] = [];
  override async embed(texts: readonly string[], kind: EmbeddingKind, signal?: AbortSignal) {
    this.inJob.push(
      probe !== undefined &&
        probe.all(
          "SELECT 1 FROM jobs WHERE kind = 'projection-rebuild' AND target = 'vectorIndex' AND status = 'running'",
        ).length > 0,
    );
    return super.embed(texts, kind, signal);
  }
}

async function boot(options: { vectorIndexing?: boolean; embedder: FakeEmbedder }) {
  running = await bootBackend({
    dataDir: dir,
    token: TOKEN,
    allowedOrigins: [],
    secrets: NO_SECRET_STORE,
    providers: [],
    embedder: options.embedder,
    ...(options.vectorIndexing ? { vectorIndexing: true } : {}),
  });
  const headers = { host: `127.0.0.1:${running.server.port}`, authorization: `Bearer ${TOKEN}` };
  const port = running.server.port;
  return {
    db: running.db,
    status: async () =>
      routes.status.response.parse((await send(port, routes.status.path, headers)).body),
    post: (path: string, body: unknown) => send(port, path, headers, "POST", body),
  };
}

async function stop() {
  probe?.close();
  probe = undefined;
  await running?.server.close();
  running?.db.close();
  running = undefined;
}

async function ready() {
  const embedder = new WatchedEmbedder();
  await embedder.prepare({ kind: "download" }, new AbortController().signal);
  return embedder;
}

const indexRefs = () => {
  const index = openBetterSqlite3(join(dir, "vectors", "index.sqlite"));
  try {
    return index.all("SELECT ref FROM vectors").map((row) => row.ref as string);
  } finally {
    index.close();
  }
};

describe("vectorIndexing on", () => {
  it("rebuilds in a job after a start that found it behind, serves, and loses a deleted source's ref", async () => {
    const embedder = await ready();
    const first = await boot({ vectorIndexing: true, embedder });
    await expect.poll(async () => (await first.status()).vectorIndex).toEqual({ state: "ready" });
    registerConnectorInstance(first.db, "c1", "test-fixtures");
    saveSourceRecord(first.db, "c1", { externalId: "x1", title: "첫째", body: "alpha" });
    saveSourceRecord(first.db, "c1", { externalId: "x2", title: "둘째", body: "beta" });
    await stop();

    embedder.inJob = [];
    const second = await boot({ vectorIndexing: true, embedder });
    probe = openBetterSqlite3(join(dir, CANONICAL_DB_FILE));
    await expect.poll(() => indexRefs().length, { timeout: 10_000 }).toBe(2);
    await expect.poll(async () => (await second.status()).vectorIndex).toEqual({ state: "ready" });
    expect(embedder.inJob.length).toBeGreaterThan(0);
    expect(embedder.inJob.every(Boolean)).toBe(true); // every embed call ran inside the rebuild job, none at the start

    const sourceId = findSourceId(second.db, "c1", "", "x1") as number;
    expect(indexRefs()).toContain(vectorRefOf(sourceId, 1));
    const deleted = await second.post(routes.deleteSource.path, {
      connectorId: "c1",
      namespace: "",
      externalId: "x1",
    });
    expect(deleted.body).toEqual({ outcome: "deleted" });
    await expect
      .poll(() =>
        probe?.all(
          "SELECT status FROM jobs WHERE kind = 'projection-remove' AND target = 'vectorIndex'",
        ),
      )
      .toEqual([{ status: "succeeded" }]);
    expect(indexRefs()).not.toContain(vectorRefOf(sourceId, 1));
    expect(indexRefs()).toHaveLength(1);
  });

  it("never calls an embedder that is not local, and builds nothing", async () => {
    const embedder = new FakeEmbedder({ egress: "external" });
    await embedder.prepare({ kind: "download" }, new AbortController().signal);
    const first = await boot({ vectorIndexing: true, embedder });
    registerConnectorInstance(first.db, "c1", "test-fixtures");
    saveSourceRecord(first.db, "c1", { externalId: "x1", title: "첫째", body: "alpha" });
    await stop();

    const second = await boot({ vectorIndexing: true, embedder });
    probe = openBetterSqlite3(join(dir, CANONICAL_DB_FILE));
    await expect
      .poll(
        () =>
          probe?.all(
            "SELECT attempts FROM jobs WHERE kind = 'projection-rebuild' AND target = 'vectorIndex'",
          )[0]?.attempts,
      )
      .toBeGreaterThanOrEqual(1);
    expect(embedder.calls.embed).toEqual([]);
    expect(indexRefs()).toEqual([]);
    expect((await second.status()).vectorIndex.state).not.toBe("ready");
  });
});

describe("the data directory check", () => {
  it("knows the vectors folder as the vector index's path only when the real index is bound", async () => {
    const embedder = await ready();
    await boot({ vectorIndexing: true, embedder });
    await stop();
    const index = new SqliteVectorIndex(join(dir, "vectors", "index.sqlite"), openBetterSqlite3);
    const unclaimed = (vectorIndex: VectorIndex) =>
      checkDataDirectory(dir, productRegistry({ engine: productEngine(), vectorIndex })).filter(
        (problem) => problem.includes('"vectors'),
      );
    expect(unclaimed(index)).toEqual([]);
    expect(unclaimed(new EmptyVectorIndex())).toHaveLength(1);
    index.close();
  });
});

describe("vectorIndexing off (the default)", () => {
  it("keeps the empty index, removes a left-over vectors folder and registers no rebuild job", async () => {
    mkdirSync(join(dir, "vectors"));
    writeFileSync(join(dir, "vectors", "index.sqlite"), "left over");
    const embedder = await ready();
    const started = await boot({ embedder });
    expect(existsSync(join(dir, "vectors"))).toBe(false);
    expect((await started.status()).vectorIndex).toEqual({
      state: "unavailable",
      reason: expect.stringMatching(/\S/),
    });
    expect(
      started.db.all(
        "SELECT 1 FROM jobs WHERE kind = 'projection-rebuild' AND target = 'vectorIndex'",
      ),
    ).toEqual([]);
    expect(embedder.calls.embed).toEqual([]);
  });
});
