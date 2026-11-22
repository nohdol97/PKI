// V01-C1 `api.contract`: every API response, success or rejection, matches the
// schema in @pki/contracts that the UI also uses. V02-C5 engine.swap: the same
// suite under the product's null engine and under an engine that proposes, whose
// proposal for the imported mail is extracted into the store (and none is under
// the null engine).
import {
  ErrorResponseSchema,
  routes,
  SyncResponseSchema,
  type KnowledgeCandidate,
  type KnowledgeEngine,
  type RouteName,
} from "@pki/contracts";
import { OPENAI_BASE_URL_SETTING, writeDefaultProvider } from "@pki/providers";
import { migrate, userDecisions } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeProvider, ProposingKnowledgeEngine, send } from "@pki/testkit";
import {
  fixtureConnectorKinds,
  fixtureConnectors,
  productAdapters,
  productCalls,
  productEgress,
  productEngine,
  productImporter,
  productInstanceImporter,
  productProjections,
  productRunner,
} from "./composition.ts";
import { createConnectorManager } from "./connectors.ts";
import { createJobActions } from "./job-actions.ts";
import type { JobRunner } from "./job-runner.ts";
import { createScheduler } from "./scheduler.ts";
import { seedV02 } from "./v02-seed.e2e.ts";
import { startServer, type RunningServer } from "./server.ts";

const TOKEN = "c".repeat(43);
const FIXTURES = resolve(import.meta.dirname, "../../fixtures/test-connector.jsonl");
const TARGET = "제안 프로젝트의 완료 목표는 2026-12-20입니다";
/** A line on the mail fixture's shape that no seed holds: its import stores a version. */
function noteLine(): string {
  const mail = JSON.parse(
    readFileSync(resolve(FIXTURES, "../v02-mail.jsonl"), "utf8").trim(),
  ) as Record<string, unknown>;
  const content = `합성 자료입니다. ${TARGET}.`;
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  return JSON.stringify({
    ...mail,
    id: "note-0001",
    connector_instance_id: "conn-notes",
    external_id: "note/1",
    title: "제안 메모",
    content,
    content_hash: `sha256:${hash}`,
  });
}
const engines: [string, () => KnowledgeEngine, number][] = [
  ["the product's null engine", productEngine, 0],
  [
    "an engine that proposes",
    () =>
      new ProposingKnowledgeEngine(({ ref, body }): KnowledgeCandidate[] =>
        body.includes(TARGET)
          ? [
              {
                kind: "fact",
                ref,
                item: { type: "Project", name: "제안 프로젝트", existingItemId: null },
                factKind: "target_date",
                value: "2026-12-20",
                epistemic: "explicit",
                quote: TARGET,
              },
            ]
          : [],
      ),
    1,
  ],
];

describe.each(engines)("with %s", (_name, engine, proposed) => {
  const db = openBetterSqlite3(":memory:");
  let server: RunningServer;
  let valid: Record<string, string>;
  let projections: ReturnType<typeof productProjections>;
  let runner: JobRunner;

  // A body for every route that takes one; the schema test below fails for a route missing here.
  const requests: Partial<Record<RouteName, unknown>> = {
    syncConnector: { connectorId: "fixtures" },
    // I06-R12: the change notice of a credential; the fixture instance declares no slot, so it is rebuilt as it is
    credentialsChanged: { connectorId: "fixtures" },
    importJsonl: { text: readFileSync(resolve(FIXTURES, "../v02-mail.jsonl"), "utf8") },
    imports: {
      instanceId: "contract-import",
      content: readFileSync(resolve(FIXTURES, "../v02-wiki.jsonl"), "utf8"),
    },
    searchSources: { query: "등대" },
    // a record syncConnector stored above, not one the evidence seed below relies on
    deleteSource: { connectorId: "fixtures", namespace: "", externalId: "fx-001" },
    // routes run in contract order: pruneVersions comes before deleteSource, so fx-001 is still there
    pruneVersions: { connectorId: "fixtures", namespace: "", externalId: "fx-001" },
    // an id answers 200 whether or not a tombstone holds it (lifted or unchanged)
    liftTombstone: { id: 1 },
    grantConsent: {
      providerId: "codex",
      allowedClasses: ["synthetic"],
      destination: "vendor:codex",
      policyVersion: productEgress(db).policyVersion(),
    },
    revokeConsent: { providerId: "codex" },
    // the destination-unavailable grant case below clears the endpoint again first
    writeSettings: {
      openaiCompatible: { baseUrl: "http://127.0.0.1:9/v1", model: "synthetic-model" },
    },
    connectionTest: { acknowledgeUnverified: false },
    setExecutionSettings: { cliBackground: false },
    setAnalyticalSettings: { profile: false, maxCells: 200_000 },
    setDefaultProvider: { providerId: "claude-code" },
    // The pack does not exist: the preparation starts, then fails without touching disk.
    prepareEmbedding: { source: { kind: "local-pack", path: "/synthetic/missing-pack" } },
    // the seed below makes Insight 1 with evidence 1..3
    insightEvidence: { insightId: 1 },
    evidenceSource: { evidenceId: 1 },
    // the job area (I03-R23): bodies for rows that need not exist (an action answers 200 with `not-found`)
    cancelJob: { id: 999_999 },
    retryJob: { id: 999_999 },
    discardJob: { id: 999_999 },
    changeSchedule: { id: 999_999, period: { kind: "hourly" } },
    disableSchedule: { id: 999_999 },
    enableSchedule: { id: 999_999 },
    runSchedule: { id: 999_999 },
    rebuildProjection: { projection: "engine" },
    // the registry's fact 1 is a seeded candidate: a dispute is no user transition of it (a refusal code, nothing written), an undo has no user action to cancel
    semanticHistory: { kind: "fact", id: 1 },
    semanticDecide: { kind: "fact", id: 1, action: "dispute" },
    semanticUndo: { kind: "fact", id: 1 },
    // a direct add of an item no seed has: it applies (the refusals and not-found of the route are in semantic-api.test.ts)
    semanticCorrect: {
      correction: { action: "add", entry: { kind: "item", type: "Concept", name: "합성 개념" } },
    },
    // the type definitions (S01-T07): a duplicate of a seed name is a refusal code, a seed has no line to undo, and element 1 (Project) is verified already
    ontologyCheck: { op: "add", name: "project", rule: { elementKind: "item-type" } },
    ontologyChange: { op: "add", name: "project", rule: { elementKind: "item-type" } },
    ontologyDecide: { id: 1, action: "approve" },
    ontologyUndo: { id: 1 },
    ontologyHistory: { id: 1 },
    // entity resolution (S02-T04): the bodies are set in beforeAll, after two items of the user's own and a line between them exist
    entityMerge: { member: 1, into: 1 },
    entityUnmerge: { mergeId: 1 },
    entityDistinct: { a: 1, b: 2, on: true },
  };

  beforeAll(async () => {
    migrate(db);
    await seedV02(db, ["plain"]);
    // two items the user made and the line that merges them: the unmerge route's body, and a distinct mark's two ends
    const made = ["병합 시험 가", "병합 시험 나"].map((name) => {
      const added = userDecisions.add(db, { kind: "item", type: "Concept", name });
      if (added.status !== "applied") throw new Error("the user's item");
      return added.ref.id;
    }) as [number, number];
    const merged = userDecisions.entities.merge(db, made[0], made[1]);
    if (merged.status !== "applied") throw new Error("the merge");
    requests.entityMerge = { member: made[0], into: made[0] }; // already one: a refusal code in a 200 body
    requests.entityUnmerge = { mergeId: merged.mergeId };
    requests.entityDistinct = { a: made[0], b: made[1], on: true };
    const adapters = productAdapters("/synthetic/data");
    const bound = engine();
    projections = productProjections(db, { engine: bound, ...adapters });
    // extraction of what importJsonl stores: a local double answering nothing, so a
    // fact comes only from the engine's proposal
    const egress = productEgress(db);
    const shown = egress.overview().providers.find((p) => p.providerId === "local-model");
    egress.grant("local-model", ["general"], {
      destination: shown?.destination ?? "",
      policyVersion: egress.policyVersion(),
    });
    const extractor = new FakeProvider({
      id: "local-model",
      transport: "http",
      answer: () => ({ items: [], facts: [], relations: [], terms: [], definitions: [] }),
    });
    const { broker } = productCalls(db, egress, { providers: [extractor] });
    runner = productRunner(db, broker, { engine: bound, projections });
    const failing = () => ({
      ...fixtureConnectorKinds()["test-fixtures"](),
      getChanges: () => Promise.reject(new Error("connector broke")),
    });
    const connectors = await createConnectorManager(
      db,
      [
        ...fixtureConnectors(FIXTURES).instances,
        { id: "broken", kind: "failing", config: { file: FIXTURES } },
      ],
      { ...fixtureConnectorKinds(), failing },
    );
    server = await startServer({
      token: TOKEN,
      allowedOrigins: [],
      connectors,
      db,
      dataDirectory: "/synthetic/data",
      egress: productEgress(db),
      // a CLI double, so the Provider routes answer without running any process
      calls: productCalls(db, productEgress(db), {
        providers: [new FakeProvider({ id: "claude-code", transport: "cli" })],
      }),
      ...adapters,
      decisions: userDecisions,
      importer: productImporter(db, { runner, projections }),
      instanceImporter: productInstanceImporter(db, { runner, projections }),
      jobs: {
        scheduler: createScheduler({ db }),
        actions: createJobActions({ db, runner }),
        budgetUsage: broker.budgetUsage,
        projectionNames: ["engine"],
        wake: () => void runner.wake(),
      },
    });
    valid = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` };
  });
  afterAll(async () => {
    await server.close();
    await runner.stop();
    await projections.drain();
    db.close();
  });

  describe("API responses match @pki/contracts", () => {
    it.each(Object.entries(routes))("%s", async (name, route) => {
      const body = requests[name as RouteName];
      expect(body === undefined).toBe(!("request" in route));
      const res = await send(server.port, route.path, valid, route.method, body);
      expect(res.status).toBe(200);
      expect(route.response.parse(res.body)).toEqual(res.body);
    });

    it("extracts an import through the API: the engine's proposal is a candidate fact only when it proposes", async () => {
      // the setDefaultProvider case above picked the CLI; extraction uses the local double
      writeDefaultProvider(db, "local-model");
      const route = routes.importJsonl;
      const res = await send(server.port, route.path, valid, route.method, { text: noteLine() });
      expect(route.response.parse(res.body)).toMatchObject({ created: 1 });
      await projections.drain();
      await runner.wake();
      const facts = db.all(
        `SELECT f.status, e.quote FROM facts f JOIN items i ON i.id = f.item_id
           JOIN evidence e ON e.fact_id = f.id WHERE i.name = '제안 프로젝트'`,
      );
      expect(facts).toEqual(Array(proposed).fill({ status: "candidate", quote: TARGET }));
    });

    it("lists the site Connectors as not implemented", async () => {
      const res = await send(server.port, routes.connectors.path, valid);
      expect(res.body).toMatchObject({
        connectors: expect.arrayContaining([
          { id: "fixtures", kind: "test-fixtures", state: "ready" },
          { id: "site-mail", kind: "site-mail", state: "not-implemented" },
          { id: "site-messenger", kind: "site-messenger", state: "not-implemented" },
          { id: "site-wiki", kind: "site-wiki", state: "not-implemented" },
        ]),
      });
    });

    const sync = routes.syncConnector;
    it.each([
      ["bad-request", 400, "not json"],
      ["bad-request", 400, { connectorId: "" }],
      ["bad-request", 400, { connectorId: "fixtures", extra: 1 }],
      ["bad-request", 400, { connectorId: "x".repeat(20_000) }],
      ["not-found", 404, { connectorId: "nope" }],
      ["connector-unavailable", 409, { connectorId: "site-mail" }],
    ])("sync %s rejection (%i)", async (error, status, body) => {
      const res = await send(server.port, sync.path, valid, sync.method, body);
      expect(res.status).toBe(status);
      expect(ErrorResponseSchema.parse(res.body)).toEqual({ error });
    });

    it("answers a sync that a Connector's exception stopped with the stop code and none of its text (I01-R4, R19)", async () => {
      const res = await send(server.port, sync.path, valid, sync.method, { connectorId: "broken" });
      expect(res.status).toBe(200);
      expect(SyncResponseSchema.parse(res.body)).toMatchObject({
        connectorId: "broken",
        stopped: "connector-failed",
        received: 0,
      });
      expect(JSON.stringify(res.body)).not.toContain("connector broke");
    });

    const changed = routes.credentialsChanged;
    it.each([
      ["bad-request", 400, "not json"],
      ["bad-request", 400, {}],
      ["bad-request", 400, { connectorId: "" }],
      ["bad-request", 400, { connectorId: "fixtures", value: "x" }],
      ["bad-request", 400, { connectorId: "x".repeat(20_000) }],
      ["not-found", 404, { connectorId: "nope" }],
    ])("credentials-changed %s rejection (%i)", async (error, status, body) => {
      const res = await send(server.port, changed.path, valid, changed.method, body);
      expect(res.status).toBe(status);
      expect(ErrorResponseSchema.parse(res.body)).toEqual({ error });
    });

    it("answers a change notice with the instance's summary and what became of the rebuild (I06-R12)", async () => {
      for (const [connectorId, kind, state] of [
        ["site-mail", "site-mail", "not-implemented"],
        ["fixtures", "test-fixtures", "ready"],
      ] as const) {
        const res = await send(server.port, changed.path, valid, changed.method, { connectorId });
        expect(res.status).toBe(200);
        expect(changed.response.parse(res.body)).toMatchObject({
          summary: { id: connectorId, kind, state },
          rebuild: "done",
        });
      }
    });

    const shownVersion = productEgress(db).policyVersion();
    it.each([
      ["bad-request", 400, { providerId: "codex", allowedClasses: [] }],
      ["bad-request", 400, { providerId: "fake", allowedClasses: ["synthetic"] }],
      ["bad-request", 400, { providerId: "codex", allowedClasses: ["synthetic"] }],
      [
        "destination-unavailable",
        409,
        {
          providerId: "openai-compatible",
          allowedClasses: ["synthetic"],
          destination: "api.synthetic.example",
          policyVersion: shownVersion,
        },
      ],
      [
        "consent-stale",
        409,
        {
          providerId: "codex",
          allowedClasses: ["synthetic"],
          destination: "vendor:elsewhere",
          policyVersion: shownVersion,
        },
      ],
    ])("grant consent %s rejection (%i)", async (error, status, body) => {
      // no endpoint, whatever the writeSettings case above stored
      db.run("DELETE FROM settings WHERE key = ?", [OPENAI_BASE_URL_SETTING]);
      const grant = routes.grantConsent;
      const res = await send(server.port, grant.path, valid, grant.method, body);
      expect(res.status).toBe(status);
      expect(ErrorResponseSchema.parse(res.body)).toEqual({ error });
    });

    it.each([
      ["unauthorized", "/api/status", "GET", { authorization: "Bearer wrong" }],
      ["forbidden-host", "/api/status", "GET", { host: "evil.example" }],
      ["forbidden-origin", "/api/status", "GET", { origin: "https://evil.example" }],
      ["not-found", "/api/nope", "GET", {}],
      ["method-not-allowed", "/api/status", "POST", {}],
      ["bad-request", "http://evil.example/api/status", "GET", {}],
    ])("%s rejection", async (error, path, method, override) => {
      const res = await send(server.port, path, { ...valid, ...override }, method);
      expect(ErrorResponseSchema.parse(res.body)).toEqual({ error });
    });
  });
});
