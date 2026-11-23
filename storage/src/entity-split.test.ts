// S02-T07 `resolution.split` (storage level; S02-R15): the split action, the record it writes and its read
// contract, the refusals, the state-neutral history lines, the membership notification, the refusal of the new
// item's undo while it carries rows, and the extraction hook's relation case. The extraction flow is
// knowledge-engine/src/split-reextract.test.ts. All data is synthetic.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import type { MembershipChange } from "./entity-groups.ts";
import {
  addEvidence,
  insertItem,
  saveFact,
  saveRelation,
  type KnowledgeAttributes,
} from "./knowledge.ts";
import { migrate } from "./migrations.ts";
import { automatedLifecycle } from "./semantic-lifecycle.ts";
import { createUserDecisions, userDecisions } from "./semantic-user.ts";
import { followMovedRow, listSplitMoves } from "./split-moves.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

const AT = "2026-11-23T01:02:03.000Z";
const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
};
let n = 0;
function item(type = "Project") {
  const id = insertItem(db, { type, name: `item-${++n}`, ...attrs });
  automatedLifecycle.created(db, { kind: "item", id }, "extraction", { sourceId: 1, version: 1 });
  return id;
}
const fact = (owner: number, value: string) =>
  saveFact(db, { itemId: owner, kind: "target_date", value, ...attrs }).id;
const relation = (s: number, o: number) =>
  saveRelation(db, { subjectId: s, type: "DEPENDS_ON", objectId: o, ...attrs }).id;
const split = (
  owner: number,
  rows: { kind: "fact" | "relation"; id: number }[],
  name = "새 항목",
) => db.transaction(() => userDecisions.entities.split(db, owner, rows, name, AT));
const snapshot = () => ({
  facts: db.all("SELECT * FROM facts ORDER BY id"),
  relations: db.all("SELECT * FROM relations ORDER BY id"),
  items: db.all("SELECT * FROM items ORDER BY id"),
  moves: db.all("SELECT * FROM item_split_moves"),
  marks: db.all("SELECT * FROM item_distinct"),
});

describe("resolution.split: the action (S02-R15)", () => {
  it("moves only the chosen rows' item numbers, makes a user-written item, records each row and leaves a distinct mark", () => {
    const [a, x] = [item(), item()] as [number, number];
    const f1 = fact(a, "2026-12-05");
    const f2 = fact(a, "2026-12-06");
    const r1 = relation(a, x);
    const r2 = relation(x, a);
    addEvidence(db, {
      target: { factId: f2 },
      sourceVersionId: saveV("s1"),
      start: 0,
      end: 4,
      quote: "body",
    });
    const rowBefore = db.all("SELECT * FROM facts WHERE id = ?", [f2])[0];
    const evidenceBefore = db.all("SELECT * FROM evidence ORDER BY id");

    const done = split(a, [
      { kind: "fact", id: f2 },
      { kind: "relation", id: r2 },
    ]);
    if (done.status !== "applied") throw new Error(done.reason);
    const created = done.created;
    expect(
      db.all("SELECT type, name, status, epistemic, user_authored FROM items WHERE id = ?", [
        created,
      ]),
    ).toEqual([
      {
        type: "Project",
        name: "새 항목",
        status: "verified",
        epistemic: "user-approved",
        user_authored: 1,
      },
    ]);
    // only the item numbers changed: the same ids, values, states and observed times
    expect(db.all("SELECT * FROM facts WHERE id = ?", [f2])[0]).toEqual({
      ...rowBefore,
      item_id: created,
    });
    expect(db.all("SELECT subject_id, object_id FROM relations WHERE id = ?", [r2])).toEqual([
      { subject_id: x, object_id: created },
    ]);
    expect(db.all("SELECT item_id FROM facts WHERE id = ?", [f1])).toEqual([{ item_id: a }]);
    expect(db.all("SELECT subject_id, object_id FROM relations WHERE id = ?", [r1])).toEqual([
      { subject_id: a, object_id: x },
    ]);
    expect(db.all("SELECT * FROM evidence ORDER BY id")).toEqual(evidenceBefore);
    expect(
      listSplitMoves(db).map((m) => [m.fromItemId, m.toItemId, m.factId, m.relationId]),
    ).toEqual([
      [a, created, f2, null],
      [a, created, null, r2],
    ]);
    expect(db.all("SELECT item_a, item_b, by FROM item_distinct")).toEqual([
      { item_a: Math.min(a, created), item_b: Math.max(a, created), by: "user" },
    ]);
    // a state-neutral `split` line on each item, no line on the rows
    for (const id of [a, created]) {
      expect(
        db
          .all("SELECT action, actor FROM item_history WHERE item_id = ? ORDER BY seq", [id])
          .at(-1),
      ).toEqual({
        action: "split",
        actor: "user",
      });
    }
    expect(db.all("SELECT 1 FROM fact_history WHERE action = 'split'")).toEqual([]);
  });

  it("may give the new item the original's own name (no key stops two items of one name)", () => {
    const a = item();
    fact(a, "2026-12-05");
    const f2 = fact(a, "2026-12-06");
    const name = db.all("SELECT name FROM items WHERE id = ?", [a])[0]?.name as string;
    expect(split(a, [{ kind: "fact", id: f2 }], name)).toMatchObject({ status: "applied" });
  });

  it("refuses by code and writes nothing: not-found, nothing-selected, row-not-on-item, nothing-left", () => {
    const [a, b] = [item(), item()] as [number, number];
    const fa = fact(a, "2026-12-05");
    const fa2 = fact(a, "2026-12-06");
    const fb = fact(b, "2026-12-05");
    const rel = relation(a, b);
    const before = snapshot();
    const refused = (rows: { kind: "fact" | "relation"; id: number }[], owner = a) => {
      const r = split(owner, rows);
      expect(snapshot()).toEqual(before);
      return r;
    };
    expect(refused([{ kind: "fact", id: fa }], 99_999)).toEqual({
      status: "refused",
      reason: "not-found",
    });
    expect(refused([])).toEqual({ status: "refused", reason: "nothing-selected" });
    expect(refused([{ kind: "fact", id: fb }])).toEqual({
      status: "refused",
      reason: "row-not-on-item",
    });
    expect(
      refused([
        { kind: "fact", id: fa },
        { kind: "fact", id: 99_999 },
      ]),
    ).toEqual({
      status: "refused",
      reason: "row-not-on-item",
    });
    expect(refused([{ kind: "relation", id: 99_999 }])).toEqual({
      status: "refused",
      reason: "row-not-on-item",
    });
    // every fact and relation of the item chosen: nothing would be left
    expect(
      refused([
        { kind: "fact", id: fa },
        { kind: "fact", id: fa2 },
        { kind: "relation", id: rel },
      ]),
    ).toEqual({ status: "refused", reason: "nothing-left" });
    // all but one is fine
    expect(
      split(a, [
        { kind: "fact", id: fa },
        { kind: "fact", id: fa2 },
      ]),
    ).toMatchObject({ status: "applied" });
  });

  it("tells the listeners once with both items and the moved rows, and a throw rolls the split back", () => {
    const seen: MembershipChange[] = [];
    const entry = createUserDecisions({
      combinable: () => true,
      listeners: [(_t, c) => seen.push(c)],
    });
    const a = item();
    fact(a, "2026-12-05");
    const f2 = fact(a, "2026-12-06");
    const done = db.transaction(() =>
      entry.entities.split(db, a, [{ kind: "fact", id: f2 }], "n", AT),
    );
    if (done.status !== "applied") throw new Error("split");
    expect(seen).toEqual([
      { items: [a, done.created].sort((p, q) => p - q), movedRows: [{ kind: "fact", id: f2 }] },
    ]);
    const throwing = createUserDecisions({
      combinable: () => true,
      listeners: [
        () => {
          throw new Error("the receiver refused");
        },
      ],
    });
    const b = item();
    fact(b, "2027-01-01");
    const g2 = fact(b, "2027-01-02");
    const before = snapshot();
    expect(() =>
      db.transaction(() => throwing.entities.split(db, b, [{ kind: "fact", id: g2 }], "m", AT)),
    ).toThrow(/receiver refused/);
    expect(snapshot()).toEqual(before);
  });

  it("refuses the undo of the new item's direct add while it carries the moved rows (and the record), changing nothing", () => {
    const a = item();
    fact(a, "2026-12-05");
    const f2 = fact(a, "2026-12-06");
    const done = split(a, [{ kind: "fact", id: f2 }]);
    if (done.status !== "applied") throw new Error("split");
    const before = snapshot();
    expect(userDecisions.undo(db, { kind: "item", id: done.created }, AT)).toEqual({
      status: "refused",
      reason: "existing-data-violation",
      held: { facts: 1, relations: 0, merges: 0, distinct: 1, splitMoves: 1 },
    });
    expect(snapshot()).toEqual(before);
  });

  it("is read past by the S01 undo of an approval made before the split", () => {
    const a = item();
    fact(a, "2026-12-05");
    const f2 = fact(a, "2026-12-06");
    userDecisions.decide(db, { kind: "item", id: a }, "approve", AT);
    split(a, [{ kind: "fact", id: f2 }]);
    expect(userDecisions.undo(db, { kind: "item", id: a }, AT)).toMatchObject({
      status: "applied",
    });
  });

  it("goes with its rows: deleting a moved row, or either item, deletes its record line (read contract)", () => {
    const a = item();
    fact(a, "2026-12-05");
    const f2 = fact(a, "2026-12-06");
    const f3 = fact(a, "2026-12-07");
    const done = split(a, [
      { kind: "fact", id: f2 },
      { kind: "fact", id: f3 },
    ]);
    if (done.status !== "applied") throw new Error("split");
    expect(listSplitMoves(db, { toItemId: done.created })).toHaveLength(2);
    expect(listSplitMoves(db, { factId: f3 })).toHaveLength(1);
    expect(listSplitMoves(db, { fromItemId: 99 })).toEqual([]);
    db.run("DELETE FROM facts WHERE id = ?", [f3]);
    expect(listSplitMoves(db).map((m) => m.factId)).toEqual([f2]);
  });
});

function saveV(externalId: string): number {
  const saved = saveSourceRecord(db, "c1", { externalId, title: "t", body: "body of it" });
  if (saved.status !== "created") throw new Error(saved.status);
  return db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
}

describe("resolution.split: the extraction hook for a moved relation (S02-R15)", () => {
  it("replaces a fresh relation on the original item by the moved row when the same source backs it, and not for another source", () => {
    const [a, x] = [item(), item()] as [number, number];
    fact(a, "2026-12-05");
    const rel = relation(a, x);
    const versionId = saveV("s1");
    const sourceId = db.all("SELECT source_id FROM source_versions WHERE id = ?", [versionId])[0]
      ?.source_id as number;
    addEvidence(db, {
      target: { relationId: rel },
      sourceVersionId: versionId,
      start: 0,
      end: 4,
      quote: "body",
    });
    const done = split(a, [{ kind: "relation", id: rel }]);
    if (done.status !== "applied") throw new Error("split");
    // extraction writes the same relation on the original item again
    const fresh = saveRelation(db, { subjectId: a, type: "DEPENDS_ON", objectId: x, ...attrs });
    expect(fresh.created).toBe(true);
    const other = saveV("s2");
    expect(other).toBeGreaterThan(versionId);
    expect(
      followMovedRow(db, { target: { relationId: fresh.id }, created: true }, sourceId + 99),
    ).toEqual({ target: { relationId: fresh.id }, created: true });
    expect(
      followMovedRow(db, { target: { relationId: fresh.id }, created: true }, sourceId),
    ).toEqual({
      target: { relationId: rel },
      created: false,
    });
    expect(db.all("SELECT 1 FROM relations WHERE id = ?", [fresh.id])).toEqual([]);
    // a row that already existed is left alone
    expect(followMovedRow(db, { target: { relationId: rel }, created: false }, sourceId)).toEqual({
      target: { relationId: rel },
      created: false,
    });
  });
});

describe("resolution.split: the hook covers every fact kind, identifiers and statements included (S02-T02 write paths)", () => {
  it("follows an identifier fact by its kind and value, whatever the context tag", () => {
    const a = item("Person");
    saveFact(db, { itemId: a, kind: "target_date", value: "2026-12-05", ...attrs });
    const email = saveFact(db, {
      itemId: a,
      kind: "identifier.email",
      value: "x@example.test",
      ...attrs,
    }).id;
    const versionId = saveV("s9");
    const sourceId = db.all("SELECT source_id FROM source_versions WHERE id = ?", [versionId])[0]
      ?.source_id as number;
    addEvidence(db, {
      target: { factId: email },
      sourceVersionId: versionId,
      start: 0,
      end: 4,
      quote: "body",
    });
    const done = split(a, [{ kind: "fact", id: email }]);
    if (done.status !== "applied") throw new Error("split");
    const fresh = saveFact(db, {
      itemId: a,
      kind: "identifier.email",
      value: "x@example.test",
      context: "tag",
      ...attrs,
    });
    expect(
      followMovedRow(db, { target: { factId: fresh.id }, created: fresh.created }, sourceId),
    ).toEqual({
      target: { factId: email },
      created: false,
    });
  });
});

describe("resolution.split: the moved relation row and the hook's reach (S02-R15)", () => {
  it("changes only the end of a moved relation: every other column, valid_at included, is as it was", () => {
    const [a, x] = [item(), item()] as [number, number];
    fact(a, "2026-12-05");
    const rel = saveRelation(db, {
      subjectId: a,
      type: "DEPENDS_ON",
      objectId: x,
      ...attrs,
      validAt: "2026-03-01",
      confidence: 0.7,
    }).id;
    const before = db.all("SELECT * FROM relations WHERE id = ?", [rel])[0];
    const done = split(a, [{ kind: "relation", id: rel }]);
    if (done.status !== "applied") throw new Error("split");
    expect(db.all("SELECT * FROM relations WHERE id = ?", [rel])[0]).toEqual({
      ...before,
      subject_id: done.created,
    });
  });

  it("does not take a fresh relation of an item outside the group for the moved one", () => {
    const [a, x, z] = [item(), item(), item()] as [number, number, number];
    fact(a, "2026-12-05");
    const rel = relation(a, x);
    const versionId = saveV("s1");
    const sourceId = db.all("SELECT source_id FROM source_versions WHERE id = ?", [versionId])[0]
      ?.source_id as number;
    addEvidence(db, {
      target: { relationId: rel },
      sourceVersionId: versionId,
      start: 0,
      end: 4,
      quote: "body",
    });
    split(a, [{ kind: "relation", id: rel }]);
    // the same type and object, but the subject is an item that was never in the original's group
    const outside = saveRelation(db, { subjectId: z, type: "DEPENDS_ON", objectId: x, ...attrs });
    expect(outside.created).toBe(true);
    expect(
      followMovedRow(db, { target: { relationId: outside.id }, created: true }, sourceId),
    ).toEqual({
      target: { relationId: outside.id },
      created: true,
    });
    expect(db.all("SELECT 1 FROM relations WHERE id = ?", [outside.id])).toHaveLength(1);
  });
});
