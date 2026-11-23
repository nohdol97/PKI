// K02-C1a (R5, R6, R7): the fixture's five situations (a pair joined only by an unverified alias, a relation
// resting on an old version, work past its target date, two items in two sources with no relation, a stale
// candidate row) go through one re-review: each of the four rules opens one finding with the ids and the
// lineage of its target, and the stale candidate row is gone.
import { lineageOfFinding, listFindings, migrate, type SqlDriver } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lintFixture, loadLintFixture, reflectNow } from "./lint.test-support.ts";

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
});
afterEach(() => db.close());

describe("lint.rules: one finding per rule on the fixture (K02-C1a)", () => {
  it("opens exactly the four expected findings with their target ids and lineage, and drops the stale candidate row", () => {
    const loaded = loadLintFixture(db);
    expect(db.all("SELECT count(*) AS n FROM merge_candidates")[0]?.n).toBe(1);

    const { committed } = reflectNow(db);

    expect(committed.status).toBe("committed");
    const id = (key: string) => loaded.items.get(key) as number;
    const found = listFindings(db).map((f) => ({
      rule: f.rule,
      status: f.status,
      target: f.target,
    }));
    expect(found).toEqual([
      { rule: "synonym", status: "open", target: { kind: "item", a: id("sys1"), b: id("sys2") } },
      {
        rule: "stale",
        status: "open",
        target: { kind: "relation", a: loaded.relations.get("r1"), b: null },
      },
      { rule: "overdue-work", status: "open", target: { kind: "item", a: id("task"), b: null } },
      {
        rule: "missing-link",
        status: "open",
        target: { kind: "item", a: id("m1"), b: id("m2") },
      },
    ]);
    // the fixture names exactly these four
    expect(Object.keys(lintFixture.expect).sort()).toEqual([
      "missing-link",
      "overdue-work",
      "stale",
      "synonym",
    ]);
    // the lineage: the versions the targets came from (the stale relation's is the old version of s3)
    const lineage = (rule: string) =>
      lineageOfFinding(db, listFindings(db).find((f) => f.rule === rule)?.id as number);
    expect(lineage("stale")).toEqual([{ sourceId: loaded.sources.get("s3"), version: 1 }]);
    expect(lineage("missing-link").map((v) => v.sourceId)).toEqual([
      loaded.sources.get("s7"),
      loaded.sources.get("s8"),
    ]);
    for (const rule of ["synonym", "overdue-work"]) expect(lineage(rule).length).toBeGreaterThan(0);
    expect(db.all("SELECT count(*) AS n FROM merge_candidates")[0]?.n).toBe(0);
  });
});
