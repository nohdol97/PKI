// engine.calls, engine.restart and engine.swap (V02-C5, R13) through the product's
// pieces: the import and the screen's deletion notify the KnowledgeEngine and the
// VectorIndex after the canonical write, with the change sequence of each change;
// a clean restart rebuilds nothing, a restart after a change the engine never
// heard of rebuilds it; and swapping only the engine for one that proposes puts
// its quote-checked proposals into the store as candidates, with no change to the
// pipeline code or the API (api.contract.test.ts runs under both engines).
import {
  routes,
  type ChangeSet,
  type Connector,
  type KnowledgeCandidate,
  type KnowledgeEngine,
  type SecretSource,
} from "@pki/contracts";
import { vectorRefOf, type ProjectionNotice } from "@pki/knowledge-engine";
import { openaiKeySecretName, writeDefaultProvider, type EgressControls } from "@pki/providers";
import { findSourceId, readChangeSeq, saveSourceRecord, type SqlDriver } from "@pki/storage";
import {
  completion,
  FakeProvider,
  fixtureExtraction,
  MemoryKnowledgeEngine,
  MemoryVectorIndex,
  ProposingKnowledgeEngine,
  send,
  startFakeOpenAI,
} from "@pki/testkit";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootBackend } from "./boot.ts";
import {
  openCanonicalDb,
  productAdapters,
  productCalls,
  productEgress,
  productEngine,
  productImporter,
  productEntries,
  productProjectionPorts,
  productProjections,
  productRegistry,
  productRunner,
} from "./composition.ts";
import { syncConnector, type ConnectorManager } from "./connectors.ts";
import type { JobRunner } from "./job-runner.ts";
import { JSONL_CONNECTOR_KIND } from "./jsonl-import.ts";
import { startServer, type RunningServer } from "./server.ts";

const FIXTURES = resolve(import.meta.dirname, "../../fixtures");
const read = (name: string) => readFileSync(resolve(FIXTURES, name), "utf8");
const PLAIN = ["v02-mail.jsonl", "v02-wiki.jsonl", "v02-messenger.jsonl"].map(read).join("\n");
const MAIL = { connectorId: "conn-v02-mail", externalId: "<v02-target@mail.example.test>" };
const TOKEN = "e".repeat(43);
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };

let dir: string;
let db: SqlDriver;
let server: RunningServer | undefined;
let runner: JobRunner | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-engine-"));
  db = openCanonicalDb(dir);
});
afterEach(async () => {
  await server?.close();
  await runner?.stop();
  server = undefined;
  runner = undefined;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function spied<T extends object>(target: T): T {
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(target))) {
    if (key !== "constructor") vi.spyOn(target, key as never);
  }
  return target;
}

function consent(egress: EgressControls) {
  const shown = egress.overview().providers.find((p) => p.providerId === "local-model");
  const granted = egress.grant("local-model", ["general"], {
    destination: shown?.destination ?? "",
    policyVersion: egress.policyVersion(),
  });
  if ("error" in granted) throw new Error(granted.error);
}

/** The product's pipeline and API with `engine` and `vectorIndex` bound; nothing else differs. */
async function pipeline(engine: KnowledgeEngine, vectorIndex = new MemoryVectorIndex()) {
  const provider = new FakeProvider({
    id: "local-model",
    transport: "http",
    answer: fixtureExtraction(),
  });
  const egress = productEgress(db);
  writeDefaultProvider(db, provider.id); // the user's default (V01-T10)
  const { broker } = productCalls(db, egress, { providers: [provider] });
  consent(egress);
  const adapters = { ...productAdapters(dir), vectorIndex };
  const projections = productProjections(db, { engine, ...adapters });
  // the registry and the ports as boot.ts builds them: a deletion's removals are jobs the runner executes (I04-T04)
  const registry = productRegistry({ engine, vectorIndex: adapters.vectorIndex });
  const entries = productEntries(registry);
  runner = productRunner(db, broker, {
    engine,
    projections,
    registry,
    projectionPorts: productProjectionPorts(
      db,
      registry,
      { engine, vectorIndex: adapters.vectorIndex },
      projections,
    ),
  });
  const running = runner;
  server = await startServer({
    token: TOKEN,
    allowedOrigins: [],
    connectors,
    db,
    dataDirectory: dir,
    egress,
    ...adapters,
    importer: productImporter(db, { runner, projections, entries }),
    entries,
    onRunConditionsChanged: () => void running.wake(),
  });
  const port = server.port;
  const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
  const post = (path: string, body: unknown) => send(port, path, headers, "POST", body);
  return { provider, runner, projections, post };
}

// by identity: a purged source's row holds the hash (I04-R7)
const sourceIdOf = (externalId: string) =>
  String(findSourceId(db, MAIL.connectorId, "", externalId));
const readJobs = (status: string) =>
  db.all("SELECT id FROM jobs WHERE kind = 'projection-remove' AND status = ?", [status]);
const related = (engine: KnowledgeEngine, text: string) =>
  engine.relatedContext({ text, limit: 10 }).then((hits) => hits.map((h) => h.ref.sourceId));

describe("engine.calls", () => {
  it("notifies each imported version with its change sequence, and a deletion to both projections", async () => {
    const engine = spied(new MemoryKnowledgeEngine());
    const vectorIndex = spied(new MemoryVectorIndex());
    const { post, projections, runner } = await pipeline(engine, vectorIndex);

    expect((await post(routes.importJsonl.path, { text: PLAIN })).body).toMatchObject({
      created: 3,
    });
    await projections.drain();
    const upserts = vi.mocked(engine.upsertSource).mock.calls;
    expect(upserts.map(([input, fence, seq]) => [input.ref.version, fence, seq])).toEqual([
      [1, { version: 1 }, 1],
      [1, { version: 1 }, 2],
      [1, { version: 1 }, 3],
    ]);
    expect(new Set(upserts.map(([input]) => input.ref.sourceId)).size).toBe(3);
    await runner.wake();
    // extraction adds knowledge; the change sequence moves only with sources
    expect(db.all("SELECT state FROM insights")).toEqual([{ state: "active" }]);
    expect(readChangeSeq(db)).toBe(3);

    const mail = sourceIdOf(MAIL.externalId);
    expect(await related(engine, "윤하람 미리내")).toContain(mail);
    expect((await post(routes.deleteSource.path, { ...MAIL, namespace: "" })).body).toEqual({
      outcome: "deleted",
    });
    // the deletion registered the removal jobs and woke the runner (I04-R12)
    await vi.waitFor(() => expect(readJobs("succeeded")).toHaveLength(2));
    expect(vi.mocked(engine.removeSource).mock.calls).toEqual([
      [{ sourceId: mail, version: 1 }, { version: 1 }, 4],
    ]);
    expect(vi.mocked(vectorIndex.remove).mock.calls.at(-1)).toEqual([
      [vectorRefOf(Number(mail), 1)],
      4,
    ]);
    // the test asks the engine: the deleted source is not found, the others are
    expect(await related(engine, "윤하람")).toEqual([]);
    expect(await related(engine, "윤하람 미리내 물결")).not.toContain(mail);
    expect(await engine.appliedChangeSeq()).toBe(4);
    expect(await vectorIndex.appliedChangeSeq()).toBe(4);
  });

  it("notifies a deletion by a Connector change too (access revoked)", async () => {
    const engine = spied(new MemoryKnowledgeEngine());
    const { post, projections, runner } = await pipeline(engine);
    await post(routes.importJsonl.path, { text: read("v02-mail.jsonl") });
    await runner.wake(); // idle: only the sync's own wake can run the removal jobs
    const page: ChangeSet = {
      changes: [
        {
          kind: "access-revoked",
          namespace: "",
          externalId: MAIL.externalId,
          revision: 2,
          at: "2026-11-21T00:00:00Z",
        },
      ],
      nextCursor: "1",
      hasMore: false,
    };
    const revoking: Connector = {
      manifest: {
        type: JSONL_CONNECTOR_KIND,
        schemaVersion: 2,
        capabilities: {
          incremental: true,
          deletes: true,
          accessScope: false,
          fullRescan: true,
          deletionsOnRescan: false,
        },
      },
      initialize: async () => {},
      healthCheck: async () => ({ state: "ok" }),
      getChanges: async () => page,
      getDocument: async () => null,
    };
    await syncConnector(db, MAIL.connectorId, JSONL_CONNECTOR_KIND, revoking, {
      rescan: true,
      projections,
      runner,
    });
    await vi.waitFor(() => expect(readJobs("succeeded")).toHaveLength(2));
    expect(vi.mocked(engine.removeSource).mock.calls).toEqual([
      [{ sourceId: sourceIdOf(MAIL.externalId), version: 1 }, { version: 1 }, 2],
    ]);
    expect(await related(engine, "윤하람")).toEqual([]);
  });
});

describe("engine.restart", () => {
  const MAIL_TARGET = "미리내 프로젝트의 완료 목표는 2026-12-05입니다";
  /** An endpoint answering every extraction with mail's target date. */
  const extraction = () =>
    completion(
      JSON.stringify({
        items: [{ ref: "a", type: "Project", name: "미리내 프로젝트", existingItemId: null }],
        facts: [
          {
            item: "a",
            kind: "target_date",
            value: "2026-12-05",
            epistemic: "explicit",
            quote: MAIL_TARGET,
          },
        ],
        relations: [],
      }),
    );

  it("① rebuilds nothing after a clean stop, extraction included; ② rebuilds after a change it was never told of", async () => {
    db.close(); // the backend opens the directory itself
    const endpoint = await startFakeOpenAI(extraction);
    const key = openaiKeySecretName(endpoint.host);
    const secrets: SecretSource = {
      read: async (n) =>
        n === key ? { state: "present", value: "sk-engine" } : { state: "missing" },
      has: async (n) => (n === key ? "present" : "missing"),
      deleteOthers: async () => "done",
    };
    // the memory engine keeps no state in files: the same instance across the restart
    const engine = spied(new MemoryKnowledgeEngine());
    const boot = () =>
      bootBackend({ dataDir: dir, token: TOKEN, allowedOrigins: [], secrets, engine });
    try {
      let booted = await boot();
      expect(engine.rebuild).toHaveBeenCalledTimes(1); // first start: applied null, store at 0
      const { port } = booted.server;
      const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
      const post = (path: string, body: unknown) => send(port, path, headers, "POST", body);
      await post(routes.writeSettings.path, {
        openaiCompatible: { baseUrl: endpoint.baseUrl, model: "synthetic-model" },
      });
      await post(routes.setDefaultProvider.path, { providerId: "openai-compatible" });
      const consents = await send(port, routes.consents.path, headers);
      await post(routes.grantConsent.path, {
        providerId: "openai-compatible",
        allowedClasses: ["general"],
        destination: endpoint.host,
        policyVersion: (consents.body as { policyVersion: string }).policyVersion,
      });
      await post(routes.importJsonl.path, { text: read("v02-mail.jsonl") });
      await booted.runner.wake(); // no drain: the close below delivers what is queued
      expect(booted.db.all("SELECT status FROM jobs")).toEqual([{ status: "succeeded" }]);
      expect(booted.db.all("SELECT value FROM facts")).toEqual([{ value: "2026-12-05" }]);
      await booted.server.close();
      booted.db.close();

      // ① a clean restart
      vi.mocked(engine.rebuild).mockClear();
      booted = await boot();
      expect(engine.rebuild).not.toHaveBeenCalled();
      await booted.server.close();
      booted.db.close();

      // ② the process stopped after a commit and before its notice: stored, never told
      const stopped = openCanonicalDb(dir);
      saveSourceRecord(stopped, MAIL.connectorId, {
        externalId: "never-told",
        title: "알리지 않은 원본",
        body: "합성 자료. 여울 메모.",
      });
      const seq = readChangeSeq(stopped);
      stopped.close();
      expect(await related(engine, "여울")).toEqual([]);
      booted = await boot();
      expect(engine.rebuild).toHaveBeenCalledTimes(1);
      expect(vi.mocked(engine.rebuild).mock.calls[0]?.[1]).toBe(seq);
      expect(await engine.appliedChangeSeq()).toBe(seq);
      expect(await related(engine, "여울")).toHaveLength(1);
      await booted.server.close();
      db = booted.db; // closed by afterEach
    } finally {
      await endpoint.close();
    }
  });
});

describe("engine.swap", () => {
  const PLAN = "새벽 프로젝트의 완료 목표는 2026-12-20입니다";
  /** A line on the mail fixture's shape, not a fixture: the Provider double answers nothing for it. */
  const noteLine = () => {
    const mail = JSON.parse(read("v02-mail.jsonl").trim()) as Record<string, unknown>;
    const content = `합성 자료입니다. ${PLAN}.`;
    const hash = createHash("sha256").update(content, "utf8").digest("hex");
    return JSON.stringify({
      ...mail,
      id: "note-0001",
      connector_instance_id: "conn-notes",
      external_id: "note/1",
      title: "새벽 메모",
      content,
      content_hash: `sha256:${hash}`,
    });
  };
  const item = { type: "Project", name: "새벽 프로젝트", existingItemId: null };
  /** Proposes, for the note only, its target date and one quote the note does not hold. */
  const proposing = () =>
    new ProposingKnowledgeEngine(({ ref, body }): KnowledgeCandidate[] =>
      body.includes(PLAN)
        ? [
            {
              kind: "fact",
              ref,
              item,
              factKind: "target_date",
              value: "2026-12-20",
              epistemic: "explicit",
              quote: PLAN,
            },
            {
              kind: "fact",
              ref,
              item,
              factKind: "target_date",
              value: "2026-12-21",
              epistemic: "explicit",
              quote: "새벽 프로젝트의 완료 목표는 2026-12-21입니다",
            },
          ]
        : [],
    );
  async function run(engine: KnowledgeEngine) {
    const { post, projections, runner, provider } = await pipeline(engine);
    const imported = await post(routes.importJsonl.path, { text: `${PLAIN}\n${noteLine()}` });
    expect(imported.body).toMatchObject({ created: 4, errorCount: 0 });
    await projections.drain();
    await runner.wake();
    expect(provider.requests).toHaveLength(4);
    return {
      notes: db.all(
        `SELECT f.kind, f.value, f.status, e.quote FROM facts f
           JOIN evidence e ON e.fact_id = f.id
           JOIN source_versions v ON v.id = e.source_version_id
           JOIN sources s ON s.id = v.source_id
          WHERE s.external_id = 'note/1'`,
      ),
      drops: db.all(
        `SELECT j.dropped_quotes AS q, j.dropped_other AS o FROM jobs j
           JOIN sources s ON s.id = j.source_id WHERE s.external_id = 'note/1'`,
      ),
      insights: db.all("SELECT state FROM insights"),
    };
  }

  it("records the proposing engine's quote-checked proposal as a candidate and drops the wrong quote", async () => {
    expect(await run(proposing())).toEqual({
      notes: [{ kind: "target_date", value: "2026-12-20", status: "candidate", quote: PLAN }],
      drops: [{ q: 1, o: 0 }],
      insights: [{ state: "active" }],
    });
  });

  it("has no such candidate with the product's null engine; the rest is the same", async () => {
    expect(await run(productEngine())).toEqual({
      notes: [],
      drops: [{ q: 0, o: 0 }],
      insights: [{ state: "active" }],
    });
  });
});

/** Lets the event loop run `n` times (I/O included); no wall-clock wait. */
async function turns(n = 200) {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
}

/** A promise the test releases, and an engine call held on it. */
function gate() {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  return { held, release };
}

/** A Connector whose one page holds `changes`. */
function onePage(changes: ChangeSet["changes"]): Connector {
  return {
    manifest: {
      type: JSONL_CONNECTOR_KIND,
      schemaVersion: 2,
      capabilities: {
        incremental: true,
        deletes: true,
        accessScope: false,
        fullRescan: true,
        deletionsOnRescan: false,
      },
    },
    initialize: async () => {},
    healthCheck: async () => ({ state: "ok" }),
    getChanges: async () => ({ changes, nextCursor: "1", hasMore: false }),
    getDocument: async () => null,
  };
}
const upsert = (externalId: string, body: string, revision = 1) => ({
  kind: "upsert" as const,
  record: {
    namespace: "",
    externalId,
    revision,
    schemaVersion: 2 as const,
    title: externalId,
    body,
  },
});

describe("one page with several versions (review F2)", () => {
  it("gives each notice its own change sequence, so a stop after the first delivery is found at start", async () => {
    const notified: ProjectionNotice[] = [];
    await syncConnector(
      db,
      "conn-page",
      JSONL_CONNECTOR_KIND,
      onePage([upsert("p1", "page alpha"), upsert("p2", "page beta"), upsert("p3", "page gamma")]),
      { rescan: true, projections: { notify: async (n) => void notified.push(...n) } },
    );
    expect(notified.map((n) => n.changeSeq)).toEqual([1, 2, 3]);

    // the process stops after the engine took the first notice only
    const engine = new MemoryKnowledgeEngine();
    const adapters = { vectorIndex: new MemoryVectorIndex(), embedder: null };
    const before = productProjections(db, { engine, ...adapters });
    await before.notify(notified.slice(0, 1));
    expect(await engine.appliedChangeSeq()).toBe(1);
    const restarted = productProjections(db, { engine, ...adapters });
    expect(await restarted.reconcile()).toMatchObject({ engine: "rebuilt" });
    expect(await related(engine, "beta gamma")).toHaveLength(2);
  });
});

describe("a failed page (review F4)", () => {
  it("notifies nothing of it", async () => {
    const engine = spied(new MemoryKnowledgeEngine());
    const vectorIndex = spied(new MemoryVectorIndex());
    const projections = productProjections(db, { engine, vectorIndex, embedder: null });
    const sync = (changes: ChangeSet["changes"]) =>
      syncConnector(db, "conn-fail", JSONL_CONNECTOR_KIND, onePage(changes), {
        rescan: true,
        projections,
      });
    await sync([upsert("r", "first text", 5)]);
    await projections.drain();
    expect(await engine.appliedChangeSeq()).toBe(1);
    // a new source stored, then a second one the store cannot take: the page fails whole
    db.exec(`CREATE TRIGGER refuse_t BEFORE INSERT ON sources WHEN new.external_id = 't'
             BEGIN SELECT RAISE(ABORT, 'refused'); END`);
    expect(
      await sync([upsert("s", "rolled back", 1), upsert("t", "never stored", 1)]),
    ).toMatchObject({
      stopped: "storage-failed",
      created: 0,
    });
    await projections.drain();
    expect(engine.upsertSource).toHaveBeenCalledTimes(1);
    expect(vectorIndex.remove).toHaveBeenCalledTimes(1);
    expect(await engine.appliedChangeSeq()).toBe(1);
    expect(readChangeSeq(db)).toBe(1);
  });

  it("registers no projection removal for a deletion on a page that fails whole (I04-R12, atomic with the page)", async () => {
    const sync = (changes: ChangeSet["changes"]) =>
      syncConnector(db, "conn-fail-del", JSONL_CONNECTOR_KIND, onePage(changes), {
        rescan: true,
      });
    await sync([upsert("d", "stored text", 5)]);
    db.exec(`CREATE TRIGGER refuse_u BEFORE INSERT ON sources WHEN new.external_id = 'u'
             BEGIN SELECT RAISE(ABORT, 'refused'); END`);
    const result = await sync([
      { kind: "delete", namespace: "", externalId: "d", revision: 6, at: "2026-11-21T00:00:00Z" },
      upsert("u", "never stored", 1),
    ]);
    expect(result).toMatchObject({ stopped: "storage-failed", tombstoned: 0 });
    expect(db.all("SELECT 1 FROM jobs WHERE kind = 'projection-remove'")).toEqual([]);
    expect(db.all("SELECT 1 FROM tombstones")).toEqual([]);
    expect(db.all("SELECT 1 FROM source_versions")).toHaveLength(1);
  });
});

describe("boot and close order (review F3, F6)", () => {
  const boot = (engine: KnowledgeEngine) =>
    bootBackend({
      dataDir: dir,
      token: TOKEN,
      allowedOrigins: [],
      secrets: {
        read: async () => ({ state: "missing" }),
        has: async () => "missing",
        deleteOthers: async () => "done",
      },
      engine,
    });

  it("serves nothing until the start-up comparison is done", async () => {
    db.close(); // the backend opens the directory itself
    const engine = new MemoryKnowledgeEngine();
    const rebuild = engine.rebuild.bind(engine);
    const { held, release } = gate();
    let entered!: () => void;
    const rebuilding = new Promise<void>((r) => (entered = r));
    vi.spyOn(engine, "rebuild").mockImplementation(async (sources, seq) => {
      entered();
      await held;
      await rebuild(sources, seq);
    });
    let ready = false;
    const booting = boot(engine).then((b) => ((ready = true), b));
    await rebuilding;
    await turns();
    expect(ready).toBe(false);
    release();
    const booted = await booting;
    expect(await engine.appliedChangeSeq()).toBe(0);
    await booted.server.close();
    db = booted.db; // closed by afterEach
  });

  it("closes only after the queued notices are delivered", async () => {
    db.close();
    const engine = new MemoryKnowledgeEngine();
    const upsertSource = engine.upsertSource.bind(engine);
    const { held, release } = gate();
    vi.spyOn(engine, "upsertSource").mockImplementation(async (...args) => {
      await held;
      await upsertSource(...args);
    });
    const booted = await boot(engine);
    db = booted.db; // closed by afterEach
    const { port } = booted.server;
    const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
    await send(port, routes.importJsonl.path, headers, "POST", { text: read("v02-mail.jsonl") });
    let closed = false;
    const closing = booted.server.close().then(() => (closed = true));
    await turns();
    expect(closed).toBe(false);
    release();
    await closing;
    expect(await engine.appliedChangeSeq()).toBe(1);
  });
});

describe("the runner is woken after delivery (review F6)", () => {
  it("so a proposing engine has the version when the import's own wake extracts it", async () => {
    const PLAN = "여명 프로젝트의 완료 목표는 2026-12-24입니다";
    const engine = new ProposingKnowledgeEngine(({ ref, body }): KnowledgeCandidate[] =>
      body.includes(PLAN)
        ? [
            {
              kind: "fact",
              ref,
              item: { type: "Project", name: "여명 프로젝트", existingItemId: null },
              factKind: "target_date",
              value: "2026-12-24",
              epistemic: "explicit",
              quote: PLAN,
            },
          ]
        : [],
    );
    const upsertSource = engine.upsertSource.bind(engine);
    const { held, release } = gate();
    vi.spyOn(engine, "upsertSource").mockImplementation(async (...args) => {
      await held;
      await upsertSource(...args);
    });
    const { post, projections, runner } = await pipeline(engine);
    const mail = JSON.parse(read("v02-mail.jsonl").trim()) as Record<string, unknown>;
    const content = `합성 자료입니다. ${PLAN}.`;
    const line = JSON.stringify({
      ...mail,
      id: "dawn-0001",
      connector_instance_id: "conn-dawn",
      external_id: "dawn/1",
      title: "여명 메모",
      content,
      content_hash: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
    });
    expect((await post(routes.importJsonl.path, { text: line })).body).toMatchObject({
      created: 1,
    });
    await turns(); // a wake before the delivery would extract now, with no proposal
    release();
    await projections.drain();
    await runner.wake();
    expect(db.all("SELECT value, status FROM facts")).toEqual([
      { value: "2026-12-24", status: "candidate" },
    ]);
  });
});

describe("a stale engine through the product's wiring (review R2-1)", () => {
  it("is not asked for proposals by the booted runner after a failed notice", async () => {
    db.close(); // the backend opens the directory itself
    const endpoint = await startFakeOpenAI(() =>
      completion(JSON.stringify({ items: [], facts: [], relations: [] })),
    );
    const key = openaiKeySecretName(endpoint.host);
    const secrets: SecretSource = {
      read: async (n) =>
        n === key ? { state: "present", value: "sk-engine" } : { state: "missing" },
      has: async (n) => (n === key ? "present" : "missing"),
      deleteOthers: async () => "done",
    };
    const engine = new ProposingKnowledgeEngine(({ ref, body }) => [
      {
        kind: "fact",
        ref,
        item: { type: "Project", name: "미리내 프로젝트", existingItemId: null },
        factKind: "target_date",
        value: "2026-12-05",
        epistemic: "explicit",
        quote: body,
      },
    ]);
    vi.spyOn(engine, "upsertSource").mockRejectedValue(new Error("engine broke"));
    const propose = vi.spyOn(engine, "proposeKnowledge");
    try {
      const booted = await bootBackend({
        dataDir: dir,
        token: TOKEN,
        allowedOrigins: [],
        secrets,
        engine,
      });
      db = booted.db; // closed by afterEach
      server = booted.server;
      const { port } = booted.server;
      const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
      const post = (path: string, body: unknown) => send(port, path, headers, "POST", body);
      await post(routes.setDefaultProvider.path, { providerId: "openai-compatible" });
      await post(routes.writeSettings.path, {
        openaiCompatible: { baseUrl: endpoint.baseUrl, model: "synthetic-model" },
      });
      const consents = await send(port, routes.consents.path, headers);
      await post(routes.grantConsent.path, {
        providerId: "openai-compatible",
        allowedClasses: ["general"],
        destination: endpoint.host,
        policyVersion: (consents.body as { policyVersion: string }).policyVersion,
      });
      await post(routes.importJsonl.path, { text: read("v02-mail.jsonl") });
      await booted.projections.drain(); // the upsert failed: the engine is stale now
      await booted.runner.wake();
      expect(db.all("SELECT status FROM jobs")).toEqual([{ status: "succeeded" }]);
      expect(endpoint.completions()).toBe(1); // extraction ran
      expect(propose).not.toHaveBeenCalled();
      expect(db.all("SELECT count(*) AS n FROM facts")).toEqual([{ n: 0 }]);
    } finally {
      await endpoint.close();
    }
  });
});
