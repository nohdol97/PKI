// S02-T08 `conflict.*` at the storage level (S02-R18, R19, R20): `otherValidValues` and the link rows.
// All data is synthetic.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import {
  insertAssertionLink,
  listAssertionLinks,
  otherValidValues,
  supersededAmong,
} from "./assertion-links.ts";
import { addEvidence, insertItem, saveFact, type KnowledgeAttributes } from "./knowledge.ts";
import { migrate } from "./migrations.ts";
import { automatedLifecycle } from "./semantic-lifecycle.ts";
import { userDecisions } from "./semantic-user.ts";
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

let counter = 0;
function item(): number {
  counter++;
  const id = insertItem(db, { type: "Project", name: `item-${counter}`, ...attrs });
  automatedLifecycle.created(db, { kind: "item", id }, "extraction", null);
  return id;
}
/** A fact with current evidence (its own source), as extraction leaves it. */
function fact(itemId: number, value: string, kind = "target_date", context: string | null = null) {
  counter++;
  const saved = saveFact(db, { itemId, kind, value, context, ...attrs });
  automatedLifecycle.created(db, { kind: "fact", id: saved.id }, "extraction", null);
  const source = saveSourceRecord(db, "c1", {
    externalId: `s-${counter}`,
    title: "t",
    body: "body text",
    accessScope: null,
  });
  if (source.status !== "created") throw new Error(source.status);
  const versionId = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
  addEvidence(db, {
    target: { factId: saved.id },
    sourceVersionId: versionId,
    start: 0,
    end: 4,
    quote: "body",
  });
  return saved.id;
}
const link = (type: "SUPERSEDES" | "CONTRADICTS", from: number, to: number) =>
  insertAssertionLink(db, { type, fromFactId: from, toFactId: to, createdBy: "rule", at: AT }).id;

describe("otherValidValues (S02-R20)", () => {
  it("another valid value of the same kind and tag; 'item' stays on the item, 'group' reads the merge group", () => {
    const a = item();
    const b = item();
    const onA = fact(a, "2026-12-01");
    const sameItem = fact(a, "2026-12-02");
    fact(a, "2026-12-03", "target_date", "plan-b");
    const onB = fact(b, "2026-12-04");
    expect(otherValidValues(db, onA, "item")).toEqual([sameItem]);
    // no merge yet: the group is the item
    expect(otherValidValues(db, onA, "group")).toEqual([sameItem]);
    const merged = db.transaction(() => userDecisions.entities.merge(db, b, a, AT));
    expect(merged.status).toBe("applied");
    expect(otherValidValues(db, onA, "item")).toEqual([sameItem]);
    expect(otherValidValues(db, onA, "group")).toEqual([sameItem, onB]);
    expect(otherValidValues(db, 9999, "item")).toEqual([]);
  });

  it("leaves out a superseded value and the value that supersedes the asked fact; a 'many' kind answers nothing", () => {
    const a = item();
    const early = fact(a, "2026-12-01");
    const late = fact(a, "2026-12-02");
    const third = fact(a, "2026-12-03");
    link("SUPERSEDES", late, early);
    expect(otherValidValues(db, early, "item")).toEqual([third]);
    expect(otherValidValues(db, late, "item")).toEqual([third]);
    expect(otherValidValues(db, third, "item")).toEqual([late]);
    expect(supersededAmong(db, [early, late, third])).toEqual([
      { factId: early, linkId: expect.any(Number) },
    ]);
    expect(otherValidValues(db, early, "item")).toEqual([third]);
    // A -> B -> A (propagation links of two versions): B is itself superseded, so its link no longer counts
    expect(
      automatedLifecycle.supersede(db, { kind: "fact", id: late }, { sourceId: 1, version: 1 }),
    ).toMatchObject({ status: "applied" });
    link("SUPERSEDES", early, late);
    // the first link (late over early) stops counting; only the later one (early over late) does
    expect(supersededAmong(db, [early, late]).map((s) => s.factId)).toEqual([late]);
    const many = fact(a, "x@example.test", "identifier.email");
    fact(a, "y@example.test", "identifier.email");
    expect(otherValidValues(db, many, "item")).toEqual([]);
  });
});

describe("conflict.supersede-links: the user's value fix (S02-R19)", () => {
  it("links the new row to the old one (SUPERSEDES, user) and its undo removes the link", () => {
    const old = fact(item(), "2026-12-01");
    const fix = userDecisions.replaceValue(db, { kind: "fact", id: old }, "2026-12-09", AT);
    if (fix.status !== "applied") throw new Error(fix.status);
    expect(listAssertionLinks(db)).toEqual([
      expect.objectContaining({
        type: "SUPERSEDES",
        fromFactId: fix.added.id,
        toFactId: old,
        createdBy: "user",
        basis: null,
      }),
    ]);
    expect(userDecisions.undo(db, fix.added, AT)).toMatchObject({ status: "removed" });
    expect(listAssertionLinks(db)).toEqual([]);
  });
});
