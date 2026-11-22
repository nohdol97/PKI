// S01-T04 `correction.effective` (S01-R15, R22; engine level): the rule "의존 업무 지연" reads the
// user's corrections. A row the user wrote, and a row the user approved with no current evidence, count
// as valid input; a rejected row feeds nothing; the lineage of such a row joins the Insight's lineage
// and the `combinable` judgement (a policy that cannot put the row's source with the others makes no
// Insight); `insight_user_inputs` ties the Insight to those rows and goes with the Insight. The user's
// rows come from the real user entry. The HTTP side (an action recomputes, the evidence API's marker)
// is backend/src/correction-effective.test.ts. All data is synthetic.
import {
  addEvidence,
  automatedLifecycle,
  createDerivativeRegistry,
  defaultScopePolicy,
  insertItem,
  listInsightKeys,
  migrate,
  readInsight,
  registerConnectorInstance,
  saveFact,
  saveRelation,
  saveSourceRecord,
  userDecisions,
  type EntryRef,
  type KnowledgeAttributes,
  type ScopePolicy,
  type SourceVersionRef,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { seedLegacyTombstone } from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CANONICAL_KINDS, propagateCanonical } from "./canonical-kinds.ts";
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
  observedAt: "2026-11-22T00:00:00Z",
};

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c", "test-fixtures");
});
afterEach(() => db.close());

/** A source with a `v1` (the evidence is quoted from it) and, when asked, a `v2` that makes v1 past. */
function source(externalId: string, newer = false) {
  const first = saveSourceRecord(db, "c", {
    externalId,
    title: externalId,
    body: `${externalId} 하나`,
  });
  if (first.status !== "created") throw new Error("source");
  const v1 = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
  if (newer) {
    saveSourceRecord(db, "c", { externalId, title: externalId, body: `${externalId} 둘` });
  }
  return { sourceId: first.sourceId, v1, version: first.version };
}
type Source = ReturnType<typeof source>;

const cite = (target: { factId: number } | { relationId: number }, s: Source) => {
  const body = db.all("SELECT body FROM source_versions WHERE id = ?", [s.v1])[0]?.body as string;
  return addEvidence(db, {
    target,
    sourceVersionId: s.v1,
    start: 0,
    end: [...body].length,
    quote: body,
  });
};
const item = (name: string) => {
  const id = insertItem(db, { type: "Project", name, ...attrs });
  automatedLifecycle.created(db, { kind: "item", id }, "extraction", null);
  return id;
};
const fact = (itemId: number, kind: string, value: string, from?: Source) => {
  const id = saveFact(db, { itemId, kind, value, ...attrs }).id;
  automatedLifecycle.created(db, { kind: "fact", id }, "extraction", null);
  if (from) cite({ factId: id }, from);
  return id;
};
const relation = (x: number, y: number, from?: Source) => {
  const id = saveRelation(db, { subjectId: x, type: DEPENDS_ON, objectId: y, ...attrs }).id;
  automatedLifecycle.created(db, { kind: "relation", id }, "extraction", null);
  if (from) cite({ relationId: id }, from);
  return id;
};
const add = (entry: Parameters<typeof userDecisions.add>[1]): EntryRef => {
  const r = userDecisions.add(db, entry);
  if (r.status !== "applied") throw new Error(JSON.stringify(r));
  return r.ref;
};

/**
 * A policy by source: `combinable` takes the scopes of the sources, so a source is marked by its
 * access scope. Sources saved with `accessScope` ["secret"] cannot be combined with another scope.
 */
const policy: ScopePolicy = {
  ...defaultScopePolicy,
  combinable: (scopes) => scopes.length < 2 || !scopes.some((s) => s?.includes("secret")),
};
const registry = createDerivativeRegistry({
  kinds: CANONICAL_KINDS,
  policy,
  now: () => "2026-11-23T00:00:00.000Z",
});
const rule = (...items: number[]) =>
  recomputeDependencyDelay(db, items, { combinable: (l) => registry.combinable(db, l) });

const insightOf = (x: number, y: number) =>
  readInsight(db, { rule: DEPENDENCY_DELAY, xItemId: x, yItemId: y });
const inputs = (insightId: number) =>
  db.all(
    "SELECT fact_id, relation_id FROM insight_user_inputs WHERE insight_id = ? ORDER BY fact_id, relation_id",
    [insightId],
  );

describe("correction.effective: the rule reads the user's corrections", () => {
  it("a user-written later completion date makes the Insight, an earlier one (by a fix) resolves it, an undo goes back", () => {
    const a = source("a");
    const b = source("b");
    const x = item("X");
    const y = item("Y");
    fact(x, TARGET_DATE, "2026-12-10", a);
    relation(x, y, a);
    const early = fact(y, COMPLETION_DATE, "2026-12-05", b);
    rule(x, y);
    expect(insightOf(x, y)).toBeUndefined(); // 12-05 is not after 12-10

    const fixed = userDecisions.replaceValue(db, { kind: "fact", id: early }, "2026-12-20");
    if (fixed.status !== "applied") throw new Error("fix");
    rule(x, y);
    const made = insightOf(x, y);
    expect(made?.state).toBe("active");
    expect(made?.summary).toContain("2026-12-20");
    // the user's row is shown as the user's, not as a source span: the link table holds it, evidence does not
    expect(inputs(made?.id as number)).toEqual([{ fact_id: fixed.added.id, relation_id: null }]);
    expect(made?.evidenceIds).toHaveLength(2); // the target date's and the relation's

    // fixing it to an earlier date: the user's row of 12-20 is superseded, the new row is earlier
    const earlier = userDecisions.replaceValue(db, fixed.added, "2026-12-01");
    if (earlier.status !== "applied") throw new Error("fix again");
    rule(x, y);
    expect(insightOf(x, y)?.state).toBe("resolved");
    expect(inputs(made?.id as number)).toEqual([]);

    // undoing it brings the 12-20 row back, and with it the Insight
    expect(userDecisions.undo(db, earlier.added).status).toBe("removed"); // the fix's new row goes, the old one is back
    rule(x, y);
    expect(insightOf(x, y)?.state).toBe("active");
    expect(inputs(made?.id as number)).toEqual([{ fact_id: fixed.added.id, relation_id: null }]);
  });

  it("a fact the user rejected no longer feeds the rule, and the undo feeds it again", () => {
    const a = source("a");
    const x = item("X");
    const y = item("Y");
    fact(x, TARGET_DATE, "2026-12-10", a);
    relation(x, y, a);
    const late = fact(y, COMPLETION_DATE, "2026-12-20", a);
    rule(x, y);
    expect(insightOf(x, y)?.state).toBe("active");
    userDecisions.decide(db, { kind: "fact", id: late }, "reject");
    rule(x, y);
    expect(insightOf(x, y)?.state).toBe("resolved");
    userDecisions.undo(db, { kind: "fact", id: late });
    rule(x, y);
    expect(insightOf(x, y)?.state).toBe("active");
  });

  it("a row approved with no current evidence is valid input, and is tied to the Insight", () => {
    const a = source("a");
    const b = source("b", true); // b has a newer version: its evidence is past
    const x = item("X");
    const y = item("Y");
    fact(x, TARGET_DATE, "2026-12-10", a);
    relation(x, y, a);
    const old = fact(y, COMPLETION_DATE, "2026-12-20", b);
    // its value is not valid before the approval: no current evidence
    rule(x, y);
    expect(insightOf(x, y)).toBeUndefined();

    userDecisions.decide(db, { kind: "fact", id: old }, "approve");
    rule(x, y);
    const made = insightOf(x, y);
    expect(made?.state).toBe("active");
    expect(inputs(made?.id as number)).toEqual([{ fact_id: old, relation_id: null }]);
    // its past evidence is not cited as the Insight's evidence
    expect(made?.evidenceIds).toHaveLength(2);

    // cancelling the approval: no current evidence and no approval stands
    userDecisions.undo(db, { kind: "fact", id: old });
    rule(x, y);
    expect(insightOf(x, y)?.state).toBe("resolved");
  });

  it("a row approved WITH current evidence is cited by its evidence, not tied as a user input", () => {
    const a = source("a");
    const x = item("X");
    const y = item("Y");
    fact(x, TARGET_DATE, "2026-12-10", a);
    relation(x, y, a);
    const late = fact(y, COMPLETION_DATE, "2026-12-20", a);
    userDecisions.decide(db, { kind: "fact", id: late }, "approve");
    rule(x, y);
    const made = insightOf(x, y);
    expect(made?.evidenceIds).toHaveLength(3);
    expect(inputs(made?.id as number)).toEqual([]);
  });

  it("a relation the user wrote counts as the dependency", () => {
    const a = source("a");
    const x = item("X");
    const y = item("Y");
    fact(x, TARGET_DATE, "2026-12-10", a);
    fact(y, COMPLETION_DATE, "2026-12-20", a);
    const written = add({ kind: "relation", subjectId: x, type: DEPENDS_ON, objectId: y });
    rule(x, y);
    const made = insightOf(x, y);
    expect(made?.state).toBe("active");
    expect(inputs(made?.id as number)).toEqual([{ fact_id: null, relation_id: written.id }]);
    expect(made?.evidenceIds).toHaveLength(2);
  });

  it("a user-written row with an extraction's evidence on it is a user input and its evidence is not cited", () => {
    const a = source("a");
    const x = item("X");
    const y = item("Y");
    fact(x, TARGET_DATE, "2026-12-10", a);
    relation(x, y, a);
    const written = add({
      kind: "fact",
      itemId: y,
      factKind: COMPLETION_DATE,
      value: "2026-12-20",
    });
    cite({ factId: written.id }, a);
    rule(x, y);
    const made = insightOf(x, y);
    expect(inputs(made?.id as number)).toEqual([{ fact_id: written.id, relation_id: null }]);
    expect(made?.evidenceIds).toHaveLength(2);
  });
});

describe("correction.effective: the lineage of a user's row", () => {
  const lineageOf = (id: number) =>
    registry
      .lineage(db, { kind: "insight", id: String(id) })
      .map((v: SourceVersionRef) => v.sourceId)
      .sort((p: number, q: number) => p - q);

  it("joins the Insight's lineage: a user-written row on an item brings the item's sources", () => {
    const a = source("a");
    const c = source("c");
    const x = item("X");
    const y = item("Y");
    fact(x, TARGET_DATE, "2026-12-10", a);
    relation(x, y, a);
    fact(y, "memo", "메모", c); // Y's only source is c
    add({ kind: "fact", itemId: y, factKind: COMPLETION_DATE, value: "2026-12-20" });
    rule(x, y);
    const made = insightOf(x, y);
    expect(made?.state).toBe("active");
    expect(lineageOf(made?.id as number)).toEqual([a.sourceId, c.sourceId]);
  });

  it("a policy that cannot combine the user's row's source with the others makes no Insight", () => {
    const a = source("a");
    const c = (() => {
      const saved = saveSourceRecord(db, "c", {
        externalId: "secret-doc",
        title: "s",
        body: "비밀 본문",
        accessScope: ["secret"],
      });
      if (saved.status !== "created") throw new Error("source");
      return {
        sourceId: saved.sourceId,
        v1: db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number,
        version: saved.version,
      };
    })();
    const x = item("X");
    const y = item("Y");
    fact(x, TARGET_DATE, "2026-12-10", a);
    relation(x, y, a);
    fact(y, "memo", "메모", c);
    add({ kind: "fact", itemId: y, factKind: COMPLETION_DATE, value: "2026-12-20" });
    rule(x, y);
    // the evidence cited is `a`'s alone, which the policy would allow; the user's row brings `c`
    expect(insightOf(x, y)).toBeUndefined();
  });

  it("an approved row without current evidence brings its own (past) evidence's sources", () => {
    const a = source("a");
    const b = source("b", true);
    const x = item("X");
    const y = item("Y");
    fact(x, TARGET_DATE, "2026-12-10", a);
    relation(x, y, a);
    const old = fact(y, COMPLETION_DATE, "2026-12-20", b);
    userDecisions.decide(db, { kind: "fact", id: old }, "approve");
    rule(x, y);
    const made = insightOf(x, y);
    expect(lineageOf(made?.id as number)).toEqual([a.sourceId, b.sourceId]);
  });

  it("a policy that cannot combine an approved row's past source with the others makes no Insight", () => {
    const a = source("a");
    const saved = saveSourceRecord(db, "c", {
      externalId: "secret-doc",
      title: "s",
      body: "비밀 하나",
      accessScope: ["secret"],
    });
    if (saved.status !== "created") throw new Error("source");
    const v1 = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
    saveSourceRecord(db, "c", {
      externalId: "secret-doc",
      title: "s",
      body: "비밀 둘",
      accessScope: ["secret"],
    });
    const x = item("X");
    const y = item("Y");
    fact(x, TARGET_DATE, "2026-12-10", a);
    relation(x, y, a);
    const old = fact(y, COMPLETION_DATE, "2026-12-20", {
      sourceId: saved.sourceId,
      v1,
      version: 1,
    });
    userDecisions.decide(db, { kind: "fact", id: old }, "approve");
    rule(x, y);
    expect(insightOf(x, y)).toBeUndefined();
  });
});

describe("correction.effective: insight_user_inputs goes with the Insight", () => {
  it("is removed when the Insight is deleted (its item deleted by a source's deletion)", () => {
    const a = source("a");
    const x = item("X");
    const y = item("Y");
    fact(x, TARGET_DATE, "2026-12-10", a);
    relation(x, y, a);
    add({ kind: "fact", itemId: y, factKind: COMPLETION_DATE, value: "2026-12-20" });
    fact(y, "memo", "메모", a);
    rule(x, y);
    expect(db.all("SELECT count(*) AS n FROM insight_user_inputs")[0]?.n).toBe(1);
    db.transaction(() => {
      seedLegacyTombstone(db, {
        sourceId: a.sourceId,
        version: 1,
        at: "2026-11-23T00:00:00Z",
        reason: "source-deleted",
      });
      propagateCanonical(db, {
        kind: "source-deleted",
        sourceId: a.sourceId,
        coversVersion: 1,
        lastRevision: null,
      });
    });
    expect(listInsightKeys(db, DEPENDENCY_DELAY, [x, y])).toEqual([]);
    expect(db.all("SELECT count(*) AS n FROM insight_user_inputs")[0]?.n).toBe(0);
  });

  it("is emptied when the Insight is resolved, and written again when it is revived", () => {
    const a = source("a");
    const x = item("X");
    const y = item("Y");
    fact(x, TARGET_DATE, "2026-12-10", a);
    relation(x, y, a);
    const written = add({
      kind: "fact",
      itemId: y,
      factKind: COMPLETION_DATE,
      value: "2026-12-20",
    });
    rule(x, y);
    userDecisions.decide(db, written, "dispute");
    userDecisions.decide(db, written, "reject");
    rule(x, y);
    expect(insightOf(x, y)?.state).toBe("resolved");
    expect(db.all("SELECT count(*) AS n FROM insight_user_inputs")[0]?.n).toBe(0);
  });
});
