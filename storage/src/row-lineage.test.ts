// S01-T04 (S01-R22, R15): the lineage of an item, fact and relation, and how a row stands as a user
// input. A row the user wrote has its item's lineage, a relation the union of its two items', an item
// the user created none; an approved row's own evidence is its lineage. Synthetic data only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import {
  addEvidence,
  insertItem,
  saveFact,
  saveRelation,
  type KnowledgeAttributes,
} from "./knowledge.ts";
import { migrate } from "./migrations.ts";
import { rowLineage, unionOfVersions } from "./row-lineage.ts";
import { automatedLifecycle, userInputKind } from "./semantic-lifecycle.ts";
import { userDecisions } from "./semantic-user.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";

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

function source(externalId: string, versions = 1) {
  let sourceId = 0;
  for (let v = 1; v <= versions; v++) {
    const saved = saveSourceRecord(db, "c", {
      externalId,
      title: externalId,
      body: `${externalId} ${v}`,
    });
    if (saved.status !== "created") throw new Error("source");
    sourceId = saved.sourceId;
  }
  const rows = db.all(
    "SELECT id, version FROM source_versions WHERE source_id = ? ORDER BY version",
    [sourceId],
  );
  return { sourceId, versionId: (v: number) => rows.find((r) => r.version === v)?.id as number };
}
const cite = (target: { factId: number } | { relationId: number }, versionId: number) => {
  const body = db.all("SELECT body FROM source_versions WHERE id = ?", [versionId])[0]
    ?.body as string;
  addEvidence(db, { target, sourceVersionId: versionId, start: 0, end: body.length, quote: body });
};
const extractedItem = (name: string) => {
  const id = insertItem(db, { type: "Project", name, ...attrs });
  automatedLifecycle.created(db, { kind: "item", id }, "extraction", null);
  return id;
};
const extractedFact = (itemId: number, value: string) => {
  const id = saveFact(db, { itemId, kind: "memo", value, ...attrs }).id;
  automatedLifecycle.created(db, { kind: "fact", id }, "extraction", null);
  return id;
};
const sources = (refs: { sourceId: number; version: number }[]) => refs.map((r) => r.sourceId);

describe("rowLineage (S01-R22)", () => {
  it("an extraction's row has the versions its evidence quotes, an item those of every row on it", () => {
    const a = source("a");
    const b = source("b");
    const x = extractedItem("X");
    const y = extractedItem("Y");
    const fx = extractedFact(x, "가");
    cite({ factId: fx }, a.versionId(1));
    const rel = saveRelation(db, { subjectId: x, type: "DEPENDS_ON", objectId: y, ...attrs }).id;
    cite({ relationId: rel }, b.versionId(1));
    expect(sources(rowLineage(db, { kind: "fact", id: fx }))).toEqual([a.sourceId]);
    expect(sources(rowLineage(db, { kind: "relation", id: rel }))).toEqual([b.sourceId]);
    expect(sources(rowLineage(db, { kind: "item", id: x }))).toEqual([a.sourceId, b.sourceId]);
    expect(sources(rowLineage(db, { kind: "item", id: y }))).toEqual([b.sourceId]);
  });

  it("a fact the user wrote has its item's lineage, whatever evidence is on it", () => {
    const a = source("a");
    const c = source("c");
    const x = extractedItem("X");
    cite({ factId: extractedFact(x, "가") }, a.versionId(1));
    const written = userDecisions.add(db, {
      kind: "fact",
      itemId: x,
      factKind: "memo",
      value: "나",
    });
    if (written.status !== "applied") throw new Error("add");
    expect(sources(rowLineage(db, written.ref))).toEqual([a.sourceId]);
    cite({ factId: written.ref.id }, c.versionId(1)); // an extraction found the same value in `c`
    expect(sources(rowLineage(db, written.ref))).toEqual([a.sourceId, c.sourceId]); // c is on the item now
  });

  it("a relation the user wrote has the union of its two items' lineage", () => {
    const a = source("a");
    const b = source("b");
    const x = extractedItem("X");
    const y = extractedItem("Y");
    cite({ factId: extractedFact(x, "가") }, a.versionId(1));
    cite({ factId: extractedFact(y, "나") }, b.versionId(1));
    const written = userDecisions.add(db, {
      kind: "relation",
      subjectId: x,
      type: "DEPENDS_ON",
      objectId: y,
    });
    if (written.status !== "applied") throw new Error("add");
    expect(sources(rowLineage(db, written.ref))).toEqual([a.sourceId, b.sourceId]);
  });

  it("an item the user created has none, whatever extraction attached to it", () => {
    const a = source("a");
    const created = userDecisions.add(db, { kind: "item", type: "Project", name: "내 항목" });
    if (created.status !== "applied") throw new Error("add");
    cite({ factId: extractedFact(created.ref.id, "가") }, a.versionId(1));
    expect(rowLineage(db, created.ref)).toEqual([]);
    // the fact attached keeps its own lineage; the user's relation to an item of `a` brings only that one's
    const x = extractedItem("X");
    cite({ factId: extractedFact(x, "나") }, a.versionId(1));
    const written = userDecisions.add(db, {
      kind: "relation",
      subjectId: created.ref.id,
      type: "DEPENDS_ON",
      objectId: x,
    });
    if (written.status !== "applied") throw new Error("add");
    expect(sources(rowLineage(db, written.ref))).toEqual([a.sourceId]);
  });

  it("is empty for a row that is not stored", () => {
    expect(rowLineage(db, { kind: "fact", id: 99 })).toEqual([]);
    expect(rowLineage(db, { kind: "relation", id: 99 })).toEqual([]);
  });

  it("unionOfVersions lists each version once, in order", () => {
    expect(
      unionOfVersions(
        [{ sourceId: 2, version: 1 }],
        [
          { sourceId: 1, version: 2 },
          { sourceId: 2, version: 1 },
          { sourceId: 1, version: 1 },
        ],
      ),
    ).toEqual([
      { sourceId: 1, version: 1 },
      { sourceId: 1, version: 2 },
      { sourceId: 2, version: 1 },
    ]);
  });
});

describe("userInputKind (S01-R15)", () => {
  it("tells a row the user wrote, a row approved with no current evidence, and every other", () => {
    const a = source("a", 2); // a second version: the evidence of version 1 is past
    const x = extractedItem("X");
    const past = extractedFact(x, "가");
    cite({ factId: past }, a.versionId(1));
    const current = extractedFact(x, "나");
    cite({ factId: current }, a.versionId(2));
    const written = userDecisions.add(db, {
      kind: "fact",
      itemId: x,
      factKind: "memo",
      value: "다",
    });
    if (written.status !== "applied") throw new Error("add");

    expect(userInputKind(db, { kind: "fact", id: past })).toBeNull();
    userDecisions.decide(db, { kind: "fact", id: past }, "approve");
    expect(userInputKind(db, { kind: "fact", id: past })).toBe("approved");
    userDecisions.decide(db, { kind: "fact", id: current }, "approve"); // with current evidence
    expect(userInputKind(db, { kind: "fact", id: current })).toBeNull();
    expect(userInputKind(db, written.ref)).toBe("authored");
    expect(userInputKind(db, { kind: "item", id: x })).toBeNull();
    // the approval no longer stands once a later user action follows, or once it is undone
    userDecisions.decide(db, { kind: "fact", id: past }, "dispute");
    expect(userInputKind(db, { kind: "fact", id: past })).toBeNull();
    userDecisions.undo(db, { kind: "fact", id: past });
    expect(userInputKind(db, { kind: "fact", id: past })).toBe("approved");
    // a policy's dispute leaves the user's approval the last standing user action, but the row is no longer verified
    automatedLifecycle.raiseDispute(
      db,
      { kind: "fact", id: past },
      { sourceId: a.sourceId, version: 2 },
    );
    expect(db.all("SELECT status FROM facts WHERE id = ?", [past])).toEqual([
      { status: "disputed" },
    ]);
    expect(userInputKind(db, { kind: "fact", id: past })).toBeNull();
    // cancelling the approval itself: back to the state before it, so no approval stands
    const other = extractedFact(x, "라");
    cite({ factId: other }, a.versionId(1));
    userDecisions.decide(db, { kind: "fact", id: other }, "approve");
    userDecisions.undo(db, { kind: "fact", id: other });
    expect(userInputKind(db, { kind: "fact", id: other })).toBeNull();
  });
});
