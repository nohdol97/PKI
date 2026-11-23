// V02-R3 knowledge storage: items, facts and relations with their epistemic type,
// status and two times; evidence spans counted in code points over an immutable
// source version; the knowledge revision that rises with every knowledge change.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import {
  addEvidence,
  insertItem,
  listEvidence,
  readFact,
  readItem,
  readRelation,
  saveFact,
  saveRelation,
  type KnowledgeAttributes,
} from "./knowledge.ts";
import { migrate } from "./migrations.ts";
import { readKnowledgeRevision } from "./revisions.ts";
import { applyTransition, automatedLifecycle } from "./semantic-lifecycle.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";
import { memoryDbTemplate } from "@pki/testkit";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);

let db: SqlDriver;

beforeEach(() => {
  db = freshDb();
  registerConnectorInstance(db, "c1", "test-fixtures");
});

afterEach(() => {
  db.close();
});

const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: "2026-12-05",
  observedAt: "2026-11-21T00:00:00Z",
};

/** Stores a version of source `externalId` and returns its id. */
function version(externalId: string, body: string): number {
  saveSourceRecord(db, "c1", { externalId, title: "t", body });
  return db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
}

function item(name: string): number {
  return insertItem(db, { type: "project", name, ...attrs });
}

describe("items", () => {
  it("stores an item with its type, epistemic type, status and both times", () => {
    const id = insertItem(db, {
      type: "system",
      name: "B 시스템",
      epistemic: "hypothesis",
      status: "verified",
      validAt: null,
      observedAt: "2026-11-21T00:00:00Z",
    });
    expect(readItem(db, id)).toEqual({
      id,
      type: "system",
      name: "B 시스템",
      epistemic: "hypothesis",
      status: "verified",
      validAt: null,
      observedAt: "2026-11-21T00:00:00Z",
      confidence: null,
    });
    expect(readItem(db, 404)).toBeUndefined();
  });

  it("rejects an epistemic type or status outside the R3 lists", () => {
    expect(() =>
      insertItem(db, { type: "p", name: "n", ...attrs, epistemic: "fact" as never }),
    ).toThrow(/CHECK/);
    expect(() =>
      insertItem(db, { type: "p", name: "n", ...attrs, status: "active" as never }),
    ).toThrow(/CHECK/);
  });
});

describe("facts and relations", () => {
  it("keeps one row per item, kind and value, so the same fact only gains evidence", () => {
    const a = item("A 프로젝트");
    const first = saveFact(db, { itemId: a, kind: "target-date", value: "2026-12-05", ...attrs });
    expect(first.created).toBe(true);
    const again = saveFact(db, {
      itemId: a,
      kind: "target-date",
      value: "2026-12-05",
      ...attrs,
      epistemic: "inferred",
    });
    expect(again).toEqual({ id: first.id, created: false });
    // the existing row is not rewritten by the second save
    expect(readFact(db, first.id)).toEqual({
      id: first.id,
      itemId: a,
      kind: "target-date",
      value: "2026-12-05",
      ...attrs,
      confidence: null,
      validUntil: null,
    });
    const other = saveFact(db, { itemId: a, kind: "target-date", value: "2026-12-10", ...attrs });
    expect(other.created).toBe(true);
    expect(other.id).not.toBe(first.id);
  });

  it("keeps one row per subject, relation type and object", () => {
    const a = item("A");
    const b = item("B");
    const first = saveRelation(db, { subjectId: a, type: "depends-on", objectId: b, ...attrs });
    expect(saveRelation(db, { subjectId: a, type: "depends-on", objectId: b, ...attrs })).toEqual({
      id: first.id,
      created: false,
    });
    expect(
      saveRelation(db, { subjectId: b, type: "depends-on", objectId: a, ...attrs }).created,
    ).toBe(true);
    expect(readRelation(db, first.id)).toEqual({
      id: first.id,
      subjectId: a,
      type: "depends-on",
      objectId: b,
      ...attrs,
      confidence: null,
      validUntil: null,
    });
  });

  it("requires facts and relations to name stored items", () => {
    expect(() => saveFact(db, { itemId: 404, kind: "k", value: "v", ...attrs })).toThrow(
      /FOREIGN KEY/,
    );
    const a = item("A");
    expect(() =>
      saveRelation(db, { subjectId: a, type: "depends-on", objectId: 404, ...attrs }),
    ).toThrow(/FOREIGN KEY/);
  });

  it("refuses to delete an item while a fact or relation still names it", () => {
    const a = item("A");
    const b = item("B");
    const c = item("C");
    const fact = saveFact(db, { itemId: a, kind: "k", value: "v", ...attrs }).id;
    const relation = saveRelation(db, {
      subjectId: b,
      type: "depends-on",
      objectId: c,
      ...attrs,
    }).id;
    for (const id of [a, b, c]) {
      expect(() => db.run("DELETE FROM items WHERE id = ?", [id])).toThrow(/FOREIGN KEY/);
    }
    expect(readFact(db, fact)).toBeDefined();
    db.run("DELETE FROM facts WHERE id = ?", [fact]);
    db.run("DELETE FROM relations WHERE id = ?", [relation]);
    for (const id of [a, b, c]) db.run("DELETE FROM items WHERE id = ?", [id]);
    expect(db.all("SELECT count(*) AS n FROM items")).toEqual([{ n: 0 }]);
  });

  it("changes the status of an item, fact or relation only through the gate", () => {
    const a = item("A");
    const b = item("B");
    const fact = saveFact(db, { itemId: a, kind: "k", value: "v", ...attrs }).id;
    const relation = saveRelation(db, {
      subjectId: a,
      type: "depends-on",
      objectId: b,
      ...attrs,
    }).id;
    automatedLifecycle.supersede(db, { kind: "fact", id: fact }, { sourceId: 1, version: 1 });
    applyTransition(db, { kind: "relation", id: relation }, "user", "rejected");
    applyTransition(db, { kind: "item", id: b }, "user", "verified");
    applyTransition(db, { kind: "item", id: b }, "user", "disputed");
    expect(readFact(db, fact)?.status).toBe("superseded");
    expect(readRelation(db, relation)?.status).toBe("rejected");
    expect(readItem(db, b)?.status).toBe("disputed");
    expect(() => db.run("UPDATE facts SET status = 'verified' WHERE id = ?", [fact])).toThrow(
      /lifecycle gate/,
    );
  });

  it("takes a row inserted at any status, epistemic type and confidence (an INSERT is not gated)", () => {
    const id = insertItem(db, {
      type: "p",
      name: "n",
      ...attrs,
      status: "verified",
      epistemic: "user-approved",
    });
    expect(readItem(db, id)).toMatchObject({ status: "verified", epistemic: "user-approved" });
  });
});

describe("evidence", () => {
  it("counts its span in code points over text with Korean and emoji", () => {
    // "🚀" is one code point but two UTF-16 units, so the two counts diverge after it.
    const body = "메일: 🚀 A 프로젝트 완료 목표는 2026-12-05 🎯 입니다";
    const sv = version("mail-1", body);
    const fact = saveFact(db, {
      itemId: item("A"),
      kind: "target-date",
      value: "2026-12-05",
      ...attrs,
    });
    const quote = "A 프로젝트 완료 목표는 2026-12-05 🎯";
    const utf16Start = body.indexOf(quote);
    const start = Array.from(body.slice(0, utf16Start)).length;
    const end = start + Array.from(quote).length;
    expect(utf16Start).toBe(start + 1);
    expect(end - start).toBe(quote.length - 1);

    const id = addEvidence(db, {
      target: { factId: fact.id },
      sourceVersionId: sv,
      start,
      end,
      quote,
    });
    expect(listEvidence(db, { factId: fact.id })).toEqual([
      { id, target: { factId: fact.id }, sourceVersionId: sv, start, end, quote, current: true },
    ]);
    // UTF-16 offsets do not select the quote in code points and are refused
    expect(() =>
      addEvidence(db, {
        target: { factId: fact.id },
        sourceVersionId: sv,
        start: utf16Start,
        end: utf16Start + quote.length,
        quote,
      }),
    ).toThrow(/does not select/);
  });

  it("refuses a span that is empty, negative, fractional or outside a stored version", () => {
    const sv = version("e", "abcdef");
    const factId = saveFact(db, { itemId: item("A"), kind: "k", value: "v", ...attrs }).id;
    const add = (start: number, end: number, quote: string, sourceVersionId = sv) =>
      addEvidence(db, { target: { factId }, sourceVersionId, start, end, quote });
    expect(() => add(2, 2, "")).toThrow();
    expect(() => add(-1, 1, "a")).toThrow();
    expect(() => add(0.5, 2, "ab")).toThrow(/integer/);
    expect(() => add(4, 8, "ef")).toThrow(/does not select/);
    expect(() => add(0, 1, "a", 404)).toThrow(/source version 404/);
    expect(add(1, 3, "bc")).toBeGreaterThan(0);
  });

  it("records the same span of the same version for a row once", () => {
    const sv = version("e", "abc");
    const factId = saveFact(db, { itemId: item("A"), kind: "k", value: "v", ...attrs }).id;
    const span = { target: { factId }, sourceVersionId: sv, start: 0, end: 1, quote: "a" };
    expect(addEvidence(db, span)).toBe(addEvidence(db, span));
    expect(listEvidence(db, { factId })).toHaveLength(1);
  });

  it("records the same span of the same version for a relation once", () => {
    const sv = version("e", "abc");
    const relationId = saveRelation(db, {
      subjectId: item("A"),
      type: "depends-on",
      objectId: item("B"),
      ...attrs,
    }).id;
    const span = { target: { relationId }, sourceVersionId: sv, start: 0, end: 1, quote: "a" };
    expect(addEvidence(db, span)).toBe(addEvidence(db, span));
    expect(listEvidence(db, { relationId })).toHaveLength(1);
  });

  it("supports a relation and belongs to exactly one fact or relation", () => {
    const sv = version("wiki-1", "A는 B의 API에 의존");
    const a = item("A");
    const relationId = saveRelation(db, {
      subjectId: a,
      type: "depends-on",
      objectId: item("B"),
      ...attrs,
    }).id;
    addEvidence(db, { target: { relationId }, sourceVersionId: sv, start: 0, end: 1, quote: "A" });
    expect(listEvidence(db, { relationId }).map((e) => e.target)).toEqual([{ relationId }]);
    const factId = saveFact(db, { itemId: a, kind: "k", value: "v", ...attrs }).id;
    expect(() =>
      db.run(
        `INSERT INTO evidence (source_version_id, fact_id, relation_id, start_offset, end_offset, quote)
         VALUES (?, ?, ?, 0, 1, 'A')`,
        [sv, factId, relationId],
      ),
    ).toThrow(/CHECK/);
  });

  it("keeps pointing at its version: a newer version makes it past evidence", () => {
    const v1 = version("msg-1", "B API는 12월 10일");
    const factId = saveFact(db, { itemId: item("B"), kind: "k", value: "v", ...attrs }).id;
    const old = addEvidence(db, {
      target: { factId },
      sourceVersionId: v1,
      start: 0,
      end: 5,
      quote: "B API",
    });
    const v2 = version("msg-1", "B API는 12월 3일");
    const fresh = addEvidence(db, {
      target: { factId },
      sourceVersionId: v2,
      start: 0,
      end: 5,
      quote: "B API",
    });
    expect(
      listEvidence(db, { factId }).map(({ id, sourceVersionId, current }) => ({
        id,
        sourceVersionId,
        current,
      })),
    ).toEqual([
      { id: old, sourceVersionId: v1, current: false },
      { id: fresh, sourceVersionId: v2, current: true },
    ]);
    expect(() =>
      db.run("UPDATE evidence SET source_version_id = ? WHERE id = ?", [v2, old]),
    ).toThrow(/immutable/);
  });
});

describe("knowledge revision", () => {
  it("rises with every item, fact and relation change, and not with evidence", () => {
    expect(readKnowledgeRevision(db)).toBe(0);
    const a = item("A");
    const b = item("B");
    expect(readKnowledgeRevision(db)).toBe(2);
    const fact = saveFact(db, { itemId: a, kind: "k", value: "v", ...attrs }).id;
    saveRelation(db, { subjectId: a, type: "depends-on", objectId: b, ...attrs });
    expect(readKnowledgeRevision(db)).toBe(4);
    // the same row again is no change
    saveFact(db, { itemId: a, kind: "k", value: "v", ...attrs });
    expect(readKnowledgeRevision(db)).toBe(4);
    automatedLifecycle.supersede(db, { kind: "fact", id: fact }, { sourceId: 1, version: 1 });
    expect(readKnowledgeRevision(db)).toBe(5);
    const sv = version("e", "abc");
    addEvidence(db, {
      target: { factId: fact },
      sourceVersionId: sv,
      start: 0,
      end: 1,
      quote: "a",
    });
    expect(readKnowledgeRevision(db)).toBe(5);
    db.run("DELETE FROM facts WHERE id = ?", [fact]);
    expect(readKnowledgeRevision(db)).toBe(6);
  });
});

describe("confidence (S01-R10)", () => {
  const epistemics = ["explicit", "user-approved", "inferred", "hypothesis"] as const;
  const values = [null, 0, 0.5, 1] as const;

  it("stores every epistemic type with every confidence unchanged, on items, facts and relations", () => {
    const b = item("B");
    for (const epistemic of epistemics) {
      for (const confidence of values) {
        const k = `${epistemic}-${confidence}`;
        const own = { ...attrs, epistemic, confidence };
        const stored = [
          readItem(db, insertItem(db, { type: "p", name: k, ...own })),
          readFact(db, saveFact(db, { itemId: b, kind: "k", value: k, ...own }).id),
          readRelation(db, saveRelation(db, { subjectId: b, type: k, objectId: b, ...own }).id),
        ];
        for (const row of stored) expect(row).toMatchObject({ epistemic, confidence });
      }
    }
  });

  it("leaves confidence empty when none is given, and refuses a number outside 0..1 or a non-number", () => {
    expect(readItem(db, item("A"))?.confidence).toBeNull();
    const bad = [-0.01, 1.01, Number.POSITIVE_INFINITY, "high"] as never[];
    for (const confidence of bad) {
      expect(() => insertItem(db, { type: "p", name: "x", ...attrs, confidence })).toThrow(/CHECK/);
    }
  });

  it("is not touched by an approval, a rejection or a restore", () => {
    const b = item("B");
    const fact = saveFact(db, { itemId: b, kind: "k", value: "v", ...attrs, confidence: 0.3 }).id;
    const ref = { kind: "fact", id: fact } as const;
    automatedLifecycle.supersede(db, ref, { sourceId: 1, version: 1 });
    automatedLifecycle.evidenceReturned(db, ref, { sourceId: 1, version: 2 });
    applyTransition(db, ref, "user", "verified");
    applyTransition(db, ref, "user", "disputed");
    applyTransition(db, ref, "user", "rejected");
    expect(readFact(db, fact)).toMatchObject({ status: "rejected", confidence: 0.3 });
  });
});

describe("fact context (S01-R3)", () => {
  const contextOf = (id: number) =>
    db.all("SELECT context FROM facts WHERE id = ?", [id])[0]?.context;

  it("writes the tag the caller gives, and none when it gives none", () => {
    const b = item("B");
    const tagged = saveFact(db, {
      itemId: b,
      kind: "definition",
      value: "v1",
      context: "결제",
      ...attrs,
    });
    const plain = saveFact(db, { itemId: b, kind: "definition", value: "v2", ...attrs });
    expect(contextOf(tagged.id)).toBe("결제");
    expect(contextOf(plain.id)).toBeNull();
  });

  it("keeps the first tag and the first confidence when the same row is saved again (written at creation only)", () => {
    const b = item("B");
    const first = saveFact(db, {
      itemId: b,
      kind: "definition",
      value: "v",
      context: "하나",
      ...attrs,
      confidence: 0.2,
    });
    const again = saveFact(db, {
      itemId: b,
      kind: "definition",
      value: "v",
      context: "둘",
      ...attrs,
      confidence: 0.9,
    });
    expect(again).toEqual({ id: first.id, created: false });
    expect(contextOf(first.id)).toBe("하나");
    expect(readFact(db, first.id)?.confidence).toBe(0.2);
  });
});
