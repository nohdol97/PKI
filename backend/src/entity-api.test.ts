// S02-T04 `resolution.merge-unmerge` over HTTP (S02-R11, R12, R16, R25): the user's merge, unmerge and distinct mark
// (`POST /api/entities/merge`, `/unmerge`, `/distinct`) and the refusal of a direct add's undo while a merge line
// hangs on the item. A refusal is a code in a 200 body; an item that is absent, deleted or hidden (or whose group's top
// is) answers the one 404 `not-found`; no name, value or quote is in any answer. All data is synthetic.
import { routes, type RouteName } from "@pki/contracts";
import {
  createProductRegistry,
  recomputeDependencyDelay,
  refreshCandidates,
} from "@pki/knowledge-engine";
import {
  addEvidence,
  automatedLifecycle,
  createDerivativeRegistry,
  createUserDecisions,
  defaultScopePolicy,
  insertItem,
  registerConnectorInstance,
  saveFact,
  saveRelation,
  saveSourceRecord,
  userDecisions,
  type DerivativeRegistry,
  type ScopePolicy,
  type SqlDriver,
  type UserDecisions,
} from "@pki/storage";
import { EmptyVectorIndex } from "@pki/storage/adapters";
import { send } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openCanonicalDb,
  productAdapters,
  productEgress,
  productEngine,
  productRegistry,
  productUserDecisions,
} from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import { startServer, type RunningServer } from "./server.ts";

const TOKEN = "s".repeat(43);
const ORIGIN = "http://localhost:5173";
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };
const NAME = "은하수 프로젝트";

let dir: string;
let db: SqlDriver;
let server: RunningServer | undefined;
let valid: Record<string, string>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-entity-api-"));
  db = openCanonicalDb(dir);
  registerConnectorInstance(db, "c", "test-fixtures");
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function start(
  options: { registry?: DerivativeRegistry; decisions?: UserDecisions | false } = {},
) {
  server = await startServer({
    token: TOKEN,
    allowedOrigins: [ORIGIN],
    connectors,
    db,
    dataDirectory: dir,
    egress: productEgress(db),
    ...productAdapters(dir),
    ...(options.decisions === false ? {} : { decisions: options.decisions ?? userDecisions }),
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
const NOT_FOUND = { status: 404, body: { error: "not-found" } };

/** An item a source built, with its fact: the item's lineage is that source's, whose scope the policy reads. */
function itemFrom(externalId: string, accessScope: string[] | null = null, type = "Project") {
  const saved = saveSourceRecord(db, "c", {
    externalId,
    title: `제목 ${externalId}`,
    body: `${NAME}의 목표일은 2026-12-05`,
    accessScope,
  });
  if (saved.status !== "created") throw new Error(saved.status);
  const versionId = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
  const item = insertItem(db, { type, name: `${NAME} ${externalId}`, ...attrs });
  const fact = saveFact(db, {
    itemId: item,
    kind: "target_date",
    value: "2026-12-05",
    ...attrs,
  }).id;
  automatedLifecycle.created(db, { kind: "item", id: item }, "extraction", {
    sourceId: saved.sourceId,
    version: saved.version,
  });
  addEvidence(db, {
    target: { factId: fact },
    sourceVersionId: versionId,
    start: 0,
    end: [...NAME].length,
    quote: NAME,
  });
  return item;
}
function userItem(name: string): number {
  const added = userDecisions.add(db, { kind: "item", type: "Project", name });
  if (added.status !== "applied") throw new Error("the user's item");
  return added.ref.id;
}
const rows = () => ({
  items: db.all("SELECT * FROM items ORDER BY id"),
  facts: db.all("SELECT * FROM facts ORDER BY id"),
  evidence: db.all("SELECT * FROM evidence ORDER BY id"),
});
const mergeLines = () =>
  db.all("SELECT member_id, representative_id, active FROM item_merges ORDER BY id");

describe("POST /api/entities/merge, /unmerge, /distinct (S02-R25)", () => {
  it("merges, answers the line's number, and an unmerge by that number puts the rows back; the answers match the contract and hold no text", async () => {
    const a = itemFrom("a");
    const b = itemFrom("b");
    const before = rows();
    await start();
    const merged = await call("entityMerge", { member: a, into: b });
    expect(merged.status).toBe(200);
    const body = routes.entityMerge.response.parse(merged.body);
    expect(body).toEqual({ status: "applied", mergeId: expect.any(Number) });
    expect(mergeLines()).toEqual([{ member_id: a, representative_id: b, active: 1 }]);
    expect(rows()).toEqual(before);
    const undone = await call("entityUnmerge", { mergeId: body.mergeId });
    expect(routes.entityUnmerge.response.parse(undone.body)).toEqual({ status: "applied" });
    expect(mergeLines()).toEqual([]);
    expect(rows()).toEqual(before);
    // the default of an unmerge is to leave the distinct mark
    expect(db.all("SELECT item_a, item_b FROM item_distinct")).toEqual([{ item_a: a, item_b: b }]);
    for (const res of [merged, undone]) expect(JSON.stringify(res.body)).not.toContain(NAME);
  });

  it("leaves no mark when the user asks, and clears or sets a mark by the distinct route", async () => {
    const [a, b, c] = [itemFrom("a"), itemFrom("b"), itemFrom("c")] as const;
    await start();
    const merged = routes.entityMerge.response.parse(
      (await call("entityMerge", { member: a, into: b })).body,
    );
    await call("entityUnmerge", { mergeId: merged.mergeId, keepDistinct: false });
    expect(db.all("SELECT 1 FROM item_distinct")).toEqual([]);
    expect((await call("entityDistinct", { a: c, b: a, on: true })).body).toEqual({
      status: "applied",
    });
    expect((await call("entityDistinct", { a: a, b: c, on: true })).body).toEqual({
      status: "unchanged",
    });
    expect(db.all("SELECT item_a, item_b FROM item_distinct")).toEqual([{ item_a: a, item_b: c }]);
    // a merge of the pair clears the mark
    await call("entityMerge", { member: a, into: c });
    expect(db.all("SELECT 1 FROM item_distinct")).toEqual([]);
    expect((await call("entityDistinct", { a: a, b: c, on: false })).body).toEqual({
      status: "unchanged",
    });
  });

  it("answers a refusal as a code in a 200 body and writes nothing: type-mismatch, already-merged", async () => {
    const person = itemFrom("p", null, "Person");
    const project = itemFrom("q");
    const other = itemFrom("r");
    await start();
    const before = rows();
    const mismatch = await call("entityMerge", { member: person, into: project });
    expect(mismatch).toEqual({ status: 200, body: { status: "refused", reason: "type-mismatch" } });
    await call("entityMerge", { member: project, into: other });
    const lines = mergeLines();
    const twice = await call("entityMerge", { member: other, into: project });
    expect(twice).toEqual({ status: 200, body: { status: "refused", reason: "already-merged" } });
    expect((await call("entityMerge", { member: project, into: project })).body).toEqual({
      status: "refused",
      reason: "already-merged",
    });
    expect(mergeLines()).toEqual(lines);
    expect(rows()).toEqual(before);
    for (const res of [mismatch, twice]) routes.entityMerge.response.parse(res.body);
  });

  it("refuses scope-refused when the composition's policy will not put the two lineages together", async () => {
    const open = itemFrom("open");
    const secret = itemFrom("secret", ["secret"]);
    const apart: ScopePolicy = {
      ...defaultScopePolicy,
      combinable: (scopes) => !(scopes.length > 1 && scopes.some((s) => s?.includes("secret"))),
    };
    const registry = createDerivativeRegistry({
      kinds: createProductRegistry({ policy: defaultScopePolicy }).kinds,
      policy: apart,
    });
    await start({
      registry,
      decisions: createUserDecisions({
        combinable: (tx, lineage) => registry.combinable(tx, lineage),
        listeners: [],
      }),
    });
    const res = await call("entityMerge", { member: open, into: secret });
    expect(res).toEqual({ status: 200, body: { status: "refused", reason: "scope-refused" } });
    expect(mergeLines()).toEqual([]);
  });

  it("answers the one same not-found for an item that is not stored, one the policy hides, and a hidden top of a group", async () => {
    const open = itemFrom("open");
    const hidden = itemFrom("hidden", ["secret"]);
    const open2 = itemFrom("open2");
    // the group's line is made before the policy hides the top (the stored scope is what the read gate reads)
    db.run(
      "INSERT INTO item_merges (member_id, representative_id, active, at) VALUES (?, ?, 1, ?)",
      [open2, hidden, "2026-11-23T00:00:00Z"],
    );
    const registry = createDerivativeRegistry({
      kinds: createProductRegistry({ policy: defaultScopePolicy }).kinds,
      policy: {
        ...defaultScopePolicy,
        allows: (scopes) => !scopes.some((s) => s?.includes("secret")),
      },
    });
    await start({ registry });
    const before = { rows: rows(), lines: mergeLines() };
    for (const res of [
      await call("entityMerge", { member: open, into: 99_999 }),
      await call("entityMerge", { member: 99_999, into: open }),
      await call("entityMerge", { member: open, into: hidden }),
      await call("entityMerge", { member: hidden, into: open }),
      await call("entityMerge", { member: open, into: open2 }), // open2's top is hidden
      await call("entityUnmerge", { mergeId: 99_999 }),
      await call("entityUnmerge", { mergeId: 1 }), // the line of a hidden item
      await call("entityDistinct", { a: open, b: hidden, on: true }),
      await call("entityDistinct", { a: open, b: 99_999, on: true }),
    ]) {
      expect(res).toEqual(NOT_FOUND);
    }
    expect(rows()).toEqual(before.rows);
    expect(mergeLines()).toEqual(before.lines);
    expect(db.all("SELECT 1 FROM item_distinct")).toEqual([]);
  });

  it("answers not-found for every route when no user entry is bound, and 400 for a body the schema refuses", async () => {
    await start({ decisions: false });
    expect(await call("entityMerge", { member: 1, into: 2 })).toEqual(NOT_FOUND);
    expect(await call("entityUnmerge", { mergeId: 1 })).toEqual(NOT_FOUND);
    expect(await call("entityDistinct", { a: 1, b: 2, on: true })).toEqual(NOT_FOUND);
    await server?.close();
    await start();
    for (const [name, body] of [
      ["entityMerge", { member: 1 }],
      ["entityMerge", { member: 1, into: 2, extra: true }],
      ["entityMerge", { member: 0, into: 2 }],
      ["entityUnmerge", { mergeId: "1" }],
      ["entityDistinct", { a: 3, b: 3, on: true }],
      ["entityDistinct", { a: 1, b: 2 }],
    ] as const) {
      expect((await call(name, body)).status, `${name} ${JSON.stringify(body)}`).toBe(400);
    }
  });

  it("refuses unauthenticated calls", async () => {
    await start();
    for (const name of ["entityMerge", "entityUnmerge", "entityDistinct"] as const) {
      const res = await call(
        name,
        { member: 1, into: 2, mergeId: 1, a: 1, b: 2, on: true },
        {
          host: valid.host as string,
        },
      );
      expect(res.status, name).toBe(401);
    }
  });
});

describe("resolution.group-reads: the merge route recomputes the rule (S02-R13)", () => {
  it("a merge through the route makes the representative's Insight and the unmerge resolves it, in their own requests", async () => {
    const x = itemFrom("x"); // target date 2026-12-05
    const y = itemFrom("y");
    const member = itemFrom("m");
    db.run("UPDATE facts SET kind = 'completion_date', value = '2026-12-20' WHERE item_id = ?", [
      member,
    ]);
    const rel = saveRelation(db, { subjectId: x, type: "DEPENDS_ON", objectId: y, ...attrs }).id;
    addEvidence(db, {
      target: { relationId: rel },
      sourceVersionId: db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number,
      start: 0,
      end: [...NAME].length,
      quote: NAME,
    });
    const registry = productRegistry({
      engine: productEngine(),
      vectorIndex: new EmptyVectorIndex(),
    });
    await start({ registry, decisions: productUserDecisions(registry) });
    expect(db.all("SELECT 1 FROM insights")).toEqual([]);
    const merged = routes.entityMerge.response.parse(
      (await call("entityMerge", { member, into: y })).body,
    );
    if (merged.status !== "applied") throw new Error(merged.reason);
    expect(db.all("SELECT x_item_id, y_item_id, state FROM insights")).toEqual([
      { x_item_id: x, y_item_id: y, state: "active" },
    ]);
    await call("entityUnmerge", { mergeId: merged.mergeId });
    expect(db.all("SELECT x_item_id, y_item_id, state FROM insights")).toEqual([
      { x_item_id: x, y_item_id: y, state: "resolved" },
    ]);
  });
});

describe("the undo of a user-made item inside a merge chain (S02-R11, the review's watch item)", () => {
  it("refuses with existing-data-violation and the counts, changes nothing; after the unmerge and the mark's clearing the undo removes the item", async () => {
    const mine = userItem("내가 만든 항목");
    const other = userItem("내가 만든 둘째");
    await start();
    const merged = routes.entityMerge.response.parse(
      (await call("entityMerge", { member: mine, into: other })).body,
    );
    const before = {
      rows: rows(),
      lines: mergeLines(),
      history: db.all("SELECT * FROM item_history ORDER BY item_id, seq"),
    };
    const refused = await call("semanticUndo", { kind: "item", id: mine });
    expect(routes.semanticUndo.response.parse(refused.body)).toEqual({
      status: "refused",
      reason: "existing-data-violation",
      held: { facts: 0, relations: 0, merges: 1, distinct: 0, splitMoves: 0 },
    });
    expect(JSON.stringify(refused.body)).not.toContain("내가 만든");
    expect(mergeLines()).toEqual(before.lines);
    expect(rows()).toEqual(before.rows);
    expect(db.all("SELECT * FROM item_history ORDER BY item_id, seq")).toEqual(before.history);
    // the unmerge leaves a mark by default: that still hangs on the item
    await call("entityUnmerge", { mergeId: merged.mergeId });
    const marked = routes.semanticUndo.response.parse(
      (await call("semanticUndo", { kind: "item", id: mine })).body,
    );
    expect(marked).toMatchObject({ reason: "existing-data-violation", held: { distinct: 1 } });
    await call("entityDistinct", { a: mine, b: other, on: false });
    expect((await call("semanticUndo", { kind: "item", id: mine })).body).toEqual({
      status: "removed",
    });
    expect(db.all("SELECT 1 FROM items WHERE id = ?", [mine])).toEqual([]);
  });

  it("cancels an approval after a merge through the route, the merge line read past", async () => {
    const [a, b] = [itemFrom("a"), itemFrom("b")] as const;
    await start();
    await call("semanticDecide", { kind: "item", id: a, action: "approve" });
    await call("entityMerge", { member: a, into: b });
    const undone = await call("semanticUndo", { kind: "item", id: a });
    expect(routes.semanticUndo.response.parse(undone.body)).toMatchObject({
      status: "applied",
      entry: { kind: "item", id: a, status: "candidate" },
    });
    expect(mergeLines()).toHaveLength(1);
  });
});

describe("POST /api/entities/split (S02-R25, R15)", () => {
  const factOf = (owner: number, value: string) =>
    saveFact(db, { itemId: owner, kind: "target_date", value, ...attrs }).id;

  it("moves the chosen rows to a new item, answers its number, refuses by code, and the new item's undo is refused", async () => {
    const a = itemFrom("a");
    const f2 = factOf(a, "2026-12-06");
    await start();
    const done = await call("entitySplit", {
      itemId: a,
      rows: [{ kind: "fact", id: f2 }],
      name: " 분리 ",
    });
    const body = routes.entitySplit.response.parse(done.body);
    expect(body).toMatchObject({ status: "applied", created: expect.any(Number) });
    expect(db.all("SELECT item_id FROM facts WHERE id = ?", [f2])).toEqual([
      { item_id: body.created },
    ]);
    expect(
      db.all("SELECT name, user_authored FROM items WHERE id = ?", [body.created as number]),
    ).toEqual([{ name: "분리", user_authored: 1 }]);
    expect(db.all("SELECT 1 FROM item_split_moves")).toHaveLength(1);
    const undo = routes.semanticUndo.response.parse(
      (await call("semanticUndo", { kind: "item", id: body.created })).body,
    );
    expect(undo).toMatchObject({ reason: "existing-data-violation", held: { splitMoves: 1 } });
    // refusals: a code in a 200 body
    const rest = db.all("SELECT id FROM facts WHERE item_id = ?", [a]).map((r) => r.id as number);
    expect((await call("entitySplit", { itemId: a, rows: [], name: "n" })).body).toEqual({
      status: "refused",
      reason: "nothing-selected",
    });
    expect(
      (await call("entitySplit", { itemId: a, rows: [{ kind: "fact", id: f2 }], name: "n" })).body,
    ).toEqual({
      status: "refused",
      reason: "row-not-on-item",
    });
    expect(
      (
        await call("entitySplit", {
          itemId: a,
          rows: rest.map((id) => ({ kind: "fact", id })),
          name: "n",
        })
      ).body,
    ).toEqual({ status: "refused", reason: "nothing-left" });
    expect(JSON.stringify(done.body)).not.toContain(NAME);
  });

  it("answers not-found for an absent or hidden item and row-not-on-item for a hidden row; 400 for a bad body", async () => {
    const open = itemFrom("open");
    factOf(open, "2026-12-06");
    const hidden = itemFrom("hidden", ["secret"]);
    const hiddenFact = db.all("SELECT id FROM facts WHERE item_id = ?", [hidden])[0]?.id as number;
    const registry = createDerivativeRegistry({
      kinds: createProductRegistry({ policy: defaultScopePolicy }).kinds,
      policy: {
        ...defaultScopePolicy,
        allows: (scopes) => !scopes.some((s) => s?.includes("secret")),
      },
    });
    await start({ registry });
    const before = db.all("SELECT * FROM facts ORDER BY id");
    expect(
      await call("entitySplit", { itemId: 99_999, rows: [{ kind: "fact", id: 1 }], name: "n" }),
    ).toEqual(NOT_FOUND);
    expect(
      await call("entitySplit", {
        itemId: hidden,
        rows: [{ kind: "fact", id: hiddenFact }],
        name: "n",
      }),
    ).toEqual(NOT_FOUND);
    expect(
      (
        await call("entitySplit", {
          itemId: open,
          rows: [{ kind: "fact", id: hiddenFact }],
          name: "n",
        })
      ).body,
    ).toEqual({
      status: "refused",
      reason: "row-not-on-item",
    });
    expect(db.all("SELECT * FROM facts ORDER BY id")).toEqual(before);
    for (const body of [
      { itemId: open },
      { itemId: open, rows: [], name: "" },
      { itemId: open, rows: [{ kind: "item", id: 1 }], name: "n" },
    ]) {
      expect((await call("entitySplit", body)).status).toBe(400);
    }
  });

  /** Evidence for `target` quoting the NAME of a version row. */
  const cite = (target: { factId: number } | { relationId: number }, versionId: number) =>
    addEvidence(db, {
      target,
      sourceVersionId: versionId,
      start: 0,
      end: [...NAME].length,
      quote: NAME,
    });
  const versionOf = (externalId: string) =>
    db.all(
      `SELECT v.id FROM source_versions v JOIN sources s ON s.id = v.source_id
       WHERE s.external_id = ? ORDER BY v.id DESC`,
      [externalId],
    )[0]?.id as number;

  it("answers row-not-on-item and changes nothing for a fact of a hidden source on a visible item", async () => {
    const open = itemFrom("open");
    const secretFact = factOf(open, "2026-12-09");
    itemFrom("secret", ["secret"]);
    cite({ factId: secretFact }, versionOf("secret"));
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
    // the item is shown (its lineage has two scopes) while the fact rests on the secret source alone
    expect((await call("semanticHistory", { kind: "item", id: open })).status).toBe(200);
    expect(await call("semanticHistory", { kind: "fact", id: secretFact })).toEqual(NOT_FOUND);
    const before = {
      facts: db.all("SELECT * FROM facts ORDER BY id"),
      items: db.all("SELECT id FROM items"),
    };
    const res = await call("entitySplit", {
      itemId: open,
      rows: [{ kind: "fact", id: secretFact }],
      name: "n",
    });
    expect(res).toEqual({ status: 200, body: { status: "refused", reason: "row-not-on-item" } });
    expect(db.all("SELECT * FROM facts ORDER BY id")).toEqual(before.facts);
    expect(db.all("SELECT id FROM items")).toEqual(before.items);
    expect(db.all("SELECT 1 FROM item_split_moves")).toEqual([]);
  });

  /** x (target 2026-12-05) depends on y, whose completion date is later: the Insight is active. Returns the relation. */
  function lateDependency() {
    const x = itemFrom("x"); // target date 2026-12-05
    const y = itemFrom("y");
    db.run("UPDATE facts SET kind = 'completion_date', value = '2026-12-20' WHERE item_id = ?", [
      y,
    ]);
    const rel = saveRelation(db, { subjectId: x, type: "DEPENDS_ON", objectId: y, ...attrs }).id;
    cite({ relationId: rel }, versionOf("x"));
    recomputeDependencyDelay(db, [x, y], { combinable: () => true });
    expect(db.all("SELECT state FROM insights")).toEqual([{ state: "active" }]);
    return { x, y, rel };
  }
  /** The composition's own pair: the registry and the user's entry built from the one receiver list. */
  const composed = () => {
    const registry = productRegistry({
      engine: productEngine(),
      vectorIndex: new EmptyVectorIndex(),
    });
    return { registry, decisions: productUserDecisions(registry) };
  };

  it("resolves a dependency-delay Insight that relied on a moved row, in the split's own request, through the membership receiver", async () => {
    const { x, rel } = lateDependency();
    await start(composed());
    // x keeps its target date; the relation goes to a new item, so x no longer depends on y
    const res = await call("entitySplit", {
      itemId: x,
      rows: [{ kind: "relation", id: rel }],
      name: "다른 것",
    });
    expect(routes.entitySplit.response.parse(res.body)).toMatchObject({ status: "applied" });
    expect(db.all("SELECT state FROM insights")).toEqual([{ state: "resolved" }]);
  });

  it("recomputes the rule once, through the receiver alone: an entry with no receiver leaves the Insight as it was (the route holds no call of its own)", async () => {
    const { x, rel } = lateDependency();
    await start(); // storage's listener-less entry
    const res = await call("entitySplit", {
      itemId: x,
      rows: [{ kind: "relation", id: rel }],
      name: "다른 것",
    });
    expect(routes.entitySplit.response.parse(res.body)).toMatchObject({ status: "applied" });
    expect(db.all("SELECT state FROM insights")).toEqual([{ state: "active" }]);
  });
});

describe("GET /api/entities/candidates (S02-R25) and the candidates' upkeep (S02-R10)", () => {
  /** Two items that share one email address (an identifier match), and the candidate row the extraction would leave. */
  function pair(
    externalIds: [string, string],
    accessScopes: [string[] | null, string[] | null] = [null, null],
    email = "shared@example.test",
  ) {
    const [a, b] = [
      itemFrom(externalIds[0], accessScopes[0]),
      itemFrom(externalIds[1], accessScopes[1]),
    ] as const;
    const emails = [a, b].map((item) => {
      const fact = saveFact(db, {
        itemId: item,
        kind: "identifier.email",
        value: email,
        ...attrs,
      }).id;
      const version = db.all(
        "SELECT e.source_version_id AS v FROM evidence e JOIN facts f ON f.id = e.fact_id WHERE f.item_id = ? LIMIT 1",
        [item],
      )[0]?.v as number;
      addEvidence(db, {
        target: { factId: fact },
        sourceVersionId: version,
        start: 0,
        end: 3,
        quote: NAME.slice(0, 3),
      });
      return fact;
    });
    db.transaction(() => refreshCandidates(db, [a, b], { combinable: () => true }));
    return { a, b, emails: emails as [number, number] };
  }
  const stored = () =>
    db.all("SELECT item_a, item_b FROM merge_candidates ORDER BY item_a, item_b");

  it("lists a row as two ids and signal codes; the answer matches the contract and holds no text", async () => {
    const { a, b } = pair(["a", "b"]);
    await start();
    const res = await call("entityCandidates");
    expect(res.status).toBe(200);
    expect(routes.entityCandidates.response.parse(res.body)).toEqual({
      candidates: [{ a, b, signals: ["same-type", "identifier-match"] }],
      truncated: false,
    });
    expect(JSON.stringify(res.body)).not.toContain(NAME);
  });

  it("leaves out a row with a hidden item and differs in nothing else", async () => {
    const open = pair(["a", "b"]);
    pair(["c", "secret"], [null, ["secret"]], "other@example.test");
    const registry = createDerivativeRegistry({
      kinds: createProductRegistry({ policy: defaultScopePolicy }).kinds,
      policy: {
        ...defaultScopePolicy,
        allows: (scopes) => !scopes.some((s) => s?.includes("secret")),
      },
    });
    expect(stored()).toHaveLength(2);
    await start({ registry });
    expect((await call("entityCandidates")).body).toEqual({
      candidates: [{ a: open.a, b: open.b, signals: ["same-type", "identifier-match"] }],
      truncated: false,
    });
  });

  it("accepting merges and clears the row; an unmerge without a mark brings it back; dismissing clears it and it does not come back", async () => {
    const { a, b } = pair(["a", "b"]);
    const registry = createProductRegistry({ policy: defaultScopePolicy });
    const derived = createDerivativeRegistry({ kinds: registry.kinds, policy: defaultScopePolicy });
    await start({ registry: derived, decisions: productUserDecisions(derived) });
    const merged = routes.entityMerge.response.parse(
      (await call("entityMerge", { member: a, into: b })).body,
    );
    expect(stored()).toEqual([]);
    await call("entityUnmerge", {
      mergeId: (merged as { mergeId: number }).mergeId,
      keepDistinct: false,
    });
    expect(stored()).toEqual([{ item_a: a, item_b: b }]);
    await call("entityDistinct", { a, b, on: true });
    expect(stored()).toEqual([]);
    db.transaction(() => refreshCandidates(db, [a, b], { combinable: () => true }));
    expect(stored()).toEqual([]);
  });

  it("rejecting the supporting fact removes the candidate in that request", async () => {
    const { emails } = pair(["a", "b"]);
    await start();
    expect(stored()).toHaveLength(1);
    const res = await call("semanticDecide", { kind: "fact", id: emails[0], action: "reject" });
    expect(res.status).toBe(200);
    expect(stored()).toEqual([]);
  });
});
