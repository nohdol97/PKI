// S01-T07 `semantic.api` (type routes, S01-R23, R22): the type definitions' list, check, change,
// decide, undo and history over HTTP. A request passes the token, Host and Origin checks and a strict
// body schema (a name that is not a string is a 400, not a driver error); an id that is absent,
// deleted or hidden by the read gate answers the same `not-found` and changes nothing; a refusal is a
// code with counts in a 200 body and carries no name, rule or text of a source. All data is synthetic.
import { routes, type RouteName } from "@pki/contracts";
import { createProductRegistry } from "@pki/knowledge-engine";
import {
  applyOntologyChange,
  createDerivativeRegistry,
  defaultScopePolicy,
  insertItem,
  readKnowledgeRevision,
  registerConnectorInstance,
  saveFact,
  saveSourceRecord,
  userDecisions,
  type DerivativeRegistry,
  type ElementRule,
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
const SECRET = ["secret"];
const NAME = "QzSourceTerm";
const TYPE: ElementRule = { elementKind: "item-type" };
const noteKind = (itemTypes = ["Project"]): ElementRule => ({
  elementKind: "fact-kind",
  itemTypes,
  valueType: "text",
  cardinality: "many",
});

let dir: string;
let db: SqlDriver;
let server: RunningServer | undefined;
let valid: Record<string, string>;
let versions = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-ontology-api-"));
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

function sourceVersion(accessScope: string[] | null = null) {
  const saved = saveSourceRecord(db, "c", {
    externalId: `doc-${versions++}`,
    title: "t",
    body: "본문",
    accessScope,
  });
  if (saved.status !== "created") throw new Error(saved.status);
  return { sourceId: saved.sourceId, version: saved.version };
}
/** A candidate an extraction proposed from a source (in `accessScope` when given). */
function candidate(name: string, rule: ElementRule = TYPE, accessScope: string[] | null = null) {
  const out = applyOntologyChange(
    db,
    { op: "add", name, rule },
    "extraction",
    sourceVersion(accessScope),
  );
  if (out.status !== "candidate") throw new Error(JSON.stringify(out));
  return out.id;
}
const dump = () => ({
  elements: db.all("SELECT * FROM ontology_elements ORDER BY id"),
  history: db.all("SELECT * FROM ontology_history ORDER BY element_id, seq"),
  basis: db.all("SELECT * FROM ontology_basis ORDER BY element_id"),
  revision: readKnowledgeRevision(db),
});
const list = async () => routes.ontology.response.parse((await call("ontology")).body).elements;
const history = async (id: number) =>
  routes.ontologyHistory.response.parse((await call("ontologyHistory", { id })).body).lines;
const NOT_FOUND = { status: 404, body: { error: "not-found" } };

describe("GET /api/ontology", () => {
  it("lists the seed, verified, with each rule", async () => {
    await start();
    const elements = await list();
    expect(elements).toHaveLength(48);
    expect(elements.every((e) => e.status === "verified" && e.origin === "seed")).toBe(true);
    expect(elements.find((e) => e.name === "DEPENDS_ON")).toMatchObject({
      elementKind: "relation-type",
      rule: {
        elementKind: "relation-type",
        subjectTypes: ["Commitment", "Project", "System", "Task"],
        objectTypes: ["Commitment", "Dependency", "Project", "System", "Task"],
        symmetric: false,
      },
    });
  });

  it("shows a candidate while its source is shown, and leaves it out, with its approval and history, once the policy hides the source; an approved one needs no source", async () => {
    const open = candidate("OpenTerm");
    const hidden = candidate(NAME, TYPE, SECRET);
    const approvedThenHidden = candidate("KeptTerm", TYPE, SECRET);
    userDecisions.ontology.decide(db, approvedThenHidden, "approve");
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
    const ids = (await list()).map((e) => e.id);
    expect(ids).toContain(open);
    expect(ids).toContain(approvedThenHidden); // verified: no lineage
    expect(ids).not.toContain(hidden);
    const before = dump();
    for (const res of [
      await call("ontologyDecide", { id: hidden, action: "approve" }),
      await call("ontologyDecide", { id: hidden, action: "reject" }),
      await call("ontologyUndo", { id: hidden }),
      await call("ontologyHistory", { id: hidden }),
    ]) {
      expect(res).toEqual(NOT_FOUND);
    }
    expect(dump()).toEqual(before);
    expect((await call("ontologyDecide", { id: open, action: "approve" })).status).toBe(200);
  });
});

describe("POST /api/ontology/check", () => {
  it("answers the three checks as counts and codes, and changes nothing", async () => {
    candidate(NAME);
    await start();
    const before = dump();
    const dup = await call("ontologyCheck", { op: "add", name: NAME.toLowerCase(), rule: TYPE });
    expect(routes.ontologyCheck.response.parse(dup.body)).toEqual({
      duplicates: 1,
      schemaErrors: [],
      impact: { liveRows: 0, violations: 0 },
      applicable: false,
    });
    expect(JSON.stringify(dup.body)).not.toContain("Qz");
    const bad = await call("ontologyCheck", {
      op: "add",
      name: "k",
      rule: noteKind(["Nothing"]),
    });
    expect(routes.ontologyCheck.response.parse(bad.body)).toMatchObject({
      schemaErrors: ["item-type-unknown"],
      applicable: false,
    });
    const ok = await call("ontologyCheck", { op: "add", name: "fine", rule: noteKind() });
    expect(routes.ontologyCheck.response.parse(ok.body)).toMatchObject({ applicable: true });
    const retire = await call("ontologyCheck", {
      op: "retire",
      elementKind: "item-type",
      name: "Project",
    });
    expect(routes.ontologyCheck.response.parse(retire.body)).toMatchObject({
      applicable: false,
      impact: { liveRows: 0, violations: 10 },
    });
    expect(dump()).toEqual(before);
  });
});

describe("POST /api/ontology/change", () => {
  it("applies the user's add, rule change and retirement, and writes a history line for each", async () => {
    await start();
    const add = await call("ontologyChange", { op: "add", name: "note_kind", rule: noteKind() });
    const id = routes.ontologyChange.response.parse(add.body);
    expect(id).toMatchObject({ status: "applied", edition: 1, seq: 1 });
    const widened = await call("ontologyChange", {
      op: "change-rule",
      elementKind: "fact-kind",
      name: "note_kind",
      rule: noteKind(["Project", "System"]),
    });
    expect(widened.body).toMatchObject({ status: "applied", edition: 2, seq: 2 });
    const retired = await call("ontologyChange", {
      op: "retire",
      elementKind: "fact-kind",
      name: "note_kind",
    });
    expect(retired.body).toMatchObject({ status: "applied", edition: 3, seq: 3 });
    const elementId = (id as { id: number }).id;
    expect((await history(elementId)).map((l) => [l.action, l.fromEdition, l.toEdition])).toEqual([
      ["created", null, 1],
      ["change-rule", 1, 2],
      ["retire", 2, 3],
    ]);
    // the retirement is undone as a new edition
    expect((await call("ontologyUndo", { id: elementId })).body).toMatchObject({
      status: "applied",
      edition: 4,
    });
  });

  it("refuses with a code and counts only: duplicate, schema-invalid, existing-data-violation, not-found", async () => {
    candidate(NAME);
    insertItem(db, {
      type: "Project",
      name: "P1",
      epistemic: "explicit",
      status: "candidate",
      validAt: null,
      observedAt: "2026-11-23T00:00:00Z",
    });
    await start();
    const before = dump();
    const cases: [unknown, unknown][] = [
      [
        { op: "add", name: NAME.toLowerCase(), rule: TYPE },
        { status: "refused", reason: "duplicate", duplicates: 1 },
      ],
      [
        { op: "add", name: "1bad name", rule: TYPE },
        { status: "refused", reason: "schema-invalid", schemaErrors: ["name-not-identifier"] },
      ],
      [
        { op: "retire", elementKind: "item-type", name: "Project" },
        {
          status: "refused",
          reason: "existing-data-violation",
          impact: { liveRows: 1, violations: 11 },
        },
      ],
      [
        { op: "retire", elementKind: "fact-kind", name: "nope" },
        { status: "refused", reason: "not-found" },
      ],
    ];
    for (const [body, expected] of cases) {
      const res = await call("ontologyChange", body);
      expect(res.status).toBe(200);
      expect(routes.ontologyChange.response.parse(res.body)).toMatchObject(expected as object);
      expect(JSON.stringify(res.body)).not.toMatch(/Qz|bad name|nope/);
    }
    expect(dump()).toEqual(before);
  });
});

describe("POST /api/ontology/decide, /undo and /history", () => {
  it("approves a candidate, shows its history without a name, undoes it to the lineage that is left, and answers a repeat unchanged", async () => {
    const id = candidate(NAME);
    await start();
    const body = { id, action: "approve" };
    expect(routes.ontologyDecide.response.parse((await call("ontologyDecide", body)).body)).toEqual(
      { status: "applied", id, edition: 1, seq: 2 },
    );
    expect((await call("ontologyDecide", body)).body).toEqual({ status: "unchanged", id });
    const lines = await history(id);
    expect(lines.map((l) => [l.seq, l.actor, l.action])).toEqual([
      [1, "extraction", "created"],
      [2, "user", "approve"],
    ]);
    expect(JSON.stringify(lines)).not.toContain("Qz");
    expect((await call("ontologyUndo", { id })).body).toEqual({
      status: "applied",
      id,
      edition: 1,
      seq: 3,
    });
    expect((await list()).find((e) => e.id === id)?.status).toBe("candidate");
    expect((await call("ontologyUndo", { id })).body).toMatchObject({
      status: "refused",
      reason: "nothing-to-undo",
    });
  });

  it("rejects, and refuses what the table does not list as a code, writing nothing", async () => {
    const id = candidate(NAME);
    const approved = candidate("Approved");
    const fresh = candidate("Fresh");
    await start();
    await call("ontologyDecide", { id: approved, action: "approve" });
    expect((await call("ontologyDecide", { id, action: "reject" })).body).toMatchObject({
      status: "applied",
    });
    const before = dump();
    for (const [target, action] of [
      [id, "dispute"],
      [id, "approve"],
      [approved, "dispute"],
      [approved, "reject"],
    ] as const) {
      expect((await call("ontologyDecide", { id: target, action })).body).toMatchObject({
        status: "refused",
        reason: "invalid-transition",
        duplicates: 0,
        schemaErrors: [],
        impact: { liveRows: 0, violations: 0 },
      });
    }
    // the creation line is the extraction's: it is not undone
    expect((await call("ontologyUndo", { id: fresh })).body).toMatchObject({
      reason: "not-latest",
    });
    expect(dump()).toEqual(before);
  });

  it("refuses to undo an approval that live rows use, with counts only, and removes an approval that has no lineage left", async () => {
    const used = candidate("note_kind", noteKind());
    const bare = candidate("Bare");
    await start();
    await call("ontologyDecide", { id: used, action: "approve" });
    await call("ontologyDecide", { id: bare, action: "approve" });
    const p = insertItem(db, {
      type: "Project",
      name: "P1",
      epistemic: "explicit",
      status: "candidate",
      validAt: null,
      observedAt: "2026-11-23T00:00:00Z",
    });
    saveFact(db, {
      itemId: p,
      kind: "note_kind",
      value: "v",
      epistemic: "explicit",
      status: "candidate",
      validAt: null,
      observedAt: "2026-11-23T00:00:00Z",
    });
    const before = dump();
    const refused = await call("ontologyUndo", { id: used });
    expect(routes.ontologyUndo.response.parse(refused.body)).toEqual({
      status: "refused",
      reason: "existing-data-violation",
      duplicates: 0,
      schemaErrors: [],
      impact: { liveRows: 1, violations: 1 },
    });
    expect(JSON.stringify(refused.body)).not.toContain("note_kind");
    expect(dump()).toEqual(before);
    db.run("DELETE FROM ontology_basis WHERE element_id = ?", [bare]); // its source was deleted
    expect((await call("ontologyUndo", { id: bare })).body).toEqual({
      status: "removed",
      id: bare,
    });
    expect((await list()).some((e) => e.id === bare)).toBe(false);
    expect(await call("ontologyHistory", { id: bare })).toEqual(NOT_FOUND);
  });

  it("answers not-found to every id route for an id that is not stored, and to the routes without a user entry", async () => {
    await start();
    for (const res of [
      await call("ontologyDecide", { id: 99_999, action: "approve" }),
      await call("ontologyUndo", { id: 99_999 }),
      await call("ontologyHistory", { id: 99_999 }),
    ]) {
      expect(res).toEqual(NOT_FOUND);
    }
    await server?.close();
    const id = candidate(NAME);
    await start({ decisions: false });
    const before = dump();
    expect(await call("ontologyDecide", { id, action: "approve" })).toEqual(NOT_FOUND);
    expect(await call("ontologyUndo", { id })).toEqual(NOT_FOUND);
    expect(await call("ontologyChange", { op: "add", name: "x", rule: TYPE })).toEqual(NOT_FOUND);
    expect(dump()).toEqual(before);
    expect((await call("ontology")).status).toBe(200);
  });
});

describe("a user's add under a kind that is not verified (review D2)", () => {
  const dateKind: ElementRule = {
    elementKind: "fact-kind",
    itemTypes: ["Project"],
    valueType: "date",
    cardinality: "many",
  };
  const add = (itemId: number, factKind: string, value: string) =>
    call("semanticCorrect", {
      correction: { action: "add", entry: { kind: "fact", itemId, factKind, value } },
    });

  it.each(["retired", "candidate"] as const)(
    "lets the value pass under a %s date kind: it is unregistered, not misfit",
    async (how) => {
      const itemId = insertItem(db, {
        type: "Project",
        name: "P1",
        epistemic: "explicit",
        status: "candidate",
        validAt: null,
        observedAt: "2026-11-23T00:00:00Z",
      });
      if (how === "candidate") candidate("cand_date", dateKind);
      else {
        userDecisions.ontology.change(db, { op: "add", name: "cand_date", rule: dateKind });
        userDecisions.ontology.change(db, {
          op: "retire",
          elementKind: "fact-kind",
          name: "cand_date",
        });
      }
      await start();
      expect((await add(itemId, "cand_date", "soon")).body).toMatchObject({ status: "applied" });
    },
  );
});

describe("validation and the request checks", () => {
  const rule = noteKind();
  const bad: [string, unknown][] = [
    ["a name that is not a string", { op: "add", name: 5, rule: TYPE }],
    ["a null name", { op: "add", name: null, rule: TYPE }],
    ["a name that is an object", { op: "retire", elementKind: "item-type", name: {} }],
    ["an unknown op", { op: "delete", name: "x" }],
    [
      "an add that names an element kind",
      { op: "add", name: "x", rule: TYPE, elementKind: "item-type" },
    ],
    ["a rule change without a kind", { op: "change-rule", name: "x", rule }],
    ["a rule change without a rule", { op: "change-rule", name: "x", elementKind: "fact-kind" }],
    ["a retirement without a kind", { op: "retire", name: "x" }],
    [
      "a retirement that carries a rule",
      { op: "retire", name: "x", elementKind: "fact-kind", rule },
    ],
    ["a missing rule", { op: "add", name: "x" }],
    ["an extra key", { op: "add", name: "x", rule: TYPE, status: "verified" }],
    ["an extra key in a rule", { op: "add", name: "x", rule: { ...rule, extra: 1 } }],
    ["a rule list with a number", { op: "add", name: "x", rule: { ...rule, itemTypes: [5] } }],
    ["a rule with a missing key", { op: "add", name: "x", rule: { elementKind: "fact-kind" } }],
    ["an unknown value kind", { op: "add", name: "x", rule: { ...rule, valueType: "number" } }],
    ["an unknown element kind", { op: "retire", elementKind: "other", name: "x" }],
    ["a name over 200 characters", { op: "add", name: "x".repeat(201), rule: TYPE }],
    [
      "a rule type name over 200 characters",
      { op: "add", name: "x", rule: noteKind(["T".repeat(201)]) },
    ],
    ["no body", undefined],
  ];
  it.each(bad)("answers 400 to %s on check and change, and changes nothing", async (_n, body) => {
    await start();
    const before = dump();
    expect((await call("ontologyCheck", body)).status).toBe(400);
    expect((await call("ontologyChange", body)).status).toBe(400);
    expect(dump()).toEqual(before);
  });

  it.each([
    ["an id of zero", { id: 0, action: "approve" }],
    ["a fractional id", { id: 1.5, action: "approve" }],
    ["a string id", { id: "1", action: "approve" }],
    ["an unknown action", { id: 1, action: "delete" }],
    ["a missing id", { action: "approve" }],
    ["an extra key", { id: 1, action: "approve", status: "verified" }],
    ["no body", undefined],
  ])("answers 400 to %s on decide", async (_n, body) => {
    await start();
    const before = dump();
    expect((await call("ontologyDecide", body)).status).toBe(400);
    expect(dump()).toEqual(before);
  });

  it.each([
    ["an id of zero", { id: 0 }],
    ["a fractional id", { id: 1.5 }],
    ["a string id", { id: "1" }],
    ["a missing id", {}],
    ["an extra key", { id: 1, action: "approve" }],
    ["no body", undefined],
  ])("answers 400 to %s on undo and history", async (_n, body) => {
    await start();
    const before = dump();
    expect((await call("ontologyUndo", body)).status).toBe(400);
    expect((await call("ontologyHistory", body)).status).toBe(400);
    expect(dump()).toEqual(before);
  });

  it("refuses a request without the token, with a wrong Host or a foreign Origin, on every ontology route, and changes nothing", async () => {
    const id = candidate(NAME);
    await start();
    const before = dump();
    const bodies: Record<string, unknown> = {
      ontology: undefined,
      ontologyCheck: { op: "add", name: "x", rule: TYPE },
      ontologyChange: { op: "add", name: "x", rule: TYPE },
      ontologyDecide: { id, action: "approve" },
      ontologyUndo: { id },
      ontologyHistory: { id },
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
    expect(dump()).toEqual(before);
    const ok = await call("ontologyDecide", bodies.ontologyDecide, { ...valid, origin: ORIGIN });
    expect(ok.status).toBe(200);
  });

  it("does not answer a read route with POST or an action route with GET", async () => {
    await start();
    const port = (server as RunningServer).port;
    expect((await send(port, "/api/ontology/decide", valid, "GET")).status).toBe(405);
    expect((await send(port, "/api/ontology", valid, "POST", {})).status).toBe(405);
  });
});
