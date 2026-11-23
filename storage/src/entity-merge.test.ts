// S02-T04 `resolution.merge-unmerge` (storage level; S02-R11, R12, R13, R16, R26): the user's merge, unmerge and
// distinct mark, the group reads, the history lines that the S01 undo and protection read past, the refusal of a
// direct add's undo while something hangs on the item, the membership notification, and the groups' resting.
// Every state is reached through the entries; the history lines of a fact are written through the gate's
// own `writeLine` where a test needs a line S02-T07/T08 will write. All data is synthetic.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { mayCombine, defaultScopePolicy } from "./scope-policy.ts";
import { scopesOfVersions, type ScopePolicy } from "./derivatives.ts";
import {
  componentOf,
  entityGroups,
  rejudgeGroups,
  rootOf,
  withGroups,
  type MembershipChange,
} from "./entity-groups.ts";
import {
  addEvidence,
  insertItem,
  saveFact,
  saveRelation,
  type KnowledgeAttributes,
} from "./knowledge.ts";
import { migrate } from "./migrations.ts";
import {
  applyTransition,
  automatedLifecycle,
  isUserDecided,
  NO_CURRENT_EVIDENCE_APPROVAL,
  writeLine,
  type EntryRef,
} from "./semantic-lifecycle.ts";
import { createUserDecisions, userDecisions, type UserDecisions } from "./semantic-user.ts";
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
const BASIS = { sourceId: 7, version: 3 };

let counter = 0;
/** An item as extraction makes it: a creation line. */
function extractedItem(type = "Project"): number {
  counter++;
  const id = insertItem(db, { type, name: `item-${counter}`, ...attrs });
  automatedLifecycle.created(db, { kind: "item", id }, "extraction", BASIS);
  return id;
}
/** A stored source (with an access scope) with one item that a fact of it built: the item's lineage is that source. */
function itemFrom(externalId: string, accessScope: string[] | null = null, type = "Project") {
  const saved = saveSourceRecord(db, "c1", {
    externalId,
    title: `t-${externalId}`,
    body: `body of ${externalId}`,
    accessScope,
  });
  if (saved.status !== "created") throw new Error(saved.status);
  const versionId = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
  const item = extractedItem(type);
  const fact = saveFact(db, {
    itemId: item,
    kind: "target_date",
    value: "2026-12-05",
    ...attrs,
  }).id;
  automatedLifecycle.created(db, { kind: "fact", id: fact }, "extraction", BASIS);
  addEvidence(db, {
    target: { factId: fact },
    sourceVersionId: versionId,
    start: 0,
    end: 4,
    quote: `body`,
  });
  return { item, fact, sourceId: saved.sourceId, version: saved.version };
}
function userItem(name = `u-${++counter}`, type = "Project"): number {
  const added = userDecisions.add(db, { kind: "item", type, name });
  if (added.status !== "applied") throw new Error("the user's item");
  return added.ref.id;
}

const rowsOf = () => ({
  items: db.all("SELECT * FROM items ORDER BY id"),
  facts: db.all("SELECT * FROM facts ORDER BY id"),
  relations: db.all("SELECT * FROM relations ORDER BY id"),
  evidence: db.all("SELECT * FROM evidence ORDER BY id"),
  factHistory: db.all("SELECT * FROM fact_history ORDER BY fact_id, seq"),
  relationHistory: db.all("SELECT * FROM relation_history ORDER BY relation_id, seq"),
});
const itemLines = (id: number) =>
  db.all(
    "SELECT seq, actor, action, from_status, to_status, from_epistemic, to_epistemic, batch FROM item_history WHERE item_id = ? ORDER BY seq",
    [id],
  );
const actionsOf = (id: number) => itemLines(id).map((l) => l.action);
const mergeLines = () =>
  db.all("SELECT member_id, representative_id, active FROM item_merges ORDER BY id");
const distinctMarks = () =>
  db.all("SELECT item_a, item_b, by FROM item_distinct ORDER BY item_a, item_b");

function merge(member: number, into: number) {
  const result = db.transaction(() => userDecisions.entities.merge(db, member, into, AT));
  if (result.status !== "applied") throw new Error(`merge refused: ${result.reason}`);
  return result.mergeId;
}

describe("resolution.merge-unmerge: one line, no row moves (S02-R11, R12)", () => {
  it("writes one line and two history lines, changes no row, and an unmerge puts every table back", () => {
    const a = itemFrom("a");
    const b = itemFrom("b");
    const before = rowsOf();
    const historyBefore = [itemLines(a.item).length, itemLines(b.item).length];

    const id = merge(a.item, b.item);
    expect(mergeLines()).toEqual([{ member_id: a.item, representative_id: b.item, active: 1 }]);
    expect(rowsOf()).toEqual(before); // no row of the four tables moved or changed
    expect(actionsOf(a.item).slice(-1)).toEqual(["merge"]);
    expect(actionsOf(b.item).slice(-1)).toEqual(["merge"]);
    // the line: the user, the two states the same, the line's number in `batch`
    const line = itemLines(a.item).at(-1);
    expect(line).toMatchObject({
      actor: "user",
      from_status: "candidate",
      to_status: "candidate",
      from_epistemic: "explicit",
      to_epistemic: "explicit",
      batch: id,
    });

    const undone = db.transaction(() => userDecisions.entities.unmerge(db, id, true, AT));
    expect(undone).toEqual({ status: "applied", member: a.item, representative: b.item });
    expect(mergeLines()).toEqual([]);
    expect(rowsOf()).toEqual(before); // the rows are as before: an unmerge needs no row to go back
    // two lines each, merge and unmerge, and nothing else is new
    expect(itemLines(a.item)).toHaveLength((historyBefore[0] as number) + 2);
    expect(itemLines(b.item)).toHaveLength((historyBefore[1] as number) + 2);
    expect(actionsOf(b.item).slice(-2)).toEqual(["merge", "unmerge"]);
  });

  it("merges one-line-per-member chains: stacking, and unmerging the first line leaves the later group together", () => {
    const [a, b, c] = [extractedItem(), extractedItem(), extractedItem()] as [
      number,
      number,
      number,
    ];
    const ab = merge(a, b);
    merge(b, c); // A->B, B->C
    expect(mergeLines()).toEqual([
      { member_id: a, representative_id: b, active: 1 },
      { member_id: b, representative_id: c, active: 1 },
    ]);
    expect(entityGroups.representativeOf(db, a)).toBe(c);
    expect(entityGroups.membersOf(db, a)).toEqual([a, b, c]);
    db.transaction(() => userDecisions.entities.unmerge(db, ab, false, AT));
    // A leaves; B stays in C's group
    expect(entityGroups.membersOf(db, a)).toEqual([a]);
    expect(entityGroups.membersOf(db, b)).toEqual([b, c]);
    expect(entityGroups.representativeOf(db, b)).toBe(c);
  });

  it("reads either end through its top: merging a member writes the line between the two tops", () => {
    const [a, b, c, d] = [extractedItem(), extractedItem(), extractedItem(), extractedItem()] as [
      number,
      number,
      number,
      number,
    ];
    merge(a, b); // group {a, b}, top b
    merge(c, d); // group {c, d}, top d
    merge(a, c); // names members: the line goes top b -> top d
    expect(mergeLines()).toContainEqual({ member_id: b, representative_id: d, active: 1 });
    expect(mergeLines()).toHaveLength(3);
    expect(entityGroups.membersOf(db, a)).toEqual([a, b, c, d]);
    // the two tops carry the history lines, the named members do not
    expect(actionsOf(b).filter((x) => x === "merge")).toHaveLength(2);
    expect(actionsOf(a).filter((x) => x === "merge")).toHaveLength(1);
  });

  it("refuses by code and writes nothing: not-found, type-mismatch, already-merged", () => {
    const person = extractedItem("Person");
    const project = extractedItem();
    const other = extractedItem();
    const before = { rows: rowsOf(), lines: mergeLines() };
    const merged = (m: number, i: number) => userDecisions.entities.merge(db, m, i, AT);
    expect(merged(person, 99_999)).toEqual({ status: "refused", reason: "not-found" });
    expect(merged(99_999, project)).toEqual({ status: "refused", reason: "not-found" });
    expect(merged(person, project)).toEqual({ status: "refused", reason: "type-mismatch" });
    expect(merged(project, project)).toEqual({ status: "refused", reason: "already-merged" });
    merge(project, other);
    expect(merged(other, project)).toEqual({ status: "refused", reason: "already-merged" });
    expect(userDecisions.entities.unmerge(db, 99_999, true, AT)).toEqual({
      status: "refused",
      reason: "not-found",
    });
    expect(rowsOf()).toEqual(before.rows);
    expect(mergeLines()).toHaveLength(1);
  });

  it("is not stopped by a conflicting value: signals only decide what the product suggests (provisional decision 14)", () => {
    const a = itemFrom("a");
    const b = itemFrom("b");
    db.run("UPDATE facts SET value = '2027-01-01' WHERE id = ?", [b.fact]); // the two disagree
    expect(userDecisions.entities.merge(db, a.item, b.item, AT)).toMatchObject({
      status: "applied",
    });
  });
});

describe("resolution.merge-unmerge: the distinct mark (S02-R11, R12, R16)", () => {
  it("is cleared by a merge of the pair, and does not come back with an unmerge that keeps none", () => {
    const [a, b] = [extractedItem(), extractedItem()] as [number, number];
    expect(userDecisions.entities.setDistinct(db, b, a, true, AT)).toEqual({ status: "applied" });
    expect(distinctMarks()).toEqual([{ item_a: a, item_b: b, by: "user" }]); // the smaller id first
    expect(userDecisions.entities.setDistinct(db, a, b, true, AT)).toEqual({ status: "unchanged" });
    const id = merge(a, b);
    expect(distinctMarks()).toEqual([]); // a later user judgement wins
    db.transaction(() => userDecisions.entities.unmerge(db, id, false, AT));
    expect(distinctMarks()).toEqual([]); // the unmerge keeps none when the user said so
  });

  it("is left by an unmerge by default and on request only, between the line's two ends", () => {
    const [a, b, c, d] = [extractedItem(), extractedItem(), extractedItem(), extractedItem()] as [
      number,
      number,
      number,
      number,
    ];
    const first = merge(a, b);
    const second = merge(c, d);
    db.transaction(() => userDecisions.entities.unmerge(db, first, true, AT));
    expect(distinctMarks()).toEqual([{ item_a: a, item_b: b, by: "user" }]);
    db.transaction(() => userDecisions.entities.unmerge(db, second, false, AT));
    expect(distinctMarks()).toHaveLength(1);
  });

  it("clears on request, drops the pair's candidate when set (a rejected candidate), and refuses the same item and an item that is not stored", () => {
    const [a, b] = [extractedItem(), extractedItem()] as [number, number];
    db.run("INSERT INTO merge_candidates (item_a, item_b, signals, at) VALUES (?, ?, '[]', ?)", [
      a,
      b,
      AT,
    ]);
    expect(userDecisions.entities.setDistinct(db, a, b, true, AT)).toEqual({ status: "applied" });
    expect(db.all("SELECT 1 FROM merge_candidates")).toEqual([]);
    expect(userDecisions.entities.setDistinct(db, a, b, false, AT)).toEqual({ status: "applied" });
    expect(userDecisions.entities.setDistinct(db, a, b, false, AT)).toEqual({
      status: "unchanged",
    });
    expect(userDecisions.entities.setDistinct(db, a, a, true, AT)).toEqual({
      status: "refused",
      reason: "same-item",
    });
    expect(userDecisions.entities.setDistinct(db, a, 99_999, true, AT)).toEqual({
      status: "refused",
      reason: "not-found",
    });
  });

  it("takes the candidates between the two groups with the merge that accepted one", () => {
    const [a, b, c] = [extractedItem(), extractedItem(), extractedItem()] as [
      number,
      number,
      number,
    ];
    for (const [x, y] of [
      [a, b],
      [a, c],
      [b, c],
    ] as const) {
      db.run("INSERT INTO merge_candidates (item_a, item_b, signals, at) VALUES (?, ?, '[]', ?)", [
        x,
        y,
        AT,
      ]);
    }
    merge(a, b);
    // (a, b) is the accepted one; (a, c) and (b, c) are between a's group and c: kept
    expect(db.all("SELECT item_a, item_b FROM merge_candidates ORDER BY item_a, item_b")).toEqual([
      { item_a: a, item_b: c },
      { item_a: b, item_b: c },
    ]);
    merge(a, c); // groups {a, b} and {c}: every candidate between them goes
    expect(db.all("SELECT 1 FROM merge_candidates")).toEqual([]);
  });
});

describe("resolution.merge-unmerge: the S01 undo and protection read past the merge lines (S02-R11, provisional decision 18)", () => {
  it("cancels an item's approval after a merge, and the merge line stays", () => {
    const [a, b] = [extractedItem(), extractedItem()] as [number, number];
    expect(userDecisions.decide(db, { kind: "item", id: a }, "approve", AT)).toMatchObject({
      status: "applied",
    });
    merge(a, b);
    expect(userDecisions.undo(db, { kind: "item", id: a }, AT)).toMatchObject({
      status: "applied",
    });
    expect(db.all("SELECT status, epistemic FROM items WHERE id = ?", [a])).toEqual([
      { status: "candidate", epistemic: "explicit" },
    ]);
    expect(mergeLines()).toHaveLength(1);
    // the merge line is not the thing a second undo goes for: the line it cancelled was the approval
    expect(userDecisions.undo(db, { kind: "item", id: a }, AT)).toEqual({
      status: "refused",
      reason: "nothing-to-undo",
    });
  });

  it("does not take a merge line for the last user action of an approval that rests on no evidence (the protection goes on)", () => {
    const owner = extractedItem();
    const fact: EntryRef = {
      kind: "fact",
      id: saveFact(db, { itemId: owner, kind: "target_date", value: "2026-12-05", ...attrs }).id,
    };
    automatedLifecycle.created(db, fact, "extraction", BASIS);
    expect(userDecisions.decide(db, fact, "approve", AT)).toMatchObject({ status: "applied" });
    expect(db.all("SELECT reason FROM fact_history WHERE action = 'approve'")).toEqual([
      { reason: NO_CURRENT_EVIDENCE_APPROVAL },
    ]);
    // a state-neutral line after the approval, as S02-T07's split and S02-T08's validity fix write them
    writeLine(db, fact, {
      from: { status: "verified", epistemic: "user-approved" },
      to: { status: "verified", epistemic: "user-approved" },
      actor: "user",
      action: "split",
    });
    // the protection: propagation may not supersede a row the user approved while it rests on no evidence
    expect(automatedLifecycle.supersede(db, fact, { sourceId: 9, version: 9 })).toEqual({
      status: "refused",
      reason: "user-override",
    });
    // and the approval is still the thing an undo goes back from
    expect(userDecisions.undo(db, fact, AT)).toMatchObject({ status: "applied" });
    expect(db.all("SELECT status, epistemic FROM facts WHERE id = ?", [fact.id])).toEqual([
      { status: "candidate", epistemic: "explicit" },
    ]);
  });

  it("restores a superseded row through the line that made the state, not the neutral line after it", () => {
    const owner = extractedItem();
    const fact: EntryRef = {
      kind: "fact",
      id: saveFact(db, { itemId: owner, kind: "target_date", value: "2026-12-05", ...attrs }).id,
    };
    automatedLifecycle.created(db, fact, "extraction", BASIS);
    expect(automatedLifecycle.supersede(db, fact, BASIS)).toMatchObject({ status: "applied" });
    writeLine(db, fact, {
      from: { status: "superseded", epistemic: "explicit" },
      to: { status: "superseded", epistemic: "explicit" },
      actor: "user",
      action: "set-validity",
    });
    // red without the skip: the last line is the user's, so the restore refuses with user-override
    expect(automatedLifecycle.evidenceReturned(db, fact, BASIS)).toMatchObject({
      status: "applied",
    });
    expect(db.all("SELECT status FROM facts WHERE id = ?", [fact.id])).toEqual([
      { status: "candidate" },
    ]);
  });

  it("finds the line that made a state across a neutral line: a restore after a user's approval of a superseded row and its undo", () => {
    const owner = extractedItem();
    const fact: EntryRef = {
      kind: "fact",
      id: saveFact(db, {
        itemId: owner,
        kind: "target_date",
        value: "2026-12-05",
        ...attrs,
        status: "verified",
      }).id,
    };
    automatedLifecycle.created(db, fact, "extraction", BASIS); // 1
    expect(automatedLifecycle.supersede(db, fact, BASIS)).toMatchObject({ status: "applied" }); // 2
    writeLine(db, fact, {
      from: { status: "superseded", epistemic: "explicit" },
      to: { status: "superseded", epistemic: "explicit" },
      actor: "user",
      action: "set-validity",
    }); // 3: neutral, between the supersede and the approval
    expect(userDecisions.decide(db, fact, "approve", AT)).toMatchObject({ status: "applied" }); // 4
    expect(userDecisions.undo(db, fact, AT)).toMatchObject({ status: "applied" }); // 5: back to superseded
    expect(db.all("SELECT status FROM facts WHERE id = ?", [fact.id])).toEqual([
      { status: "superseded" },
    ]);
    // the state was made by the undo; the line before the approval is the supersede, not the neutral line at seq 3
    expect(automatedLifecycle.evidenceReturned(db, fact, BASIS)).toMatchObject({
      status: "applied",
    });
    // it goes back to what it was before the supersede (verified), which only the right line says
    expect(db.all("SELECT status FROM facts WHERE id = ?", [fact.id])).toEqual([
      { status: "verified" },
    ]);
  });

  it("reverts the right line when a neutral line sits between an action and the one before it", () => {
    const [a, b] = [extractedItem(), extractedItem()] as [number, number];
    merge(a, b); // a neutral line first
    expect(userDecisions.decide(db, { kind: "item", id: a }, "approve", AT)).toMatchObject({
      status: "applied",
    });
    expect(userDecisions.undo(db, { kind: "item", id: a }, AT)).toMatchObject({
      status: "applied",
    });
    // the undo line names the approval, whatever lines lie around it
    const undo = itemLines(a).at(-1);
    expect(undo?.action).toBe("undo");
    // a restore reads the state before the approval across the merge line
    expect(db.all("SELECT status FROM items WHERE id = ?", [a])).toEqual([{ status: "candidate" }]);
  });
});

describe("resolution.merge-unmerge: a merge line is no user decision (S02-R11)", () => {
  it("leaves the item not user-decided and lets automated transitions through", () => {
    const [a, b] = [extractedItem(), extractedItem()] as [number, number];
    merge(a, b);
    expect(isUserDecided(db, { kind: "item", id: a })).toBe(false);
    expect(isUserDecided(db, { kind: "item", id: b })).toBe(false);
    // an automated actor may still raise an item's epistemic type: a user-decided row would refuse it
    expect(automatedLifecycle.explicitEvidence(db, { kind: "item", id: a }, BASIS)).not.toEqual({
      status: "refused",
      reason: "user-override",
    });
    const fact: EntryRef = {
      kind: "fact",
      id: saveFact(db, {
        itemId: a,
        kind: "target_date",
        value: "2026-12-05",
        ...attrs,
        epistemic: "hypothesis",
      }).id,
    };
    automatedLifecycle.created(db, fact, "extraction", BASIS);
    expect(automatedLifecycle.explicitEvidence(db, fact, BASIS)).toMatchObject({
      status: "applied",
    });
  });
});

describe("resolution.merge-unmerge: a direct add's undo while something hangs on the item (S02-R11)", () => {
  it("refuses with existing-data-violation and counts, changes nothing, for a user's item that is in a merge", () => {
    const mine = userItem();
    const other = userItem();
    const id = merge(mine, other);
    const before = { rows: rowsOf(), lines: mergeLines(), history: itemLines(mine) };
    const refused = userDecisions.undo(db, { kind: "item", id: mine }, AT);
    expect(refused).toEqual({
      status: "refused",
      reason: "existing-data-violation",
      held: { facts: 0, relations: 0, merges: 1, distinct: 0, splitMoves: 0 },
    });
    expect(mergeLines()).toEqual(before.lines);
    expect(rowsOf()).toEqual(before.rows);
    expect(itemLines(mine)).toEqual(before.history);
    // the whole chain: the middle item of A->B->C holds two lines
    const third = userItem();
    merge(other, third);
    expect(userDecisions.undo(db, { kind: "item", id: other }, AT)).toMatchObject({
      reason: "existing-data-violation",
      held: { merges: 2 },
    });
    // unmerged and no mark left: nothing hangs on it and the undo is the removal it always was
    db.transaction(() => userDecisions.entities.unmerge(db, id, false, AT));
    expect(userDecisions.undo(db, { kind: "item", id: mine }, AT)).toEqual({ status: "removed" });
    expect(db.all("SELECT 1 FROM items WHERE id = ?", [mine])).toEqual([]);
  });

  it("counts a distinct mark, a split record and a relation as things that hang on the item", () => {
    const mine = userItem();
    const x = extractedItem();
    userDecisions.entities.setDistinct(db, mine, x, true, AT);
    expect(userDecisions.undo(db, { kind: "item", id: mine }, AT)).toMatchObject({
      reason: "existing-data-violation",
      held: { distinct: 1 },
    });
    userDecisions.entities.setDistinct(db, mine, x, false, AT);
    const fact = saveFact(db, { itemId: x, kind: "target_date", value: "2026-12-05", ...attrs }).id;
    db.run("INSERT INTO item_split_moves (from_item_id, to_item_id, fact_id) VALUES (?, ?, ?)", [
      x,
      mine,
      fact,
    ]);
    expect(userDecisions.undo(db, { kind: "item", id: mine }, AT)).toMatchObject({
      reason: "existing-data-violation",
      held: { splitMoves: 1 },
    });
    db.run("DELETE FROM item_split_moves");
    const rel = saveRelation(db, { subjectId: mine, type: "DEPENDS_ON", objectId: x, ...attrs }).id;
    expect(userDecisions.undo(db, { kind: "item", id: mine }, AT)).toMatchObject({
      held: { relations: 1 },
    });
    expect(rel).toBeGreaterThan(0);
  });
});

describe("resolution.merge-unmerge: the membership notification (S02-R13)", () => {
  const spyOver = (listeners: ((tx: SqlDriver, change: MembershipChange) => void)[]) =>
    createUserDecisions({ combinable: () => true, listeners });

  it("tells every listener once per merge and once per unmerge, with the items reached, in the list's order", () => {
    const calls: string[] = [];
    const entry = spyOver([
      (_tx, change) => calls.push(`first:${change.items.join(",")}`),
      (_tx, change) => calls.push(`second:${change.items.join(",")}`),
    ]);
    const [a, b, c] = [extractedItem(), extractedItem(), extractedItem()] as [
      number,
      number,
      number,
    ];
    const first = db.transaction(() => entry.entities.merge(db, a, b, AT));
    expect(calls).toEqual([`first:${a},${b}`, `second:${a},${b}`]);
    calls.length = 0;
    db.transaction(() => entry.entities.merge(db, b, c, AT));
    expect(calls).toEqual([`first:${a},${b},${c}`, `second:${a},${b},${c}`]);
    calls.length = 0;
    if (first.status !== "applied") throw new Error("merge");
    db.transaction(() => entry.entities.unmerge(db, first.mergeId, true, AT));
    // both halves are reached: {a} and {b, c}
    expect(calls).toEqual([`first:${a},${b},${c}`, `second:${a},${b},${c}`]);
    // a refusal and a distinct mark change no membership: nothing is told
    calls.length = 0;
    entry.entities.merge(db, b, c, AT);
    entry.entities.setDistinct(db, a, c, true, AT);
    expect(calls).toEqual([]);
  });

  it("rolls the whole action back when a listener throws", () => {
    const entry = spyOver([
      () => {
        throw new Error("the receiver refused");
      },
    ]);
    const [a, b] = [extractedItem(), extractedItem()] as [number, number];
    const before = {
      rows: rowsOf(),
      history: [itemLines(a), itemLines(b)],
      marks: distinctMarks(),
    };
    expect(() => db.transaction(() => entry.entities.merge(db, a, b, AT))).toThrow(
      /receiver refused/,
    );
    expect(mergeLines()).toEqual([]);
    expect([itemLines(a), itemLines(b)]).toEqual(before.history);
    expect(rowsOf()).toEqual(before.rows);
    // and for an unmerge: the line is still there
    const ok = createUserDecisions({ combinable: () => true, listeners: [] });
    const id = db.transaction(() => ok.entities.merge(db, a, b, AT));
    if (id.status !== "applied") throw new Error("merge");
    expect(() => db.transaction(() => entry.entities.unmerge(db, id.mergeId, true, AT))).toThrow(
      /receiver refused/,
    );
    expect(mergeLines()).toHaveLength(1);
  });
});

describe("resolution.group-reads: the notification carries the action's own scope (S02-R13)", () => {
  it("hands every listener the action's scope: combinable answers what the entry's policy answers, for merge, unmerge and split", () => {
    const refused = { sourceId: 9999, version: 1 };
    const allowed = { sourceId: 1, version: 1 };
    const answers: [boolean, boolean][] = [];
    const entry = createUserDecisions({
      combinable: (_tx, lineage) => !lineage.some((v) => v.sourceId === refused.sourceId),
      listeners: [
        (_tx, _change, scope) =>
          answers.push([scope.combinable([refused]), scope.combinable([allowed])]),
      ],
    });
    const [a, b] = [extractedItem(), extractedItem()] as [number, number];
    const merged = db.transaction(() => entry.entities.merge(db, a, b, AT));
    if (merged.status !== "applied") throw new Error("merge");
    db.transaction(() => entry.entities.unmerge(db, merged.mergeId, true, AT));
    saveFact(db, { itemId: a, kind: "target_date", value: "2026-12-07", ...attrs });
    const moved = saveFact(db, {
      itemId: a,
      kind: "target_date",
      value: "2026-12-06",
      ...attrs,
    }).id;
    expect(
      db.transaction(() =>
        entry.entities.split(db, a, [{ kind: "fact", id: moved }], "new item", AT),
      ),
    ).toMatchObject({ status: "applied" });
    expect(answers).toEqual([
      [false, true],
      [false, true],
      [false, true],
    ]);
  });
});

describe("resolution.scope (merge part): the scope policy and the group's resting (S02-R11, R13)", () => {
  /** A policy that will not put a source of scope "secret" together with any other scope. */
  const apart: ScopePolicy = {
    ...defaultScopePolicy,
    combinable: (scopes) => !(scopes.length > 1 && scopes.some((s) => s?.includes("secret"))),
  };
  const apartEntry = (): UserDecisions =>
    createUserDecisions({
      combinable: (tx, lineage) => mayCombine(apart, scopesOfVersions(tx, lineage)),
      listeners: [],
    });
  const judged = (policy: ScopePolicy, items: number[]) =>
    rejudgeGroups(db, items, (lineage) => mayCombine(policy, scopesOfVersions(db, lineage)));

  it("refuses a merge whose two lineages cannot be put together, and writes nothing", () => {
    const open = itemFrom("open");
    const secret = itemFrom("secret", ["secret"]);
    const before = rowsOf();
    expect(apartEntry().entities.merge(db, open.item, secret.item, AT)).toEqual({
      status: "refused",
      reason: "scope-refused",
    });
    expect(mergeLines()).toEqual([]);
    expect(rowsOf()).toEqual(before);
    expect(db.all("SELECT 1 FROM item_history WHERE action = 'merge'")).toEqual([]);
    // the public default policy refuses nothing
    expect(userDecisions.entities.merge(db, open.item, secret.item, AT)).toMatchObject({
      status: "applied",
    });
  });

  it("rests every line of a group whose lineage can no longer be put together, and wakes them when it can; the lines are never rewritten", () => {
    const open = itemFrom("open");
    const open2 = itemFrom("open2");
    const secret = itemFrom("secret", ["secret"]);
    merge(open.item, open2.item);
    merge(open2.item, secret.item);
    const lines = db.all("SELECT id, member_id, representative_id FROM item_merges ORDER BY id");
    expect(mergeLines().map((l) => l.active)).toEqual([1, 1]);

    // the policy is stricter than when the group was made: ONE source makes ALL lines rest
    expect(judged(apart, [open.item])).toMatchObject({ changedLines: 2 });
    expect(mergeLines().map((l) => l.active)).toEqual([0, 0]);
    // resting: no read sees the group; the lines are still there, the same
    expect(entityGroups.membersOf(db, open.item)).toEqual([open.item]);
    expect(entityGroups.representativeOf(db, open.item)).toBe(open.item);
    expect(entityGroups.lineageOf(db, open2.item)).toEqual([
      { sourceId: open2.sourceId, version: open2.version },
    ]);
    expect(db.all("SELECT id, member_id, representative_id FROM item_merges ORDER BY id")).toEqual(
      lines,
    );
    // but the resting group is still one group for a merge's own reading
    expect(rootOf(db, open.item)).toBe(secret.item);
    expect(componentOf(db, open.item)).toEqual(
      [open.item, open2.item, secret.item].sort((x, y) => x - y),
    );
    // judged again with nothing different: nothing changes
    expect(judged(apart, [secret.item])).toMatchObject({ changedLines: 0, items: [] });
    // the policy allows it again
    expect(judged(defaultScopePolicy, [open2.item])).toMatchObject({ changedLines: 2 });
    expect(mergeLines().map((l) => l.active)).toEqual([1, 1]);
    expect(entityGroups.membersOf(db, open.item)).toHaveLength(3);
  });

  it("will not merge into a group that rests, and an unmerge of a resting line judges the two halves by themselves", () => {
    const open = itemFrom("open");
    const secret = itemFrom("secret", ["secret"]);
    const third = itemFrom("third");
    const id = merge(open.item, secret.item);
    judged(apart, [open.item]);
    // the group {open, secret} rests; the other item cannot join it
    expect(apartEntry().entities.merge(db, third.item, open.item, AT)).toEqual({
      status: "refused",
      reason: "scope-refused",
    });
    // unmerging the resting line is allowed, and each half is judged by itself
    db.transaction(() => apartEntry().entities.unmerge(db, id, false, AT));
    expect(mergeLines()).toEqual([]);
    expect(entityGroups.membersOf(db, open.item)).toEqual([open.item]);
  });
});

describe("the S01 assumptions this task rests on, as they are in the code (S02 spec 'S01 구현이 끝나면 다시 볼 것' 1, 2)", () => {
  it("accepts an action name the closed list of S01 never named: the history's `action` is open text, not a CHECK list", () => {
    const [a, b] = [extractedItem(), extractedItem()] as [number, number];
    merge(a, b);
    for (const action of ["merge", "unmerge", "split", "set-validity"]) {
      writeLine(
        db,
        { kind: "item", id: a },
        {
          from: { status: "candidate", epistemic: "explicit" },
          to: { status: "candidate", epistemic: "explicit" },
          actor: "user",
          action,
        },
      );
    }
    expect(actionsOf(a)).toEqual(["created", "merge", "merge", "unmerge", "split", "set-validity"]);
  });

  it("lets a fact's item_id and a relation's ends change by a bare UPDATE: the lifecycle gate guards status, epistemic and user_authored only", () => {
    const [a, b] = [extractedItem(), extractedItem()] as [number, number];
    const fact = saveFact(db, { itemId: a, kind: "target_date", value: "2026-12-05", ...attrs }).id;
    const relation = saveRelation(db, {
      subjectId: a,
      type: "DEPENDS_ON",
      objectId: b,
      ...attrs,
    }).id;
    expect(() => db.run("UPDATE facts SET item_id = ? WHERE id = ?", [b, fact])).not.toThrow();
    expect(() =>
      db.run("UPDATE relations SET subject_id = ?, object_id = ? WHERE id = ?", [b, a, relation]),
    ).not.toThrow();
    // and a bare change of the state is still refused
    expect(() => db.run("UPDATE facts SET status = 'verified' WHERE id = ?", [fact])).toThrow(
      /lifecycle gate/,
    );
    expect(applyTransition(db, { kind: "fact", id: fact }, "user", "verified")).toMatchObject({
      status: "applied",
    });
  });
});

describe("resolution.group-reads: withGroups finds the groups of a list in one read (S02-R13)", () => {
  it("adds the members of every item's active group, once, ascending, and leaves lone items and resting groups alone", () => {
    const [a, b, c, lone, p, q] = [1, 2, 3, 4, 5, 6].map(() => extractedItem()) as number[] as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const entry = createUserDecisions({ combinable: () => true, listeners: [] });
    for (const [m, r] of [
      [a, b],
      [b, c],
      [p, q],
    ] as const) {
      db.transaction(() => entry.entities.merge(db, m, r, AT));
    }
    expect(withGroups(db, [c, lone, c])).toEqual([a, b, c, lone]);
    expect(withGroups(db, [])).toEqual([]);
    db.run("UPDATE item_merges SET active = 0 WHERE member_id = ?", [p]);
    expect(withGroups(db, [q])).toEqual([q]);
  });
});
