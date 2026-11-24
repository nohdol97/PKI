// K01-C3a (R4, R5, R7, R10): the `wiki-build` job writes only the pages that changed, in one transaction. A
// write that throws half way leaves the stored pages as they were and the Wiki stale; run again, the job
// finishes and its pages hash as one run without the failure would have made them.
import {
  closeJob,
  isWikiStale,
  leaseNextJob,
  listStoredWikiPages,
  migrate,
  readWikiState,
  registerConnectorInstance,
  requestWikiBuild,
  requestWikiRebuild,
  WIKI_BUILD_KIND,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWikiBuildHandler } from "./wiki-build-job.ts";
import { renderWikiPages } from "./wiki-render.ts";
import { addFact, addItem, addSource, buildWiki, cite } from "./wiki.test-support.ts";
import { memoryDbTemplate } from "@pki/testkit";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);

let db: SqlDriver;
beforeEach(() => {
  db = freshDb();
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

const hashes = () => Object.fromEntries(listStoredWikiPages(db).map((p) => [p.key, p.contentHash]));
/** Requests, claims and runs one `wiki-build` job the way the runner does: handler, then closeJob. */
async function run(): Promise<string> {
  const requested = requestWikiBuild(db);
  if (requested.status !== "registered") return requested.status;
  const job = leaseNextJob(db, {
    kinds: [WIKI_BUILD_KIND],
    now: new Date(),
    leaseMs: 60_000,
  }) as StoredJob;
  const result = await createWikiBuildHandler({
    db,
    now: () => new Date("2026-11-23T00:00:00Z"),
  })();
  if (result.status !== "succeeded") throw new Error(result.status);
  return closeJob(db, job, { status: "succeeded", items: result.items });
}

describe("wiki.build-job: a failing write leaves nothing half written", () => {
  it("restores the pages, stays stale, and finishes to the hashes a clean run makes", async () => {
    const a = addSource(db, "a", "합성 본문 가");
    const items = ["가", "나", "다"].map((name) => addItem(db, "Project", `항목 ${name}`));
    for (const item of items) cite(db, { factId: addFact(db, item, "memo", "첫 값") }, a.id);
    expect(await run()).toBe("succeeded");
    const before = hashes();
    expect(Object.keys(before)).toHaveLength(3);
    expect(isWikiStale(db)).toBe(false);

    // every page changes; the second one's write throws
    for (const item of items) cite(db, { factId: addFact(db, item, "memo", "둘째 값") }, a.id);
    expect(isWikiStale(db)).toBe(true);
    const failing = `projects/${items[1]}`;
    db.exec(`CREATE TRIGGER fail_one BEFORE UPDATE ON wiki_pages WHEN new.key = '${failing}'
      BEGIN SELECT RAISE(ABORT, 'write failed'); END`);
    await expect(run()).rejects.toThrow();
    expect(hashes()).toEqual(before);
    expect(isWikiStale(db)).toBe(true);

    db.exec("DROP TRIGGER fail_one");
    db.run("UPDATE jobs SET status = 'superseded' WHERE kind = ?", [WIKI_BUILD_KIND]);
    expect(await run()).toBe("succeeded");
    expect(isWikiStale(db)).toBe(false);
    const clean = Object.fromEntries(renderWikiPages(db).map((p) => [p.key, p.contentHash]));
    expect(hashes()).toEqual(clean);
    expect(Object.values(hashes()).every((h, i) => h !== Object.values(before)[i])).toBe(true);
  });

  it("writes only the changed pages and removes the page of a target that is gone", async () => {
    const a = addSource(db, "a", "합성 본문 가");
    const [x, y] = ["가", "나"].map((name) => addItem(db, "Project", `항목 ${name}`)) as [
      number,
      number,
    ];
    for (const item of [x, y]) cite(db, { factId: addFact(db, item, "memo", "값") }, a.id);
    await run();
    const before = hashes();
    const stamp = (key: string) =>
      db.all("SELECT updated_at FROM wiki_pages WHERE key = ?", [key])[0]?.updated_at;

    cite(db, { factId: addFact(db, x, "memo", "새 값") }, a.id);
    const untouched = stamp(`projects/${y}`);
    await run();
    expect(hashes()[`projects/${y}`]).toBe(before[`projects/${y}`]);
    expect(hashes()[`projects/${x}`]).not.toBe(before[`projects/${x}`]);
    expect(stamp(`projects/${y}`)).toBe(untouched);

    db.run("DELETE FROM facts WHERE item_id = ?", [y]); // its evidence goes with the facts
    db.run("DELETE FROM items WHERE id = ?", [y]);
    await run();
    expect(Object.keys(hashes())).toEqual([`projects/${x}`]);
  });
});

describe("wiki.build-job: a forced rebuild is not cut by the page cap (K01-R10)", () => {
  it("finishes in one run with more pages than the cap and catches the state up", () => {
    const a = addSource(db, "a", "합성 본문 가");
    for (const name of ["가", "나", "다"]) {
      cite(db, { factId: addFact(db, addItem(db, "Project", `항목 ${name}`), "memo", "값") }, a.id);
    }
    expect(buildWiki(db, { cap: 5 }).plan.complete).toBe(true);
    requestWikiRebuild(db);
    const state = readWikiState(db);
    expect(state.forceSeq).toBeGreaterThan(state.forcedSeq);

    const { plan } = buildWiki(db, { cap: 2 });
    expect(plan.complete).toBe(true);
    const after = readWikiState(db);
    expect(after.forcedSeq).toBe(after.forceSeq);
    expect(after.builtSeq).toBe(after.inputSeq);
    expect(isWikiStale(db)).toBe(false);
  });
});
