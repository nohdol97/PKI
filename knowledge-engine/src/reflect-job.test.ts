// K02-C2a (R8, R9, R10) and K02-C2b (R4): a re-review writes no row of the knowledge tables; a finding the user
// closed stays closed through the next run; accepting a merge and undoing it again and again ends in
// `oscillating`, after which a run changes nothing; Wiki pages, a summary and an Insight made before the run
// leave the findings as they were. A run of a bounded number of bundles leaves the rest of the marks for the
// next run, and a change made after the run read its marks keeps its mark.
import {
  commitDerived,
  countDirty,
  listDirty,
  insertFinding,
  listFindings,
  migrate,
  registerConnectorInstance,
  saveInsight,
  userDecisions,
  writeWikiSummary,
  type SqlDriver,
  type StoredFinding,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decideFinding } from "./lint-decide.ts";
import { loadLintFixture, NOW, reflectNow } from "./lint.test-support.ts";
import { planReflect } from "./reflect-job.ts";
import { addFact, addItem, addSource, buildWiki, cite } from "./wiki.test-support.ts";
import { memoryDbTemplate } from "@pki/testkit";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);

let db: SqlDriver;
beforeEach(() => {
  db = freshDb();
});
afterEach(() => db.close());

const rows = (d: SqlDriver) =>
  Object.fromEntries(
    ["items", "facts", "relations", "evidence"].map((t) => [
      t,
      d.all(`SELECT count(*) AS n FROM ${t}`)[0]?.n,
    ]),
  );
const findingOf = (rule: string): StoredFinding => {
  const found = listFindings(db).find((f) => f.rule === rule);
  if (!found) throw new Error(`no ${rule} finding`);
  return found;
};
const touch = (item: number) =>
  db.run("UPDATE facts SET valid_until = '2027-01-01' WHERE item_id = ?", [item]);

describe("reflect.job: a run leaves the knowledge as it was and keeps the user's closing (K02-C2a ① ②)", () => {
  it("writes no knowledge row, and a dismissed finding is still dismissed after another run", () => {
    const loaded = loadLintFixture(db);
    const before = rows(db);

    reflectNow(db);
    expect(rows(db)).toEqual(before);

    const synonym = findingOf("synonym");
    const closed = decideFinding(db, userDecisions, { id: synonym.id, op: "dismiss" }, NOW);
    expect(closed.status).toBe("applied");
    touch(loaded.items.get("sys1") as number); // dirty again: the group is looked at once more
    reflectNow(db);

    expect(findingOf("synonym").status).toBe("dismissed");
    expect(rows(db)).toEqual(before);
  });
});

describe("reflect.job: a flip-flopping finding stops (K02-C2a ③)", () => {
  it("is oscillating at the third reopening, and a run after that changes nothing", () => {
    const loaded = loadLintFixture(db);
    const sys = [loaded.items.get("sys1"), loaded.items.get("sys2")] as number[];
    reflectNow(db);
    const states: string[] = [];
    for (let round = 0; round < 3; round++) {
      const id = findingOf("synonym").id;
      expect(decideFinding(db, userDecisions, { id, op: "accept" }, NOW).status).toBe("applied");
      expect(findingOf("synonym").status).toBe("accepted");
      const line = db.all("SELECT id FROM item_merges WHERE member_id = ?", [sys[1] as number])[0];
      userDecisions.entities.unmerge(db, line?.id as number, false, NOW);
      reflectNow(db);
      states.push(`${findingOf("synonym").status}:${findingOf("synonym").flips}`);
    }
    expect(states).toEqual(["open:1", "open:2", "oscillating:3"]);

    const before = JSON.stringify(listFindings(db));
    touch(sys[0] as number);
    reflectNow(db);
    expect(JSON.stringify(listFindings(db))).toBe(before);
  });
});

describe("reflect.job: what the product wrote is not an input (K02-C2a ④)", () => {
  it("lists the same findings with Wiki pages, a summary and an Insight made first as without them", () => {
    const plain = freshDb();
    loadLintFixture(plain);
    reflectNow(plain);

    const loaded = loadLintFixture(db);
    buildWiki(db);
    const page = db.all("SELECT key, content_hash FROM wiki_pages ORDER BY key LIMIT 1")[0];
    expect(writeWikiSummary(db, page?.key as string, page?.content_hash as string, "[]")).toBe(
      true,
    );
    saveInsight(
      db,
      {
        rule: "dependency-delay",
        xItemId: loaded.items.get("m1") as number,
        yItemId: loaded.items.get("m2") as number,
      },
      { state: "active", summary: "두 항목을 함께 적은 요약", evidenceIds: [] },
    );
    reflectNow(db);

    const shape = (d: SqlDriver) =>
      listFindings(d).map((f) => ({ rule: f.rule, status: f.status, target: f.target }));
    expect(shape(db)).toEqual(shape(plain));
    plain.close();
  });
});

describe("reflect.job: a bounded run goes on where it stopped (K02-C2b)", () => {
  function fiveItems() {
    registerConnectorInstance(db, "c1", "test-fixtures");
    const a = addSource(db, "a", "합성 본문");
    const items = ["가", "나", "다", "라", "마"].map((n) => addItem(db, "Project", `항목 ${n}`));
    for (const item of items) cite(db, { factId: addFact(db, item, "memo", "값") }, a.id);
    return items;
  }

  it("sees 2 and leaves 3 with a cap of 2, then goes on", () => {
    fiveItems();
    expect(countDirty(db)).toBe(5);
    expect(reflectNow(db, "daily", { cap: 2 }).counts).toMatchObject({ bundles: 2, dirtyLeft: 3 });
    expect(countDirty(db)).toBe(3);
    expect(reflectNow(db, "daily", { cap: 2 }).counts).toMatchObject({ bundles: 2, dirtyLeft: 1 });
    expect(reflectNow(db, "daily", { cap: 2 }).counts).toMatchObject({ bundles: 1, dirtyLeft: 0 });
  });

  it("keeps the mark of an item that changed after the run read its marks", () => {
    const items = fiveItems();
    const plan = planReflect(db, "daily", NOW, {});
    touch(items[2] as number); // after the read, before the result is written
    db.transaction(() => commitDerived(db, { source: null, items: plan.items }));
    expect(listDirty(db).map((m) => m.itemId)).toEqual([items[2]]);
  });
});

describe("reflect.job: a pair that stands from one side is not closed by a run of the other (K02-C2a ③, R8)", () => {
  it("keeps a missing link open and unflipped through runs that see only A, then only B", () => {
    registerConnectorInstance(db, "c1", "test-fixtures");
    const sources = ["a", "b", "c"].map((n) => addSource(db, n, `합성 본문 ${n}`));
    const cited = (item: number, from: number) => {
      for (const src of sources.slice(0, from)) {
        cite(db, { factId: addFact(db, item, `memo.${src.id}`, "값") }, src.id);
      }
    };
    // A shares three sources with each of five others and two with B: A's five best partners leave B out,
    // while B's best partners (two shared with each of them, ties by id) include A
    const a = addItem(db, "Project", "A");
    const b = addItem(db, "Project", "B");
    cited(a, 3);
    cited(b, 2);
    for (const n of ["1", "2", "3", "4", "5"]) cited(addItem(db, "Project", `P${n}`), 3);
    reflectNow(db);
    const pair = () => {
      const found = listFindings(db).find(
        (f) => f.rule === "missing-link" && f.target.a === a && f.target.b === b,
      );
      if (!found) throw new Error("no pair finding");
      return `${found.status}:${found.flips}`;
    };
    expect(pair()).toBe("open:0");

    const states: string[] = [];
    for (const item of [a, b, a, b]) {
      touch(item);
      reflectNow(db);
      states.push(pair());
    }
    expect(states).toEqual(["open:0", "open:0", "open:0", "open:0"]);
  });
});

describe("reflect.job: a finding whose target row is gone is removed by the run (KF-C2)", () => {
  it("drops the one on an absent fact and keeps the fixture's findings", () => {
    loadLintFixture(db);
    reflectNow(db);
    const kept = listFindings(db).map((f) => f.fingerprint);
    insertFinding(db, {
      rule: "stale",
      target: { kind: "fact", a: 999999, b: null },
      origin: "rule",
      status: "dismissed",
      lineage: [],
      at: NOW,
    });
    expect(listFindings(db)).toHaveLength(kept.length + 1);

    reflectNow(db, "daily");

    expect(listFindings(db).map((f) => f.fingerprint)).toEqual(kept);
  });
});
