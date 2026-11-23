// K01 storage (R5, R6, R11): the Wiki's own input sequence rises when a table the pages read changes, the
// build is requested once and not again after a dead letter until the input changes, the change log keeps
// its newest lines, and a hide goes with the fact it hid.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertItem, saveFact } from "./knowledge.ts";
import { migrate } from "./migrations.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import {
  addWikiNote,
  endWikiItemIncarnation,
  isWikiBuildDead,
  listWikiNotes,
  isWikiStale,
  listWikiLog,
  readWikiState,
  removeWikiPage,
  requestWikiBuild,
  requestWikiRebuild,
  setWikiHide,
  WIKI_BUILD_KIND,
  WIKI_LOG_MAX,
  writeWikiPage,
  listWikiHidden,
} from "./wiki.ts";
import { leaseNextJob, closeJob } from "./jobs.ts";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import type { SqlDriver } from "./sql-driver.ts";

const attrs = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
} as const;
const AT = "2026-11-23T00:00:00.000Z";

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
});
afterEach(() => db.close());

const page = (key: string) => ({
  key,
  kind: "projects",
  target: "1",
  title: key,
  body: JSON.stringify({ members: [], claims: [] }),
  contentHash: `h:${key}`,
  lineage: [],
  links: [],
});

describe("wiki.state: stale is the input sequence ahead of the built one (K01-R5)", () => {
  it("rises with a change to a table the pages read, and a finished build catches up", () => {
    expect(isWikiStale(db)).toBe(false);
    const item = insertItem(db, { type: "Project", name: "가", ...attrs });
    saveFact(db, { itemId: item, kind: "memo", value: "값", ...attrs });
    const { inputSeq } = readWikiState(db);
    expect(inputSeq).toBeGreaterThan(0);
    expect(isWikiStale(db)).toBe(true);
    db.run(
      "UPDATE wiki_state SET built_seq = input_seq, built_knowledge_revision = 0, built_change_seq = 0",
    );
    expect(isWikiStale(db)).toBe(false);
    db.run(
      "INSERT INTO item_merges (member_id, representative_id, active, at) VALUES (?, ?, 1, 'x')",
      [insertItem(db, { type: "Project", name: "나", ...attrs }), item],
    );
    expect(isWikiStale(db)).toBe(true);
    db.run("UPDATE wiki_state SET built_seq = input_seq");
    expect(isWikiStale(db)).toBe(false);
    // the pages keep only evidence on the latest version: a new version changes what they would say
    registerConnectorInstance(db, "c1", "test-fixtures");
    saveSourceRecord(db, "c1", { externalId: "s", title: "t", body: "가" });
    db.run("UPDATE wiki_state SET built_seq = input_seq");
    saveSourceRecord(db, "c1", { externalId: "s", title: "t", body: "나" });
    expect(isWikiStale(db)).toBe(true);
  });
});

describe("wiki.request: one open build, and a dead one is not asked again for the same input (K01-R5)", () => {
  const lease = () =>
    leaseNextJob(db, { kinds: [WIKI_BUILD_KIND], now: new Date(), leaseMs: 60_000 });

  it("registers one job while stale, none while fresh, none beside an open one", () => {
    expect(requestWikiBuild(db).status).toBe("fresh");
    insertItem(db, { type: "Project", name: "가", ...attrs });
    expect(requestWikiBuild(db).status).toBe("registered");
    expect(requestWikiBuild(db).status).toBe("open");
    expect(db.all("SELECT count(*) AS n FROM jobs WHERE kind = ?", [WIKI_BUILD_KIND])[0]?.n).toBe(
      1,
    );
  });

  it("does not register again after a dead letter until the input changes or the user rebuilds", () => {
    insertItem(db, { type: "Project", name: "가", ...attrs });
    requestWikiBuild(db);
    const job = lease();
    if (!job) throw new Error("no job leased");
    closeJob(db, job, { status: "dead_letter", reason: "write-error" });
    expect(requestWikiBuild(db).status).toBe("dead");
    expect(isWikiBuildDead(db)).toBe(true);
    insertItem(db, { type: "Project", name: "나", ...attrs });
    expect(isWikiBuildDead(db)).toBe(false);
    expect(requestWikiBuild(db).status).toBe("registered");
    const again = lease();
    if (!again) throw new Error("no job leased");
    closeJob(db, again, { status: "dead_letter", reason: "write-error" });
    expect(requestWikiBuild(db).status).toBe("dead");
    expect(requestWikiRebuild(db).status).toBe("registered");
    expect(readWikiState(db).forceSeq).toBe(1);
  });
});

describe("wiki.log: a line per page change, the newest lines kept (K01-R6)", () => {
  it("logs create, change and remove, and drops the oldest past the limit", () => {
    insertItem(db, { type: "Project", name: "가", ...attrs }); // the page's target (id 1) stays
    writeWikiPage(db, page("projects/1"), AT);
    writeWikiPage(db, { ...page("projects/1"), contentHash: "h2" }, AT);
    removeWikiPage(db, "projects/1", AT);
    expect(listWikiLog(db, { limit: 10 }).map((l) => l.action)).toEqual([
      "removed",
      "changed",
      "created",
    ]);
    for (let i = 0; i < WIKI_LOG_MAX + 5; i++) writeWikiPage(db, page(`projects/${i + 10}`), AT);
    const all = listWikiLog(db, { limit: WIKI_LOG_MAX + 50 });
    expect(all).toHaveLength(WIKI_LOG_MAX);
    expect(all.some((l) => l.action === "removed")).toBe(false);
  });
});

describe("wiki.edits: a hide goes with the fact it hid (K01-R11)", () => {
  it("deletes the hide row when the fact is deleted", () => {
    const item = insertItem(db, { type: "Project", name: "가", ...attrs });
    const fact = saveFact(db, { itemId: item, kind: "memo", value: "값", ...attrs }).id;
    setWikiHide(db, { kind: "fact", id: fact }, true, AT);
    expect(listWikiHidden(db)).toEqual([{ kind: "fact", id: fact }]);
    db.run("DELETE FROM facts WHERE id = ?", [fact]);
    expect(listWikiHidden(db)).toEqual([]);
  });
});

describe("wiki.incarnation: an Insight that goes with its item (#220, K01-D20)", () => {
  it("ends the key of an Insight page removed earlier while its row stood, so a reused id inherits no note or history", () => {
    const x = insertItem(db, { type: "Project", name: "가", ...attrs });
    const y = insertItem(db, { type: "Project", name: "나", ...attrs });
    const insight = db.run(
      `INSERT INTO insights (rule, x_item_id, y_item_id, epistemic, state, summary)
       VALUES ('r', ?, ?, 'explicit', 'resolved', NULL)`,
      [x, y],
    ).lastInsertRowid;
    const key = `syntheses/${insight}`;
    writeWikiPage(db, { ...page(key), kind: "syntheses", target: String(insight) }, AT);
    addWikiNote(db, key, "내 메모", AT);
    removeWikiPage(db, key, AT); // the page goes while the Insight row still stands: the note is orphaned
    expect(listWikiLog(db, { pageKey: key, limit: 10 }).length).toBeGreaterThan(0);

    db.transaction(() => {
      db.run("DELETE FROM items WHERE id = ?", [x]); // the Insight goes with it (cascade)
      endWikiItemIncarnation(db, x);
    });

    expect(listWikiLog(db, { pageKey: key, limit: 10 })).toHaveLength(0);
    expect(listWikiNotes(db, key)).toHaveLength(0);
    expect(listWikiNotes(db, `${key}#gone`).map((n) => n.text)).toEqual(["내 메모"]);
  });
});
