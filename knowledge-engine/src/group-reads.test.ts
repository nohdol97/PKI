// S02-T05 `resolution.group-reads` (S02-R13): the rule "의존 업무 지연" and the kind `insight` read a merge group as one
// item. The groups are made by merge lines written directly where a test is about the pure rule, and by the user's
// entry where it is about the notification. All data is synthetic.
import {
  addEvidence,
  insertItem,
  migrate,
  readInsight,
  registerConnectorInstance,
  saveFact,
  saveRelation,
  saveSourceRecord,
  type KnowledgeAttributes,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COMPLETION_DATE,
  DEPENDENCY_DELAY,
  DEPENDS_ON,
  TARGET_DATE,
  recomputeDependencyDelay,
} from "./dependency-delay.ts";

const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
};

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

const item = (name: string) => insertItem(db, { type: "Project", name, ...attrs });

/** Stores `body` as the next version of source `externalId`; returns that version's row id. */
function version(externalId: string, body: string): number {
  saveSourceRecord(db, "c1", { externalId, title: externalId, body });
  return db.all(
    `SELECT max(v.id) AS id FROM source_versions v JOIN sources s ON s.id = v.source_id
     WHERE s.external_id = ?`,
    [externalId],
  )[0]?.id as number;
}
function quote(
  target: { factId: number } | { relationId: number },
  externalId: string,
  body: string,
) {
  addEvidence(db, {
    target,
    sourceVersionId: version(externalId, body),
    start: 0,
    end: body.length,
    quote: body,
  });
}
function fact(itemId: number, kind: string, value: string, externalId: string) {
  const id = saveFact(db, { itemId, kind, value, ...attrs }).id;
  quote({ factId: id }, externalId, `${kind} ${value}`);
  return id;
}
function dependsOn(subjectId: number, objectId: number, externalId: string) {
  const id = saveRelation(db, { subjectId, type: DEPENDS_ON, objectId, ...attrs }).id;
  quote({ relationId: id }, externalId, `${subjectId} depends on ${objectId}`);
  return id;
}
/** A merge line as the user's entry leaves it, written directly: the member is the representative's. */
const line = (member: number, representative: number, active = 1) =>
  db.run("INSERT INTO item_merges (member_id, representative_id, active, at) VALUES (?, ?, ?, ?)", [
    member,
    representative,
    active,
    "2026-11-23T00:00:00.000Z",
  ]);
const key = (x: number, y: number) => ({ rule: DEPENDENCY_DELAY, xItemId: x, yItemId: y });
const rows = () => db.all("SELECT x_item_id, y_item_id, state FROM insights ORDER BY id");

/** X (target 12-05) depends on Y; Y′ holds the completion date (12-10), so only a group makes it late. */
function lateThroughMember() {
  const [x, y, yPrime] = [item("X"), item("Y"), item("Y′")] as const;
  fact(x, TARGET_DATE, "2026-12-05", "s-target");
  dependsOn(x, y, "s-dep");
  const completion = fact(yPrime, COMPLETION_DATE, "2026-12-10", "s-completion");
  return { x, y, yPrime, completion };
}

describe("resolution.group-reads: the rule reads a group as one item (S02-R13)", () => {
  it("makes no Insight before the merge and one keyed by the representative after it", () => {
    const { x, y, yPrime } = lateThroughMember();
    expect(recomputeDependencyDelay(db, [yPrime])).toEqual([]);
    expect(rows()).toEqual([]);
    line(yPrime, y);
    expect(recomputeDependencyDelay(db, [yPrime])).toEqual([
      { key: key(x, y), outcome: "created" },
    ]);
    expect(rows()).toEqual([{ x_item_id: x, y_item_id: y, state: "active" }]);
    expect(readInsight(db, key(x, y))?.summary).toContain("2026-12-10");
  });

  it("resolves an Insight keyed by a member and makes the representative's", () => {
    const [x, y, yPrime] = [item("X"), item("Y"), item("Y′")] as const;
    fact(x, TARGET_DATE, "2026-12-05", "s-target");
    dependsOn(x, yPrime, "s-dep");
    fact(yPrime, COMPLETION_DATE, "2026-12-10", "s-completion");
    expect(recomputeDependencyDelay(db, [x])).toEqual([
      { key: key(x, yPrime), outcome: "created" },
    ]);
    line(yPrime, y);
    expect(recomputeDependencyDelay(db, [yPrime])).toEqual([
      { key: key(x, y), outcome: "created" },
      { key: key(x, yPrime), outcome: "resolved" },
    ]);
    expect(rows()).toEqual([
      { x_item_id: x, y_item_id: yPrime, state: "resolved" },
      { x_item_id: x, y_item_id: y, state: "active" },
    ]);
  });

  it("reads the dependency from any member of X's group to any member of Y's group", () => {
    const [x, xPrime, y, yPrime] = [item("X"), item("X′"), item("Y"), item("Y′")] as const;
    const t = fact(x, TARGET_DATE, "2026-12-05", "s-target");
    const r = dependsOn(xPrime, yPrime, "s-dep");
    const c = fact(yPrime, COMPLETION_DATE, "2026-12-10", "s-completion");
    line(xPrime, x);
    line(yPrime, y);
    expect(recomputeDependencyDelay(db, [xPrime])).toEqual([
      { key: key(x, y), outcome: "created" },
    ]);
    const used = [
      ...db.all("SELECT id FROM evidence WHERE fact_id = ?", [t]),
      ...db.all("SELECT id FROM evidence WHERE relation_id = ?", [r]),
      ...db.all("SELECT id FROM evidence WHERE fact_id = ?", [c]),
    ]
      .map((e) => e.id as number)
      .sort((a, b) => a - b);
    expect(readInsight(db, key(x, y))?.evidenceIds).toEqual(used);
  });

  it("takes the earliest target and the latest completion across the members", () => {
    const [x, xPrime, y, yPrime] = [item("X"), item("X′"), item("Y"), item("Y′")] as const;
    fact(x, TARGET_DATE, "2026-12-20", "s-t1");
    fact(xPrime, TARGET_DATE, "2026-12-05", "s-t2");
    dependsOn(x, y, "s-dep");
    fact(y, COMPLETION_DATE, "2026-12-08", "s-c1");
    fact(yPrime, COMPLETION_DATE, "2026-12-12", "s-c2");
    line(xPrime, x);
    line(yPrime, y);
    recomputeDependencyDelay(db, [x]);
    const summary = readInsight(db, key(x, y))?.summary ?? "";
    expect(summary).toContain("2026-12-12");
    expect(summary).toContain("2026-12-05");
    expect(summary).not.toContain("2026-12-20");
    expect(summary).not.toContain("2026-12-08");
  });

  it("skips a pair whose two ends are one group: the stored row is resolved and no (X, X) row is made", () => {
    const { x, y } = lateThroughMember();
    line(db.all("SELECT id FROM items WHERE name = 'Y′'")[0]?.id as number, y);
    recomputeDependencyDelay(db, [x]);
    expect(rows()).toEqual([{ x_item_id: x, y_item_id: y, state: "active" }]);
    line(y, x);
    expect(recomputeDependencyDelay(db, [x])).toEqual([{ key: key(x, y), outcome: "resolved" }]);
    expect(rows()).toEqual([{ x_item_id: x, y_item_id: y, state: "resolved" }]);
  });

  it("does not read a resting line: the members are judged alone", () => {
    const { x, y, yPrime } = lateThroughMember();
    line(yPrime, y, 0);
    expect(recomputeDependencyDelay(db, [x, y, yPrime])).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it("control: with no merge line the outcomes are those of the item-keyed rule", () => {
    const [x, y] = [item("X"), item("Y")] as const;
    fact(x, TARGET_DATE, "2026-12-05", "s-target");
    dependsOn(x, y, "s-dep");
    fact(y, COMPLETION_DATE, "2026-12-10", "s-completion");
    expect(recomputeDependencyDelay(db, [x])).toEqual([{ key: key(x, y), outcome: "created" }]);
    expect(recomputeDependencyDelay(db, [y])).toEqual([{ key: key(x, y), outcome: "unchanged" }]);
  });
});
