// rule.dependency-delay (V02-R9, R10, C1, C3): the deterministic rule and the
// upkeep of its one Insight row per (rule, X, Y).
import { readFileSync } from "node:fs";
import {
  addEvidence,
  insertAssertionLink,
  insertItem,
  listEvidence,
  migrate,
  readChangeSeq,
  readInsight,
  saveInsight,
  readKnowledgeRevision,
  registerConnectorInstance,
  saveFact,
  saveRelation,
  saveSourceRecord,
  type KnowledgeAttributes,
  type KnowledgeStatus,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { setStatusForTest } from "@pki/testkit";
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
let x: number;
let y: number;

beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
  x = insertItem(db, { type: "Project", name: "미리내 프로젝트", ...attrs });
  y = insertItem(db, { type: "System", name: "물결 API", ...attrs });
});

afterEach(() => {
  db.close();
});

/** Stores `body` as the next version of source `externalId`; returns that version's row id. */
function version(externalId: string, body: string): number {
  saveSourceRecord(db, "c1", { externalId, title: externalId, body });
  return db.all(
    `SELECT max(v.id) AS id FROM source_versions v JOIN sources s ON s.id = v.source_id
     WHERE s.external_id = ?`,
    [externalId],
  )[0]?.id as number;
}

/** A fact or relation row with one evidence quoting the whole body of a new source version. */
function fact(itemId: number, kind: string, value: string, externalId = `${kind}-${itemId}`) {
  const id = saveFact(db, { itemId, kind, value, ...attrs }).id;
  const body = `${kind} ${value}`;
  const sourceVersionId = version(externalId, body);
  addEvidence(db, {
    target: { factId: id },
    sourceVersionId,
    start: 0,
    end: body.length,
    quote: body,
  });
  return id;
}
function dependsOn(subjectId: number, objectId: number, externalId = "wiki") {
  const id = saveRelation(db, { subjectId, type: DEPENDS_ON, objectId, ...attrs }).id;
  const body = `${subjectId} depends on ${objectId}`;
  const sourceVersionId = version(externalId, body);
  addEvidence(db, {
    target: { relationId: id },
    sourceVersionId,
    start: 0,
    end: body.length,
    quote: body,
  });
  return id;
}

const key = () => ({ rule: DEPENDENCY_DELAY, xItemId: x, yItemId: y });
const currentEvidence = (target: { factId: number } | { relationId: number }) =>
  listEvidence(db, target)
    .filter((e) => e.current)
    .map((e) => e.id);
const insightCount = () => db.all("SELECT count(*) AS n FROM insights")[0]?.n;
/** Every row change on this connection, so a no-op is measurable (Insight rows raise no counter). */
const totalChanges = () => db.all("SELECT total_changes() AS n")[0]?.n;

describe("rule.dependency-delay — date cases (V02-R9)", () => {
  it("creates an inference with the three rows' current evidence when Y is later", () => {
    const t = fact(x, TARGET_DATE, "2026-12-05");
    const r = dependsOn(x, y);
    const c = fact(y, COMPLETION_DATE, "2026-12-10");
    expect(recomputeDependencyDelay(db, [x])).toEqual([{ key: key(), outcome: "created" }]);
    const insight = readInsight(db, key());
    expect(insight).toMatchObject({ epistemic: "inferred", state: "active" });
    expect(insight?.summary).toContain("2026-12-05");
    expect(insight?.summary).toContain("2026-12-10");
    expect(insight?.evidenceIds).toEqual(
      [
        ...currentEvidence({ factId: t }),
        ...currentEvidence({ relationId: r }),
        ...currentEvidence({ factId: c }),
      ].sort((a, b) => a - b),
    );
    expect(insight?.evidenceIds).toHaveLength(3);
  });

  it.each([
    ["equal", "2026-12-05"],
    ["earlier (이른 날짜)", "2026-12-03"],
    ["earlier by a year", "2025-12-10"],
  ])("creates nothing when Y's date is %s", (_case, completion) => {
    fact(x, TARGET_DATE, "2026-12-05");
    dependsOn(x, y);
    fact(y, COMPLETION_DATE, completion);
    expect(recomputeDependencyDelay(db, [x, y])).toEqual([]);
    expect(insightCount()).toBe(0);
  });

  it("compares calendar dates, not the later day-of-month across a year", () => {
    fact(x, TARGET_DATE, "2026-12-31");
    dependsOn(x, y);
    fact(y, COMPLETION_DATE, "2027-01-01");
    expect(recomputeDependencyDelay(db, [y])).toEqual([{ key: key(), outcome: "created" }]);
  });

  it("creates nothing without a dependency, or with the dependency reversed", () => {
    fact(x, TARGET_DATE, "2026-12-05");
    fact(y, COMPLETION_DATE, "2026-12-10");
    expect(recomputeDependencyDelay(db, [x, y])).toEqual([]);
    dependsOn(y, x);
    expect(recomputeDependencyDelay(db, [x, y])).toEqual([]);
    expect(insightCount()).toBe(0);
  });

  it("creates nothing when a date is missing or not a calendar date", () => {
    fact(x, TARGET_DATE, "2026-12-05");
    dependsOn(x, y);
    expect(recomputeDependencyDelay(db, [x])).toEqual([]);
    fact(y, COMPLETION_DATE, "2026-13-01", "bad-0");
    fact(y, COMPLETION_DATE, "12월 10일", "bad-1");
    fact(y, COMPLETION_DATE, "2026-02-30", "bad-2");
    fact(y, COMPLETION_DATE, "2026-12-10T09:00", "bad-3");
    expect(recomputeDependencyDelay(db, [x])).toEqual([]);
    expect(insightCount()).toBe(0);
  });

  it("does not read an impossible date as the next day", () => {
    fact(x, TARGET_DATE, "2026-11-30");
    dependsOn(x, y);
    fact(y, COMPLETION_DATE, "2026-11-31"); // Date.parse rolls it over to 2026-12-01
    expect(recomputeDependencyDelay(db, [x])).toEqual([]);
    fact(y, COMPLETION_DATE, "2026-12-01", "msg-real");
    expect(recomputeDependencyDelay(db, [x])).toEqual([{ key: key(), outcome: "created" }]);
  });

  it("skips a self-dependency (잠정)", () => {
    fact(x, TARGET_DATE, "2026-12-05");
    fact(x, COMPLETION_DATE, "2026-12-10");
    dependsOn(x, x);
    expect(recomputeDependencyDelay(db, [x])).toEqual([]);
    expect(insightCount()).toBe(0);
  });

  it("takes any number of item ids", () => {
    fact(x, TARGET_DATE, "2026-12-05");
    dependsOn(x, y);
    fact(y, COMPLETION_DATE, "2026-12-10");
    const many = [...Array.from({ length: 40_000 }, (_, i) => i + 1000), y, y];
    expect(recomputeDependencyDelay(db, many)).toEqual([{ key: key(), outcome: "created" }]);
  });

  it("lets the earliest valid target and latest valid completion decide, citing those rows", () => {
    const early = fact(x, TARGET_DATE, "2026-12-01", "mail-1");
    fact(x, TARGET_DATE, "2026-12-20", "mail-2");
    const r = dependsOn(x, y);
    fact(y, COMPLETION_DATE, "2026-11-30", "msg-1");
    const late = fact(y, COMPLETION_DATE, "2026-12-10", "msg-2");
    expect(recomputeDependencyDelay(db, [x])).toEqual([{ key: key(), outcome: "created" }]);
    expect(readInsight(db, key())?.evidenceIds).toEqual(
      [
        ...currentEvidence({ factId: early }),
        ...currentEvidence({ relationId: r }),
        ...currentEvidence({ factId: late }),
      ].sort((a, b) => a - b),
    );
  });

  it("ignores another relation type and another fact kind", () => {
    fact(x, TARGET_DATE, "2026-12-05");
    fact(y, "start_date", "2026-12-10");
    saveRelation(db, { subjectId: x, type: "RELATED_TO", objectId: y, ...attrs });
    expect(recomputeDependencyDelay(db, [x, y])).toEqual([]);
  });
});

describe("rule.dependency-delay — validity (V02-R9)", () => {
  const rows = () => {
    const t = fact(x, TARGET_DATE, "2026-12-05");
    const r = dependsOn(x, y);
    const c = fact(y, COMPLETION_DATE, "2026-12-10");
    return { fact: [t, c], relation: [r] } as const;
  };

  it.each([
    ["target fact", "fact", 0],
    ["relation", "relation", 0],
    ["completion fact", "fact", 1],
  ] as const)("creates nothing when the %s is superseded or rejected", (_n, kind, index) => {
    const ids = rows();
    for (const status of ["superseded", "rejected"] as KnowledgeStatus[]) {
      setStatusForTest(db, kind, ids[kind][index] as number, status);
      expect(recomputeDependencyDelay(db, [x, y])).toEqual([]);
    }
    expect(insightCount()).toBe(0);
  });

  it.each(["candidate", "verified", "disputed"] as KnowledgeStatus[])(
    "counts a %s row as valid",
    (status) => {
      const ids = rows();
      setStatusForTest(db, "relation", ids.relation[0], status);
      setStatusForTest(db, "fact", ids.fact[0], status);
      expect(recomputeDependencyDelay(db, [x])).toEqual([{ key: key(), outcome: "created" }]);
    },
  );

  it("creates nothing when a row has no evidence at all", () => {
    fact(x, TARGET_DATE, "2026-12-05");
    fact(y, COMPLETION_DATE, "2026-12-10");
    saveRelation(db, { subjectId: x, type: DEPENDS_ON, objectId: y, ...attrs });
    expect(recomputeDependencyDelay(db, [x])).toEqual([]);
  });

  it("creates nothing when a row has only past evidence", () => {
    fact(x, TARGET_DATE, "2026-12-05", "mail");
    dependsOn(x, y);
    fact(y, COMPLETION_DATE, "2026-12-10");
    version("mail", "a newer version that no longer states the target date");
    expect(recomputeDependencyDelay(db, [x])).toEqual([]);
  });

  it("ignores a superseded earlier target even beside a valid later one", () => {
    const early = fact(x, TARGET_DATE, "2026-12-01");
    fact(x, TARGET_DATE, "2026-12-20");
    dependsOn(x, y);
    fact(y, COMPLETION_DATE, "2026-12-10");
    setStatusForTest(db, "fact", early, "superseded");
    expect(recomputeDependencyDelay(db, [x])).toEqual([]);
  });
});

describe("conflict.rule ⑨: the rule reads supersession (S02-R19)", () => {
  /** x has two targets, the later-starting 12-05 superseding 12-01; y completes 12-10. */
  function superseded() {
    const old = fact(x, TARGET_DATE, "2026-12-01", "old-source");
    const next = fact(x, TARGET_DATE, "2026-12-05", "new-source");
    dependsOn(x, y);
    fact(y, COMPLETION_DATE, "2026-12-10");
    const link = insertAssertionLink(db, {
      type: "SUPERSEDES",
      fromFactId: next,
      toFactId: old,
      createdBy: "rule",
      at: "2026-11-23T00:00:00.000Z",
    }).id;
    return { old, next, link };
  }

  it("leaves a superseded target date out, and the Insight names the link in insight_link_inputs", () => {
    const { old, link } = superseded();
    recomputeDependencyDelay(db, [x]);
    const insight = readInsight(db, key());
    expect(insight).toMatchObject({ state: "active", linkIds: [link] });
    expect(insight?.summary).toContain("2026-12-05");
    expect(insight?.summary).not.toContain("2026-12-01");
    expect(insight?.evidenceIds).not.toContain(currentEvidence({ factId: old })[0]);
  });

  it("makes no Insight when the superseding fact's source cannot be put with the others (the link's lineage joins the judgement)", () => {
    const { old } = superseded();
    const oldSource = db.all(
      "SELECT source_id FROM source_versions WHERE id = (SELECT source_version_id FROM evidence WHERE fact_id = ?)",
      [old],
    )[0]?.source_id as number;
    // the policy refuses any set that holds the superseded fact's source: only the link carries it
    const scope = {
      combinable: (lineage: readonly { sourceId: number }[]) =>
        !lineage.some((v) => v.sourceId === oldSource),
    };
    expect(recomputeDependencyDelay(db, [x], scope)).toEqual([]);
    expect(insightCount()).toBe(0);
  });
});

describe("rule.dependency-delay — upkeep (V02-R10)", () => {
  let t: number;
  let r: number;
  let c: number;
  beforeEach(() => {
    t = fact(x, TARGET_DATE, "2026-12-05");
    r = dependsOn(x, y);
    c = fact(y, COMPLETION_DATE, "2026-12-10", "messenger");
    recomputeDependencyDelay(db, [x]);
  });

  it("changes nothing when the condition and evidence are unchanged", () => {
    const before = {
      insight: readInsight(db, key()),
      changes: totalChanges(),
      changeSeq: readChangeSeq(db),
      revision: readKnowledgeRevision(db),
    };
    expect(recomputeDependencyDelay(db, [x, y])).toEqual([{ key: key(), outcome: "unchanged" }]);
    expect({
      insight: readInsight(db, key()),
      changes: totalChanges(),
      changeSeq: readChangeSeq(db),
      revision: readKnowledgeRevision(db),
    }).toEqual(before);
    expect(insightCount()).toBe(1);
  });

  it("stays a no-op when newer evidence is not in t, r, c id order", () => {
    const body = "미리내 목표일 재확인: 2026-12-05";
    addEvidence(db, {
      target: { factId: t },
      sourceVersionId: version("late-mail", body),
      start: 0,
      end: body.length,
      quote: body,
    });
    expect(recomputeDependencyDelay(db, [x])).toEqual([{ key: key(), outcome: "updated" }]);
    const changes = totalChanges();
    expect(recomputeDependencyDelay(db, [x])).toEqual([{ key: key(), outcome: "unchanged" }]);
    expect(totalChanges()).toBe(changes);
  });

  it("updates the same row when an item's name changes", () => {
    const id = readInsight(db, key())?.id;
    db.run("UPDATE items SET name = '은하수 API' WHERE id = ?", [y]);
    expect(recomputeDependencyDelay(db, [y])).toEqual([{ key: key(), outcome: "updated" }]);
    expect(readInsight(db, key())).toMatchObject({ id, state: "active" });
    expect(readInsight(db, key())?.summary).toContain("은하수 API");
  });

  it("updates the same row when the evidence changes", () => {
    const id = readInsight(db, key())?.id;
    const body = "물결 API 일정 재공지: 2026-12-10";
    const added = addEvidence(db, {
      target: { factId: c },
      sourceVersionId: version("notice", body),
      start: 0,
      end: body.length,
      quote: body,
    });
    expect(recomputeDependencyDelay(db, [y])).toEqual([{ key: key(), outcome: "updated" }]);
    const insight = readInsight(db, key());
    expect(insight?.id).toBe(id);
    expect(insight?.evidenceIds).toContain(added);
    expect(insight?.evidenceIds).toHaveLength(4);
    expect(insightCount()).toBe(1);
  });

  it("updates the same row when the later date changes", () => {
    const id = readInsight(db, key())?.id;
    setStatusForTest(db, "fact", c, "superseded");
    fact(y, COMPLETION_DATE, "2026-12-12", "messenger-2");
    expect(recomputeDependencyDelay(db, [y])).toEqual([{ key: key(), outcome: "updated" }]);
    expect(readInsight(db, key())).toMatchObject({ id, state: "active" });
    expect(readInsight(db, key())?.summary).toContain("2026-12-12");
  });

  it("resolves when the condition breaks, clearing summary and evidence but keeping the row", () => {
    const id = readInsight(db, key())?.id;
    setStatusForTest(db, "fact", c, "superseded");
    fact(y, COMPLETION_DATE, "2026-12-03", "messenger-2");
    expect(recomputeDependencyDelay(db, [y])).toEqual([{ key: key(), outcome: "resolved" }]);
    expect(readInsight(db, key())).toEqual({
      id,
      ...key(),
      epistemic: "inferred",
      state: "resolved",
      summary: null,
      evidenceIds: [],
      userInputs: [],
      linkIds: [],
    });
    expect(db.all("SELECT count(*) AS n FROM insight_evidence")).toEqual([{ n: 0 }]);
  });

  it("resolves when the evidence runs out (only past evidence left)", () => {
    version("messenger", "a newer version without the completion date");
    expect(recomputeDependencyDelay(db, [y])).toEqual([{ key: key(), outcome: "resolved" }]);
    expect(readInsight(db, key())).toMatchObject({ state: "resolved", summary: null });
  });

  it("resolves when the dependency is rejected", () => {
    setStatusForTest(db, "relation", r, "rejected");
    expect(recomputeDependencyDelay(db, [x])).toEqual([{ key: key(), outcome: "resolved" }]);
    const changes = totalChanges();
    expect(recomputeDependencyDelay(db, [x])).toEqual([{ key: key(), outcome: "unchanged" }]);
    expect(totalChanges()).toBe(changes);
  });

  it("resolves when the dependency row is deleted, found only through the Insight row", () => {
    // V02-R12 deletes a relation with no evidence left; X and Y keep their facts
    db.run("DELETE FROM relations WHERE id = ?", [r]);
    expect(readInsight(db, key())?.state).toBe("active");
    expect(recomputeDependencyDelay(db, [x, y])).toEqual([{ key: key(), outcome: "resolved" }]);
    expect(readInsight(db, key())).toMatchObject({ state: "resolved", summary: null });
  });

  it("does not let another relation type on the same pair stand in for the dependency", () => {
    const body = "미리내 프로젝트와 물결 API는 관련된다";
    const other = saveRelation(db, { subjectId: x, type: "RELATED_TO", objectId: y, ...attrs }).id;
    addEvidence(db, {
      target: { relationId: other },
      sourceVersionId: version("wiki-related", body),
      start: 0,
      end: body.length,
      quote: body,
    });
    db.run("DELETE FROM relations WHERE id = ?", [r]);
    expect(recomputeDependencyDelay(db, [x])).toEqual([{ key: key(), outcome: "resolved" }]);
  });

  it("revives the same row when the condition holds again", () => {
    const id = readInsight(db, key())?.id;
    // a newer row, so a deleted-and-reinserted row could not get the same id back
    saveInsight(db, { ...key(), rule: "spacer" }, { state: "resolved" });
    setStatusForTest(db, "fact", c, "superseded");
    recomputeDependencyDelay(db, [y]);
    const later = fact(y, COMPLETION_DATE, "2026-12-12", "messenger-2");
    expect(recomputeDependencyDelay(db, [y])).toEqual([{ key: key(), outcome: "revived" }]);
    expect(readInsight(db, key())).toMatchObject({ id, state: "active" });
    expect(readInsight(db, key())?.evidenceIds).toEqual(
      [
        ...currentEvidence({ factId: t }),
        ...currentEvidence({ relationId: r }),
        ...currentEvidence({ factId: later }),
      ].sort((a, b) => a - b),
    );
    expect(db.all("SELECT id FROM insights WHERE rule = ?", [DEPENDENCY_DELAY])).toEqual([{ id }]);
  });

  it("rewrites a dirty row as active", () => {
    db.run("UPDATE insights SET state = 'dirty'");
    expect(recomputeDependencyDelay(db, [x])).toEqual([{ key: key(), outcome: "updated" }]);
    expect(readInsight(db, key())?.state).toBe("active");
  });

  it("resolves a dirty row whose condition broke", () => {
    db.run("UPDATE insights SET state = 'dirty'");
    setStatusForTest(db, "fact", c, "rejected");
    expect(recomputeDependencyDelay(db, [y])).toEqual([{ key: key(), outcome: "resolved" }]);
    expect(readInsight(db, key())).toMatchObject({
      state: "resolved",
      summary: null,
      evidenceIds: [],
    });
  });

  it.each(["X", "Y"] as const)("loses the row when the %s item is deleted", (side) => {
    // V02-R12 deletes the facts and relations first; items have no cascade to them
    db.run("DELETE FROM facts");
    db.run("DELETE FROM relations");
    db.run("DELETE FROM items WHERE id = ?", [side === "X" ? x : y]);
    expect(readInsight(db, key())).toBeUndefined();
    expect(recomputeDependencyDelay(db, [x, y])).toEqual([]);
    expect(insightCount()).toBe(0);
  });

  it("is rolled back with the caller's transaction", () => {
    setStatusForTest(db, "relation", r, "rejected");
    expect(() =>
      db.transaction(() => {
        expect(recomputeDependencyDelay(db, [x])).toEqual([{ key: key(), outcome: "resolved" }]);
        expect(readInsight(db, key())?.state).toBe("resolved");
        throw new Error("caller fails after the rule");
      }),
    ).toThrow("caller fails");
    expect(readInsight(db, key())?.state).toBe("active");
  });

  it("writes nothing when a standalone call fails part-way", () => {
    const z = insertItem(db, { type: "System", name: "누리 API", ...attrs });
    dependsOn(x, z, "wiki-z");
    fact(z, COMPLETION_DATE, "2026-12-10", "messenger-z");
    db.run("UPDATE insights SET state = 'dirty'");
    db.exec(`CREATE TRIGGER fail_z BEFORE INSERT ON insights WHEN NEW.y_item_id = ${z}
             BEGIN SELECT RAISE(ABORT, 'fail z'); END`);
    expect(() => recomputeDependencyDelay(db, [x])).toThrow("fail z");
    expect(readInsight(db, key())?.state).toBe("dirty");
    expect(insightCount()).toBe(1);
  });

  it("writes nothing for items with no dependency", () => {
    const z = insertItem(db, { type: "Project", name: "Z", ...attrs });
    const changes = totalChanges();
    expect(recomputeDependencyDelay(db, [z])).toEqual([]);
    expect(recomputeDependencyDelay(db, [])).toEqual([]);
    expect(totalChanges()).toBe(changes);
  });
});

describe("rule.dependency-delay — fixtures (V02-C1)", () => {
  interface Evidence {
    record_id: string;
    span: [number, number];
    quote: string;
  }
  interface Expected {
    rule: string;
    sets: Record<
      string,
      {
        files: string[];
        facts: { entity: "A" | "B"; attribute: string; value: string; evidence: Evidence }[];
        relations: { subject: "A" | "B"; type: string; object: "A" | "B"; evidence: Evidence }[];
        insights: { rule: string; x: "A" | "B"; y: "A" | "B"; evidence: Evidence[] }[];
      }
    >;
  }
  const fixture = (name: string) =>
    readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), "utf8");
  const expected = JSON.parse(fixture("v02-expected.json")) as Expected;

  it("uses the fixture vocabulary", () => {
    expect(expected.rule).toBe(DEPENDENCY_DELAY);
    const plain = expected.sets.plain;
    expect(plain?.facts.map((f) => f.attribute)).toEqual([TARGET_DATE, COMPLETION_DATE]);
    expect(plain?.relations.map((r) => r.type)).toEqual([DEPENDS_ON]);
  });

  it.each(Object.keys(expected.sets))("reaches the expected Insights for the %s set", (name) => {
    const set = expected.sets[name] as Expected["sets"][string];
    const versionOf = new Map<string, number>();
    for (const file of set.files) {
      for (const line of fixture(file).split("\n").filter(Boolean)) {
        const record = JSON.parse(line) as { id: string; content: string };
        versionOf.set(record.id, version(record.id, record.content));
      }
    }
    const item = { A: x, B: y };
    const evidenceOf = (e: Evidence) => ({
      sourceVersionId: versionOf.get(e.record_id) as number,
      start: e.span[0],
      end: e.span[1],
      quote: e.quote,
    });
    const quoteOf = new Map<number, string>();
    for (const f of set.facts) {
      const factId = saveFact(db, {
        itemId: item[f.entity],
        kind: f.attribute,
        value: f.value,
        ...attrs,
      }).id;
      quoteOf.set(
        addEvidence(db, { target: { factId }, ...evidenceOf(f.evidence) }),
        f.evidence.quote,
      );
    }
    for (const r of set.relations) {
      const relationId = saveRelation(db, {
        subjectId: item[r.subject],
        type: r.type,
        objectId: item[r.object],
        ...attrs,
      }).id;
      quoteOf.set(
        addEvidence(db, { target: { relationId }, ...evidenceOf(r.evidence) }),
        r.evidence.quote,
      );
    }

    recomputeDependencyDelay(db, [x, y]);
    const stored = db.all("SELECT rule, x_item_id, y_item_id, epistemic FROM insights");
    expect(stored).toEqual(
      set.insights.map((i) => ({
        rule: i.rule,
        x_item_id: item[i.x],
        y_item_id: item[i.y],
        epistemic: "inferred",
      })),
    );
    for (const i of set.insights) {
      const insight = readInsight(db, { rule: i.rule, xItemId: item[i.x], yItemId: item[i.y] });
      expect(insight?.evidenceIds.map((id) => quoteOf.get(id)).sort()).toEqual(
        i.evidence.map((e) => e.quote).sort(),
      );
    }
  });
});
