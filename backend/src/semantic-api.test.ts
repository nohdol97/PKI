// S01-T02 `semantic.api` (S01-R22 read, R23): the Semantic registry's list and history, and the user's
// approve, reject, dispute and undo over HTTP. A request passes the token, Host and Origin checks
// and the body schema; a row that is absent, deleted or hidden by the read gate answers the same
// `not-found` and changes nothing; a gate refusal is a code, never a text; a repeat is unchanged.
// All data is synthetic. A `user-override`, `basis-required` or `value-exists` refusal cannot come
// from the three actions of this task (the first two are the automated entry's, the third is T03's):
// the gate's tests (storage/src/semantic-user.test.ts) hold them.
import { routes, type RouteName } from "@pki/contracts";
import { createProductRegistry } from "@pki/knowledge-engine";
import {
  addEvidence,
  automatedLifecycle,
  createDerivativeRegistry,
  defaultScopePolicy,
  insertItem,
  recordTombstone,
  registerConnectorInstance,
  saveFact,
  saveRelation,
  saveSourceRecord,
  userDecisions,
  type DerivativeRegistry,
  type EntryRef,
  type ScopePolicy,
  type SqlDriver,
} from "@pki/storage";
import { send } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCanonicalDb, productAdapters, productEgress } from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import { startServer, type RunningServer } from "./server.ts";

const TOKEN = "s".repeat(43);
const ORIGIN = "http://localhost:5173";
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };
const NAME = "미리내 프로젝트";
const VALUE = "2026-12-05";
const SECRET = ["secret"];

let dir: string;
let db: SqlDriver;
let server: RunningServer | undefined;
let valid: Record<string, string>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-semantic-api-"));
  db = openCanonicalDb(dir);
  registerConnectorInstance(db, "c", "test-fixtures");
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function start(options: { registry?: DerivativeRegistry; decisions?: boolean } = {}) {
  server = await startServer({
    token: TOKEN,
    allowedOrigins: [ORIGIN],
    connectors,
    db,
    dataDirectory: dir,
    egress: productEgress(db),
    ...productAdapters(dir),
    ...(options.decisions === false ? {} : { decisions: userDecisions }),
    ...(options.registry ? { registry: options.registry } : {}),
  });
  valid = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` };
}

const call = (name: RouteName, body?: unknown, headers = valid) =>
  send((server as RunningServer).port, routes[name].path, headers, routes[name].method, body);

const attrs = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-22T00:00:00Z",
} as const;

/** A stored source (with an optional access scope) and its version row id. */
function source(externalId: string, accessScope: string[] | null = null) {
  const saved = saveSourceRecord(db, "c", {
    externalId,
    title: `제목 ${externalId}`,
    body: `${NAME}의 목표일은 ${VALUE}`,
    accessScope,
  });
  if (saved.status !== "created") throw new Error(saved.status);
  const versionId = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
  return { sourceId: saved.sourceId, versionId, version: saved.version };
}

/** An item with a fact and a relation to a second item, as extraction writes them: a creation line, evidence. */
function world(externalId = "a", accessScope: string[] | null = null) {
  const s = source(externalId, accessScope);
  const basis = { sourceId: s.sourceId, version: s.version };
  const created = (ref: EntryRef) => automatedLifecycle.created(db, ref, "extraction", basis);
  const item = insertItem(db, { type: "Project", name: NAME, ...attrs });
  const other = insertItem(db, { type: "System", name: `${NAME} 물결`, ...attrs });
  const fact = saveFact(db, { itemId: item, kind: "target_date", value: VALUE, ...attrs }).id;
  const relation = saveRelation(db, {
    subjectId: item,
    type: "DEPENDS_ON",
    objectId: other,
    ...attrs,
  }).id;
  for (const ref of [
    { kind: "item", id: item },
    { kind: "item", id: other },
    { kind: "fact", id: fact },
    { kind: "relation", id: relation },
  ] as const) {
    created(ref);
  }
  const quote = NAME;
  addEvidence(db, {
    target: { factId: fact },
    sourceVersionId: s.versionId,
    start: 0,
    end: [...quote].length,
    quote,
  });
  addEvidence(db, {
    target: { relationId: relation },
    sourceVersionId: s.versionId,
    start: 0,
    end: [...quote].length,
    quote,
  });
  return { ...s, item, other, fact, relation };
}

const ALL_FIXTURE_TEXT = [NAME, VALUE];
const leaks = (body: unknown) =>
  ALL_FIXTURE_TEXT.filter((text) => JSON.stringify(body).includes(text));

describe("GET /api/semantic: the registry's rows", () => {
  it("lists items with their facts and relations, status, epistemic type, confidence, evidence count and user flags", async () => {
    const w = world();
    await start();
    const res = await call("semantic");
    expect(res.status).toBe(200);
    const list = routes.semantic.response.parse(res.body);
    expect(list.truncated).toBe(false);
    const item = list.items.find((i) => i.id === w.item);
    expect(item).toMatchObject({
      type: "Project",
      name: NAME,
      status: "candidate",
      epistemic: "explicit",
      confidence: null,
      userDecided: false,
      userAuthored: false,
    });
    expect(item?.facts).toEqual([
      expect.objectContaining({
        id: w.fact,
        kind: "target_date",
        value: VALUE,
        context: null,
        evidenceCount: 1,
        status: "candidate",
      }),
    ]);
    expect(item?.relations).toEqual([
      expect.objectContaining({
        id: w.relation,
        type: "DEPENDS_ON",
        subjectId: w.item,
        objectId: w.other,
      }),
    ]);
  });

  it("shows an approval at once, as user-approved and user-decided, and an undo takes it back", async () => {
    const w = world();
    await start();
    await call("semanticDecide", { kind: "fact", id: w.fact, action: "approve" });
    const after = routes.semantic.response.parse((await call("semantic")).body);
    expect(after.items.find((i) => i.id === w.item)?.facts[0]).toMatchObject({
      status: "verified",
      epistemic: "user-approved",
      userDecided: true,
    });
    await call("semanticUndo", { kind: "fact", id: w.fact });
    const undone = routes.semantic.response.parse((await call("semantic")).body);
    expect(undone.items.find((i) => i.id === w.item)?.facts[0]).toMatchObject({
      status: "candidate",
      epistemic: "explicit",
      userDecided: false,
    });
  });

  it.each([
    [100, false],
    [101, true],
  ])("lists %i items and says truncated=%s at the limit of 100", async (count, truncated) => {
    for (let i = 0; i < count; i++) insertItem(db, { type: "Project", name: `P${i}`, ...attrs });
    await start();
    const list = routes.semantic.response.parse((await call("semantic")).body);
    expect(list.items).toHaveLength(100);
    expect(list.truncated).toBe(truncated);
  });

  it("counts the evidence on the source's current version only, for a fact and a relation", async () => {
    const w = world();
    await start();
    const counts = async () => {
      const item = routes.semantic.response
        .parse((await call("semantic")).body)
        .items.find((i) => i.id === w.item);
      return [item?.facts[0]?.evidenceCount, item?.relations[0]?.evidenceCount];
    };
    expect(await counts()).toEqual([1, 1]);
    // a newer version that no longer cites them: the evidence rows stay, as past evidence
    saveSourceRecord(db, "c", { externalId: "a", title: "제목 a", body: "다른 내용" });
    expect(
      db.all("SELECT 1 FROM evidence WHERE fact_id = ? OR relation_id = ?", [w.fact, w.relation]),
    ).toHaveLength(2);
    expect(await counts()).toEqual([0, 0]);
  });
});

describe("POST /api/semantic/decide and /undo", () => {
  it.each(["item", "fact", "relation"] as const)(
    "approves a %s, writes its history line and answers the row as it is",
    async (kind) => {
      const w = world();
      await start();
      const id = { item: w.item, fact: w.fact, relation: w.relation }[kind];
      const res = await call("semanticDecide", { kind, id, action: "approve" });
      expect(res.status).toBe(200);
      expect(routes.semanticDecide.response.parse(res.body)).toEqual({
        status: "applied",
        seq: 2,
        entry: { kind, id, status: "verified", epistemic: "user-approved" },
      });
      const history = routes.semanticHistory.response.parse(
        (await call("semanticHistory", { kind, id })).body,
      );
      expect(history.lines).toMatchObject([
        {
          seq: 1,
          actor: "extraction",
          action: "created",
          toStatus: "candidate",
          basisSourceId: w.sourceId,
        },
        { seq: 2, actor: "user", action: "approve", fromStatus: "candidate", toStatus: "verified" },
      ]);
      expect(leaks(history)).toEqual([]);
    },
  );

  it("rejects and disputes by the table, and refuses a transition it does not list as a code, writing nothing", async () => {
    const w = world();
    await start();
    const reject = await call("semanticDecide", { kind: "fact", id: w.fact, action: "reject" });
    expect(routes.semanticDecide.response.parse(reject.body)).toMatchObject({
      status: "applied",
      entry: { status: "rejected", epistemic: "explicit" },
    });
    // rejected -> disputed is not a user transition
    const refused = await call("semanticDecide", { kind: "fact", id: w.fact, action: "dispute" });
    expect(refused).toEqual({
      status: 200,
      body: { status: "refused", reason: "invalid-transition" },
    });
    const lines = routes.semanticHistory.response.parse(
      (await call("semanticHistory", { kind: "fact", id: w.fact })).body,
    ).lines;
    expect(lines.map((l) => l.action)).toEqual(["created", "reject"]);
  });

  it("answers a repeated action unchanged, with the same row, and writes no second line", async () => {
    const w = world();
    await start();
    const body = { kind: "relation", id: w.relation, action: "approve" };
    expect((await call("semanticDecide", body)).body).toMatchObject({ status: "applied" });
    const again = await call("semanticDecide", body);
    expect(again).toEqual({
      status: 200,
      body: {
        status: "unchanged",
        entry: { kind: "relation", id: w.relation, status: "verified", epistemic: "user-approved" },
      },
    });
    const lines = routes.semanticHistory.response.parse(
      (await call("semanticHistory", { kind: "relation", id: w.relation })).body,
    ).lines;
    expect(lines).toHaveLength(2);
  });

  it("undoes the newest user action, and refuses with codes: nothing-to-undo, not-latest", async () => {
    const w = world();
    await start();
    const ref = { kind: "fact", id: w.fact };
    // only the extraction's creation line: not a user action
    expect((await call("semanticUndo", ref)).body).toEqual({
      status: "refused",
      reason: "not-latest",
    });
    await call("semanticDecide", { ...ref, action: "approve" });
    expect((await call("semanticUndo", ref)).body).toMatchObject({
      status: "applied",
      seq: 3,
      entry: { status: "candidate", epistemic: "explicit" },
    });
    expect((await call("semanticUndo", ref)).body).toEqual({
      status: "refused",
      reason: "nothing-to-undo",
    });
    // a user action followed by an automated change is not undone
    await call("semanticDecide", { ...ref, action: "approve" });
    automatedLifecycle.supersede(db, ref as EntryRef, { sourceId: w.sourceId, version: 1 });
    expect((await call("semanticUndo", ref)).body).toEqual({
      status: "refused",
      reason: "not-latest",
    });
  });

  it("holds a row the user decided against the automated entry: the explicit-evidence rise is refused, the row unchanged", async () => {
    const w = world();
    await start();
    await call("semanticDecide", { kind: "fact", id: w.fact, action: "reject" });
    expect(
      automatedLifecycle.explicitEvidence(
        db,
        { kind: "fact", id: w.fact },
        { sourceId: 1, version: 1 },
      ),
    ).toEqual({ status: "refused", reason: "user-override" });
    const list = routes.semantic.response.parse((await call("semantic")).body);
    expect(list.items.find((i) => i.id === w.item)?.facts[0]?.status).toBe("rejected");
  });
});

describe("validation and the request checks", () => {
  // [name, body, whether the undo route (kind and id only) refuses it as well]
  const bad: [string, unknown, boolean][] = [
    ["an unknown action", { kind: "fact", id: 1, action: "delete" }, false],
    ["a kind that is not a registry row", { kind: "ontology", id: 1, action: "approve" }, true],
    ["a missing id", { kind: "fact", action: "approve" }, true],
    ["an id of zero", { kind: "fact", id: 0, action: "approve" }, true],
    ["a fractional id", { kind: "fact", id: 1.5, action: "approve" }, true],
    ["an extra key", { kind: "fact", id: 1, action: "approve", status: "verified" }, true],
    ["no body", undefined, true],
  ];
  it.each(bad)("answers 400 to %s and changes nothing", async (_name, body, undoRefuses) => {
    const w = world();
    await start();
    expect((await call("semanticDecide", body)).status).toBe(400);
    if (undoRefuses) expect((await call("semanticUndo", body)).status).toBe(400);
    expect(db.all("SELECT status FROM facts WHERE id = ?", [w.fact])).toEqual([
      { status: "candidate" },
    ]);
    expect(db.all("SELECT 1 FROM fact_history WHERE fact_id = ?", [w.fact])).toHaveLength(1);
  });

  it("refuses a request without the token, with a wrong Host or a foreign Origin, on every route, and changes nothing", async () => {
    const w = world();
    await start();
    const bodies: Record<string, unknown> = {
      semantic: undefined,
      semanticHistory: { kind: "fact", id: w.fact },
      semanticDecide: { kind: "fact", id: w.fact, action: "approve" },
      semanticUndo: { kind: "fact", id: w.fact },
    };
    for (const [name, body] of Object.entries(bodies)) {
      for (const [header, value, status] of [
        ["authorization", "Bearer wrong", 401],
        ["host", "evil.example", 403],
        ["origin", "https://evil.example", 403],
      ] as const) {
        const res = await call(name as RouteName, body, { ...valid, [header]: value });
        expect([name, res.status]).toEqual([name, status]);
      }
      const bare = { host: valid.host as string };
      expect([name, (await call(name as RouteName, body, bare)).status]).toEqual([name, 401]);
    }
    expect(db.all("SELECT status FROM facts WHERE id = ?", [w.fact])).toEqual([
      { status: "candidate" },
    ]);
    expect(db.all("SELECT 1 FROM fact_history WHERE fact_id = ?", [w.fact])).toHaveLength(1);
    // the same request with an allowed Origin goes through
    const ok = await call("semanticDecide", bodies.semanticDecide, { ...valid, origin: ORIGIN });
    expect(ok.status).toBe(200);
    expect(db.all("SELECT status FROM facts WHERE id = ?", [w.fact])).toEqual([
      { status: "verified" },
    ]);
  });

  it("does not answer a read route with POST or an action route with GET", async () => {
    await start();
    const port = (server as RunningServer).port;
    expect((await send(port, "/api/semantic/decide", valid, "GET")).status).toBe(405);
    expect((await send(port, "/api/semantic", valid, "POST", {})).status).toBe(405);
  });

  it("answers not-found to an action route when the server was given no user entry", async () => {
    const w = world();
    await start({ decisions: false });
    const res = await call("semanticDecide", { kind: "fact", id: w.fact, action: "approve" });
    expect(res).toEqual({ status: 404, body: { error: "not-found" } });
    expect(db.all("SELECT status FROM facts WHERE id = ?", [w.fact])).toEqual([
      { status: "candidate" },
    ]);
  });
});

describe("a row that is absent, deleted or hidden (S01-R22: no existence leak)", () => {
  const policy: ScopePolicy = {
    ...defaultScopePolicy,
    allows: (scopes) => !scopes.some((s) => s?.includes("secret")),
  };
  const hiding = createDerivativeRegistry({
    kinds: createProductRegistry({ policy: defaultScopePolicy }).kinds,
    policy,
  });

  const NOT_FOUND = { status: 404, body: { error: "not-found" } };
  const probe = async (kind: "item" | "fact" | "relation", id: number) => [
    await call("semanticDecide", { kind, id, action: "approve" }),
    await call("semanticDecide", { kind, id, action: "reject" }),
    await call("semanticUndo", { kind, id }),
    await call("semanticHistory", { kind, id }),
  ];

  it("answers every route the one same not-found for an id that is not stored", async () => {
    await start();
    for (const kind of ["item", "fact", "relation"] as const) {
      for (const res of await probe(kind, 99_999)) expect(res).toEqual(NOT_FOUND);
    }
  });

  it("answers the same not-found, changes nothing and leaves it out of the list for a row the policy hides, a row a tombstone covers, and a row whose source is gone", async () => {
    const open = world("open");
    const hidden = world("hidden", SECRET);
    const covered = world("covered");
    recordTombstone(db, covered.sourceId, {
      reason: "user-deleted",
      lastRevision: null,
      at: "2026-11-22T00:00:00Z",
    });
    await start({ registry: hiding });
    for (const w of [hidden, covered]) {
      for (const [kind, id] of [
        ["item", w.item],
        ["fact", w.fact],
        ["relation", w.relation],
      ] as const) {
        for (const res of await probe(kind, id))
          expect([w.sourceId, kind, res]).toEqual([w.sourceId, kind, NOT_FOUND]);
      }
      expect(
        db.all("SELECT 1 FROM fact_history WHERE fact_id = ? AND actor = 'user'", [w.fact]),
      ).toEqual([]);
      expect(db.all("SELECT status FROM facts WHERE id = ?", [w.fact])).toEqual([
        { status: "candidate" },
      ]);
    }
    const list = routes.semantic.response.parse((await call("semantic")).body);
    expect(list.items.map((i) => i.id).sort()).toEqual([open.item, open.other].sort());
    // the open row is still reachable
    expect(
      (await call("semanticDecide", { kind: "fact", id: open.fact, action: "approve" })).status,
    ).toBe(200);
  });

  // a policy that denies a scope set of exactly the secret source: an item over two sources is
  // shown, its fact from the secret source alone is not
  it("leaves a hidden fact and a hidden relation out of a shown item, and answers not-found to them", async () => {
    const open = world("open");
    const secret = source("secret", SECRET);
    const hiddenFact = saveFact(db, {
      itemId: open.item,
      kind: "owner",
      value: "합성",
      ...attrs,
    }).id;
    automatedLifecycle.created(db, { kind: "fact", id: hiddenFact }, "extraction", null);
    addEvidence(db, {
      target: { factId: hiddenFact },
      sourceVersionId: secret.versionId,
      start: 0,
      end: 2,
      quote: NAME.slice(0, 2),
    });
    // a relation under the same shown item, cited only from the secret source
    const hiddenRelation = saveRelation(db, {
      subjectId: open.item,
      type: "OWNS",
      objectId: open.other,
      ...attrs,
    }).id;
    automatedLifecycle.created(db, { kind: "relation", id: hiddenRelation }, "extraction", null);
    addEvidence(db, {
      target: { relationId: hiddenRelation },
      sourceVersionId: secret.versionId,
      start: 0,
      end: 2,
      quote: NAME.slice(0, 2),
    });
    const alone: ScopePolicy = {
      ...defaultScopePolicy,
      allows: (scopes) => !(scopes.length === 1 && scopes[0]?.includes("secret")),
    };
    await start({
      registry: createDerivativeRegistry({
        kinds: createProductRegistry({ policy: defaultScopePolicy }).kinds,
        policy: alone,
      }),
    });
    const list = routes.semantic.response.parse((await call("semantic")).body);
    const item = list.items.find((i) => i.id === open.item);
    expect(item?.facts.map((f) => f.id)).toEqual([open.fact]);
    for (const res of await probe("fact", hiddenFact)) expect(res).toEqual(NOT_FOUND);
    expect(item?.relations.map((r) => r.id)).toEqual([open.relation]);
    for (const res of await probe("relation", hiddenRelation)) expect(res).toEqual(NOT_FOUND);
    expect(db.all("SELECT status FROM relations WHERE id = ?", [hiddenRelation])).toEqual([
      { status: "candidate" },
    ]);
    expect(db.all("SELECT status FROM facts WHERE id = ?", [hiddenFact])).toEqual([
      { status: "candidate" },
    ]);
  });

  it("answers a hidden row exactly as a row that does not exist, in status, headers' body and shape", async () => {
    const hidden = world("hidden", SECRET);
    await start({ registry: hiding });
    const [real] = await probe("fact", hidden.fact);
    const [absent] = await probe("fact", hidden.fact + 1000);
    expect(real).toEqual(absent);
    expect(leaks(real)).toEqual([]);
  });

  it("carries no fixture text in a refusal, a not-found or a validation error", async () => {
    const w = world();
    await start();
    await call("semanticDecide", { kind: "fact", id: w.fact, action: "reject" });
    for (const res of [
      await call("semanticDecide", { kind: "fact", id: w.fact, action: "dispute" }),
      await call("semanticUndo", { kind: "item", id: w.item }),
      await call("semanticDecide", { kind: "fact", id: 99_999, action: "approve" }),
      await call("semanticDecide", { kind: "fact", id: w.fact, action: NAME }),
    ]) {
      expect(leaks(res.body)).toEqual([]);
    }
  });
});
