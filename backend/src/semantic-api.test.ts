// S01-T02 `semantic.api` (S01-R22 read, R23): the Semantic registry's list and history, and the user's
// approve, reject, dispute and undo over HTTP. A request passes the token, Host and Origin checks
// and the body schema; a row that is absent, deleted or hidden by the read gate answers the same
// `not-found` and changes nothing; a gate refusal is a code, never a text; a repeat is unchanged.
// All data is synthetic. A `user-override` or `basis-required` refusal cannot come from the user's
// actions (the automated entry's): the gate's tests (storage/src/semantic-user.test.ts) hold them.
// S01-T03 adds the direct add and the value fix (`POST /api/semantic/correct`, `value-exists`).
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

describe("GET /api/semantic: members under their representative (S02-R13)", () => {
  const AT = "2026-11-23T00:00:00.000Z";
  /** The user's merge through the entry (the line is the user's, its number is the answer): the member is the representative's. */
  const mergeInto = (member: number, representative: number) => {
    const done = userDecisions.entities.merge(db, member, representative, AT);
    if (done.status !== "applied") throw new Error(done.reason);
    return done.mergeId;
  };
  const list = async () => routes.semantic.response.parse((await call("semantic")).body);

  it("lists a member under its representative with its own facts and relations and the number of its merge line; the member is no top-level entry", async () => {
    const [a, b] = [world("a"), world("b")] as const;
    const mergeId = mergeInto(a.item, b.item);
    await start();
    const body = await list();
    expect(body.items.map((i) => i.id)).toEqual([a.other, b.item, b.other].sort((x, y) => x - y));
    const rep = body.items.find((i) => i.id === b.item);
    expect(rep?.members).toEqual([
      expect.objectContaining({
        id: a.item,
        mergeId,
        mergedInto: b.item,
        facts: [expect.objectContaining({ id: a.fact, value: VALUE })],
        relations: [expect.objectContaining({ id: a.relation, objectId: a.other })],
      }),
    ]);
    // a lone item has no members, and the representative keeps only its own rows
    expect(body.items.find((i) => i.id === b.other)?.members).toEqual([]);
    expect(rep?.facts.map((f) => f.id)).toEqual([b.fact]);
  });

  it("an unmerge by the listed number puts the member back at the top level", async () => {
    const [a, b] = [world("a"), world("b")] as const;
    mergeInto(a.item, b.item);
    await start();
    const before = await list();
    const mergeId = before.items.find((i) => i.id === b.item)?.members[0]?.mergeId as number;
    expect(
      routes.entityUnmerge.response.parse((await call("entityUnmerge", { mergeId })).body),
    ).toEqual({
      status: "applied",
    });
    const after = await list();
    expect(after.items.map((i) => i.id)).toContain(a.item);
    expect(after.items.find((i) => i.id === b.item)?.members).toEqual([]);
  });

  it("lists both items at the top level while their group rests", async () => {
    const [a, b] = [world("a"), world("b")] as const;
    mergeInto(a.item, b.item);
    db.run("UPDATE item_merges SET active = 0");
    await start();
    const body = await list();
    expect(body.items.map((i) => i.id)).toEqual(expect.arrayContaining([a.item, b.item]));
    expect(body.items.every((i) => i.members.length === 0)).toBe(true);
  });

  it("a chain A->B->C lists A and B under C, each with its own line's number and the item it points at", async () => {
    const [a, b, c] = [world("a"), world("b"), world("c")] as const;
    const first = mergeInto(a.item, b.item);
    const second = mergeInto(b.item, c.item);
    await start();
    const members = (await list()).items.find((i) => i.id === c.item)?.members;
    expect(members?.map((m) => [m.id, m.mergeId, m.mergedInto])).toEqual([
      [a.item, first, b.item],
      [b.item, second, c.item],
    ]);
  });

  it("leaves a member the policy hides out of its representative's members, and a hidden row of a member out of the member", async () => {
    // hides a source set of exactly the secret source: an item over two sources is shown, a row from it alone is not
    const alone: ScopePolicy = {
      ...defaultScopePolicy,
      allows: (scopes) => !(scopes.length === 1 && scopes[0]?.includes("secret")),
    };
    const hiding = createDerivativeRegistry({
      kinds: createProductRegistry({ policy: defaultScopePolicy }).kinds,
      policy: alone,
    });
    const [rep, shown, hidden] = [world("rep"), world("shown"), world("hidden", SECRET)] as const;
    const secret = source("secret", SECRET);
    const hiddenRow = saveFact(db, {
      itemId: shown.item,
      kind: "completion_date",
      value: "2027-01-01",
      ...attrs,
    }).id;
    addEvidence(db, {
      target: { factId: hiddenRow },
      sourceVersionId: secret.versionId,
      start: 0,
      end: 1,
      quote: [...`${NAME}의 목표일은 ${VALUE}`][0] as string,
    });
    mergeInto(shown.item, rep.item);
    mergeInto(hidden.item, rep.item);
    await start({ registry: hiding });
    const members = (await list()).items.find((i) => i.id === rep.item)?.members;
    expect(members?.map((m) => m.id)).toEqual([shown.item]);
    expect(members?.[0]?.facts.map((f) => f.id)).toEqual([shown.fact]);
  });

  it("counts representatives against the limit: members do not make the list truncated", async () => {
    const [a, b] = [world("a"), world("b")] as const;
    mergeInto(a.item, b.item);
    // 100 further lone items bring the top level to exactly the limit with the representative, members aside
    for (let i = 0; i < 97; i++) insertItem(db, { type: "Project", name: `P${i}`, ...attrs });
    await start();
    const body = await list();
    // a.other, b.item, b.other and 97 lone items = 100 top-level entries; a.item is a member
    expect(body.items).toHaveLength(100);
    expect(body.truncated).toBe(false);
  });

  it("pins the limit: a member whose representative the policy hides is not listed anywhere", async () => {
    const policy: ScopePolicy = {
      ...defaultScopePolicy,
      allows: (scopes) => !scopes.some((s) => s?.includes("secret")),
    };
    const hiding = createDerivativeRegistry({
      kinds: createProductRegistry({ policy: defaultScopePolicy }).kinds,
      policy,
    });
    const [member, hiddenRep] = [world("member"), world("hidden-rep", SECRET)] as const;
    mergeInto(member.item, hiddenRep.item);
    await start({ registry: hiding });
    const ids = (await list()).items.flatMap((i) => [i.id, ...i.members.map((m) => m.id)]);
    expect(ids).not.toContain(member.item);
    expect(ids).not.toContain(hiddenRep.item);
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
      semanticCorrect: {
        correction: {
          action: "add",
          entry: { kind: "fact", itemId: w.item, factKind: "owner", value: "합성" },
        },
      },
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
    // the refused requests added nothing; the one with an allowed Origin adds the row
    expect(db.all("SELECT 1 FROM facts WHERE kind = 'owner'")).toHaveLength(0);
    const added = await call("semanticCorrect", bodies.semanticCorrect, {
      ...valid,
      origin: ORIGIN,
    });
    expect(added.status).toBe(200);
    expect(db.all("SELECT 1 FROM facts WHERE kind = 'owner'")).toHaveLength(1);
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
    expect(
      await call("semanticCorrect", {
        correction: { action: "replace", id: w.fact, value: "2026-12-06" },
      }),
    ).toEqual({ status: 404, body: { error: "not-found" } });
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

describe("POST /api/semantic/correct: a direct add and a value fix (S01-T03, R7, R23)", () => {
  const correct = (correction: unknown) => call("semanticCorrect", { correction });
  const addFact = (itemId: number, value: string, factKind = "target_date") =>
    correct({ action: "add", entry: { kind: "fact", itemId, factKind, value } });
  const fixFact = (id: number, value: string) => correct({ action: "replace", id, value });
  const parse = (res: { body: unknown }) => routes.semanticCorrect.response.parse(res.body);
  const listed = async (itemId: number) =>
    routes.semantic.response
      .parse((await call("semantic")).body)
      .items.find((i) => i.id === itemId);
  const counts = () => ({
    facts: db.all("SELECT count(*) AS n FROM facts")[0]?.n,
    items: db.all("SELECT count(*) AS n FROM items")[0]?.n,
    relations: db.all("SELECT count(*) AS n FROM relations")[0]?.n,
    lines: db.all("SELECT count(*) AS n FROM fact_history")[0]?.n,
  });

  it("adds a fact the user wrote: verified, user-approved, listed as written and decided, with its creation line", async () => {
    const w = world();
    await start();
    const res = await addFact(w.item, "  2026-12-24  ");
    expect(res.status).toBe(200);
    const body = parse(res);
    expect(body).toMatchObject({
      status: "applied",
      seq: 1,
      entry: { kind: "fact", status: "verified", epistemic: "user-approved" },
    });
    const id = body.entry?.id as number;
    expect(db.all("SELECT value FROM facts WHERE id = ?", [id])).toEqual([{ value: "2026-12-24" }]); // trimmed
    const row = (await listed(w.item))?.facts.find((f) => f.id === id);
    expect(row).toMatchObject({
      value: "2026-12-24",
      status: "verified",
      epistemic: "user-approved",
      confidence: null,
      userDecided: true,
      userAuthored: true,
      evidenceCount: 0,
    });
    const history = await call("semanticHistory", { kind: "fact", id });
    expect(routes.semanticHistory.response.parse(history.body).lines).toEqual([
      expect.objectContaining({
        seq: 1,
        actor: "user",
        action: "created",
        fromStatus: null,
        toStatus: "verified",
        toEpistemic: "user-approved",
        batch: null,
      }),
    ]);
    expect(leaks(history.body)).toEqual([]);
  });

  it("adds an item and a relation, and an undo of each deletes the row and answers removed", async () => {
    const w = world();
    await start();
    const item = parse(
      await correct({ action: "add", entry: { kind: "item", type: "Concept", name: "합성 개념" } }),
    );
    const itemId = item.entry?.id as number;
    const relation = parse(
      await correct({
        action: "add",
        entry: { kind: "relation", subjectId: w.item, type: "RELATES_TO", objectId: itemId },
      }),
    );
    expect(relation).toMatchObject({ status: "applied", entry: { kind: "relation" } });
    const relationId = relation.entry?.id as number;
    expect((await listed(w.item))?.relations.map((r) => r.id)).toContain(relationId);
    // the item has a relation hanging on it: its undo is refused, the relation's is not
    // (S02-R11: the refusal is `existing-data-violation` with the counts, as for a merge line; it was `not-latest`)
    expect((await call("semanticUndo", { kind: "item", id: itemId })).body).toEqual({
      status: "refused",
      reason: "existing-data-violation",
      held: { facts: 0, relations: 1, merges: 0, distinct: 0, splitMoves: 0 },
    });
    const gone = await call("semanticUndo", { kind: "relation", id: relationId });
    expect(routes.semanticUndo.response.parse(gone.body)).toEqual({ status: "removed" });
    expect((await call("semanticUndo", { kind: "item", id: itemId })).body).toEqual({
      status: "removed",
    });
    expect((await listed(w.item))?.relations.map((r) => r.id)).not.toContain(relationId);
    expect(await listed(itemId)).toBeUndefined();
    // a row that is gone is the one not-found
    expect(await call("semanticUndo", { kind: "item", id: itemId })).toEqual({
      status: 404,
      body: { error: "not-found" },
    });
  });

  it("fixes a candidate's value: the old row is rejected, the new one is the user's, and one undo takes both back", async () => {
    const w = world();
    await start();
    const res = parse(await fixFact(w.fact, "2026-12-20"));
    expect(res).toMatchObject({
      status: "applied",
      entry: { kind: "fact", status: "verified", epistemic: "user-approved" },
      replaced: { kind: "fact", id: w.fact, status: "rejected", epistemic: "explicit" },
    });
    const fresh = res.entry?.id as number;
    const item = await listed(w.item);
    expect(item?.facts.map((f) => [f.id, f.status, f.userAuthored])).toEqual([
      [w.fact, "rejected", false],
      [fresh, "verified", true],
    ]);
    const lines = routes.semanticHistory.response.parse(
      (await call("semanticHistory", { kind: "fact", id: w.fact })).body,
    ).lines;
    expect(lines.at(-1)).toMatchObject({ actor: "user", action: "replace", toStatus: "rejected" });
    expect(lines.at(-1)?.batch).not.toBeNull();

    const undone = await call("semanticUndo", { kind: "fact", id: w.fact });
    expect(routes.semanticUndo.response.parse(undone.body)).toMatchObject({
      status: "applied",
      entry: { status: "candidate", epistemic: "explicit" },
    });
    expect((await listed(w.item))?.facts.map((f) => [f.id, f.status])).toEqual([
      [w.fact, "candidate"],
    ]);
    expect((await call("semanticUndo", { kind: "fact", id: w.fact })).body).toEqual({
      status: "refused",
      reason: "nothing-to-undo",
    });
  });

  it("stores an item name trimmed, and catches the untrimmed duplicate", async () => {
    world();
    await start();
    const add = (name: string) =>
      correct({ action: "add", entry: { kind: "item", type: "Concept", name } });
    const first = parse(await add("  합성 개념 "));
    expect(db.all("SELECT name FROM items WHERE id = ?", [first.entry?.id as number])).toEqual([
      { name: "합성 개념" },
    ]);
    expect(parse(await add("합성 개념 "))).toEqual({
      status: "refused",
      reason: "value-exists",
      existing: { kind: "item", id: first.entry?.id },
    });
    expect(db.all("SELECT 1 FROM items WHERE type = 'Concept'")).toHaveLength(1);
  });

  it("stores a fixed value trimmed, as an added one", async () => {
    const w = world();
    await start();
    const res = parse(await fixFact(w.fact, "  2026-12-20 \n"));
    expect(db.all("SELECT value FROM facts WHERE id = ?", [res.entry?.id as number])).toEqual([
      { value: "2026-12-20" },
    ]);
  });

  it("fixes a verified fact: the old row is superseded; undone from the new row it answers removed and restores the old", async () => {
    const w = world();
    await start();
    await call("semanticDecide", { kind: "fact", id: w.fact, action: "approve" });
    const res = parse(await fixFact(w.fact, "2026-12-20"));
    expect(res.replaced).toMatchObject({ status: "superseded", epistemic: "user-approved" });
    const undone = await call("semanticUndo", { kind: "fact", id: res.entry?.id });
    expect(undone.body).toEqual({ status: "removed" });
    expect((await listed(w.item))?.facts).toEqual([
      expect.objectContaining({ id: w.fact, status: "verified", epistemic: "user-approved" }),
    ]);
  });

  it("refuses a fix of a fact that is already superseded or rejected, as a code, writing nothing", async () => {
    const w = world();
    await start();
    await call("semanticDecide", { kind: "fact", id: w.fact, action: "reject" });
    const before = counts();
    const res = await fixFact(w.fact, "2026-12-20");
    expect(res).toEqual({ status: 200, body: { status: "refused", reason: "invalid-transition" } });
    expect(counts()).toEqual(before);
  });

  // the next step the refusal advertises, end to end
  it.each([
    ["candidate", async () => undefined],
    [
      "rejected",
      async (w: { fact: number }) =>
        void (await call("semanticDecide", { kind: "fact", id: w.fact, action: "reject" })),
    ],
    [
      "disputed",
      async (w: { fact: number }) => {
        await call("semanticDecide", { kind: "fact", id: w.fact, action: "approve" });
        await call("semanticDecide", { kind: "fact", id: w.fact, action: "dispute" });
      },
    ],
    [
      "superseded",
      async (w: { fact: number; sourceId: number; version: number }) => {
        // the propagation superseded it: a newer version no longer cites it
        saveSourceRecord(db, "c", { externalId: "a", title: "제목 a", body: "다른 내용" });
        expect(
          automatedLifecycle.supersede(
            db,
            { kind: "fact", id: w.fact },
            { sourceId: w.sourceId, version: 2 },
          ).status,
        ).toBe("applied");
      },
    ],
  ] as const)(
    "refuses an add and a fix of a value a %s fact has, naming it, and approving that id then undoing returns it",
    async (status, prepare) => {
      const w = world();
      await start();
      await prepare(w);
      const before = counts();
      const prior = db.all("SELECT status, epistemic FROM facts WHERE id = ?", [w.fact])[0];
      expect(prior?.status).toBe(status);
      const other = parse(await addFact(w.item, "2026-12-01")); // a row whose value could be fixed to it
      const added = await addFact(w.item, VALUE);
      expect(parse(added)).toEqual({
        status: "refused",
        reason: "value-exists",
        existing: { kind: "fact", id: w.fact },
      });
      const fixed = await fixFact(other.entry?.id as number, VALUE);
      expect(fixed.body).toEqual(added.body);
      expect(counts()).toEqual({
        ...before,
        facts: (before.facts as number) + 1,
        lines: (before.lines as number) + 1,
      });
      expect(leaks(added.body)).toEqual([]);

      // approve it, then take the approval back
      const approved = await call("semanticDecide", {
        kind: "fact",
        id: w.fact,
        action: "approve",
      });
      expect(approved.body).toMatchObject({
        status: status === "disputed" ? "applied" : "applied",
        entry: { status: "verified", epistemic: "user-approved" },
      });
      await call("semanticUndo", { kind: "fact", id: w.fact });
      expect(db.all("SELECT status, epistemic FROM facts WHERE id = ?", [w.fact])[0]).toEqual(
        prior,
      );
    },
  );

  it("refuses a relation that exists, and an item with the same type and name, naming the row", async () => {
    const w = world();
    await start();
    const relation = await correct({
      action: "add",
      entry: { kind: "relation", subjectId: w.item, type: "DEPENDS_ON", objectId: w.other },
    });
    expect(relation.body).toEqual({
      status: "refused",
      reason: "value-exists",
      existing: { kind: "relation", id: w.relation },
    });
    const item = await correct({
      action: "add",
      entry: { kind: "item", type: "Project", name: NAME },
    });
    expect(item.body).toEqual({
      status: "refused",
      reason: "value-exists",
      existing: { kind: "item", id: w.item },
    });
  });

  const long = (n: number, unit = "가") => unit.repeat(n);
  const bad: [string, unknown][] = [
    ["an unknown action", { action: "delete", id: 1, value: "x" }],
    ["no correction", undefined],
    [
      "a name that is no identifier",
      { action: "add", entry: { kind: "fact", itemId: 1, factKind: "9lives", value: "x" } },
    ],
    [
      "a kind with a space",
      { action: "add", entry: { kind: "fact", itemId: 1, factKind: "a b", value: "x" } },
    ],
    [
      "a kind of 41 characters",
      { action: "add", entry: { kind: "fact", itemId: 1, factKind: long(41, "a"), value: "x" } },
    ],
    [
      "an empty value",
      { action: "add", entry: { kind: "fact", itemId: 1, factKind: "owner", value: "" } },
    ],
    [
      "a blank value",
      { action: "add", entry: { kind: "fact", itemId: 1, factKind: "owner", value: "   " } },
    ],
    [
      "a value of 501 code points",
      { action: "add", entry: { kind: "fact", itemId: 1, factKind: "owner", value: long(501) } },
    ],
    [
      "a value of 501 emoji",
      {
        action: "add",
        entry: { kind: "fact", itemId: 1, factKind: "owner", value: long(501, "😀") },
      },
    ],
    ["a blank item name", { action: "add", entry: { kind: "item", type: "Concept", name: " " } }],
    [
      "an item id of zero",
      { action: "add", entry: { kind: "fact", itemId: 0, factKind: "owner", value: "x" } },
    ],
    [
      "a fractional end",
      { action: "add", entry: { kind: "relation", subjectId: 1, type: "T", objectId: 1.5 } },
    ],
    [
      "an extra key",
      {
        action: "add",
        entry: { kind: "fact", itemId: 1, factKind: "owner", value: "x", status: "candidate" },
      },
    ],
    [
      "a status of the row",
      { action: "add", entry: { kind: "item", type: "T", name: "n", status: "candidate" } },
    ],
    [
      "a kind that is not a row",
      { action: "add", entry: { kind: "ontology", type: "T", name: "n" } },
    ],
    ["a fix without an id", { action: "replace", value: "x" }],
    ["a fix with an id of zero", { action: "replace", id: 0, value: "x" }],
    ["a fix with a blank value", { action: "replace", id: 1, value: "" }],
  ];
  it.each(bad)(
    "answers 400 to %s, with no text of the request, and changes nothing",
    async (_name, correction) => {
      world();
      await start();
      const before = counts();
      const res = await call(
        "semanticCorrect",
        correction === undefined ? undefined : { correction },
      );
      expect(res).toEqual({ status: 400, body: { error: "bad-request" } });
      expect(counts()).toEqual(before);
      expect((await call("semanticCorrect", { correction, extra: 1 })).status).toBe(400);
    },
  );

  it("takes a value of exactly 500 code points, emoji included, and stores it whole", async () => {
    const w = world();
    await start();
    for (const unit of ["가", "😀"]) {
      const res = parse(await addFact(w.item, long(500, unit), "definition"));
      expect(res.status).toBe("applied");
      expect(
        db.all("SELECT length(value) AS n FROM facts WHERE id = ?", [res.entry?.id as number]),
      ).toEqual([{ n: 500 }]);
    }
  });

  it("holds a date kind to a real date, for an add and for a fix, and any other kind to text", async () => {
    const w = world();
    await start();
    const before = counts();
    for (const kind of ["target_date", "completion_date"]) {
      for (const value of ["tomorrow", "2026-02-30", "2026-1-5", "2026-12-24T00:00"]) {
        expect([kind, value, (await addFact(w.item, value, kind)).status]).toEqual([
          kind,
          value,
          400,
        ]);
      }
    }
    expect((await fixFact(w.fact, "not a date")).status).toBe(400);
    expect(counts()).toEqual(before);
    expect((await addFact(w.item, "not a date", "owner")).status).toBe(200);
    expect(parse(await addFact(w.item, "2026-02-28", "completion_date")).status).toBe("applied");
  });

  it("answers not-found, as for an item that does not exist, when the item, a relation end or the fact is hidden", async () => {
    const open = world("open");
    const hidden = world("hidden", SECRET);
    const policy: ScopePolicy = {
      ...defaultScopePolicy,
      allows: (scopes) => !scopes.some((s) => s?.includes("secret")),
    };
    await start({
      registry: createDerivativeRegistry({
        kinds: createProductRegistry({ policy: defaultScopePolicy }).kinds,
        policy,
      }),
    });
    const NOT_FOUND = { status: 404, body: { error: "not-found" } };
    const before = counts();
    expect(await addFact(hidden.item, "2026-12-24")).toEqual(NOT_FOUND);
    expect(await addFact(99_999, "2026-12-24")).toEqual(NOT_FOUND);
    for (const [subjectId, objectId] of [
      [hidden.item, open.item],
      [open.item, hidden.item],
      [open.item, 99_999],
    ] as const) {
      expect(
        await correct({
          action: "add",
          entry: { kind: "relation", subjectId, type: "T", objectId },
        }),
      ).toEqual(NOT_FOUND);
    }
    expect(await fixFact(hidden.fact, "2026-12-24")).toEqual(NOT_FOUND);
    expect(await fixFact(99_999, "2026-12-24")).toEqual(NOT_FOUND);
    // not-found comes before the shape check: a bad date for a hidden fact is not a 400
    expect(await fixFact(hidden.fact, "not a date")).toEqual(NOT_FOUND);
    expect(counts()).toEqual(before);
    // the open row is reachable
    expect((await addFact(open.item, "2026-12-24")).status).toBe(200);
  });

  // an item shown over a hidden fact: the value that fact holds is not told by value-exists
  it("answers not-found, not value-exists, for a value only a hidden row of the item has", async () => {
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
    const before = counts();
    expect(await addFact(open.item, "합성", "owner")).toEqual({
      status: 404,
      body: { error: "not-found" },
    });
    const other = parse(await addFact(open.item, "다른 값", "owner"));
    expect(await fixFact(other.entry?.id as number, "합성")).toEqual({
      status: 404,
      body: { error: "not-found" },
    });
    expect(counts()).toEqual({
      ...before,
      facts: (before.facts as number) + 1,
      lines: (before.lines as number) + 1,
    });
    // the shown row's value is told as before
    expect((await addFact(open.item, VALUE)).body).toMatchObject({ reason: "value-exists" });
  });

  it("carries no fixture text in a refusal, a not-found or a validation error, and writes no text into a history line", async () => {
    const w = world();
    await start();
    const refused = await addFact(w.item, VALUE);
    const missing = await addFact(99_999, "x");
    const invalid = await correct({ action: "replace", id: w.fact, value: "" });
    const fixed = await fixFact(w.fact, "2026-12-21");
    for (const res of [refused, missing, invalid, fixed]) expect(leaks(res.body)).toEqual([]);
    const history = JSON.stringify(db.all("SELECT * FROM fact_history WHERE actor = 'user'"));
    expect(history).not.toContain("2026-12-21");
    expect(history).not.toContain(VALUE);
  });
});
