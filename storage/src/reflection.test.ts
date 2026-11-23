// K02-C3a ① (R1): a change to a row the lint reads marks the items it bears on dirty and no others; the
// marks are cleared only up to the sequence that was read. The cross-check keeps the trigger set equal to the
// one constant that names the tables (R1).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { insertItem, saveFact } from "./knowledge.ts";
import { migrate, REFLECTION_DIRTY_TABLES } from "./migrations.ts";
import { clearDirty, countDirty, listDirty, readReflectionState } from "./reflection.ts";
import type { SqlDriver } from "./sql-driver.ts";

const attrs = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
} as const;

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
});
afterEach(() => db.close());

const dirtyItems = () => listDirty(db).map((m) => m.itemId);

describe("reflection.dirty: a changed row marks its items (K02-R1)", () => {
  it("marks only the item whose fact was fixed", () => {
    const items = ["가", "나", "다"].map((name) =>
      insertItem(db, { type: "Project", name, ...attrs }),
    );
    const facts = items.map(
      (itemId) => saveFact(db, { itemId, kind: "memo", value: "값", ...attrs }).id,
    );
    clearDirty(db, listDirty(db));
    expect(countDirty(db)).toBe(0);

    db.run("UPDATE facts SET valid_until = '2026-12-31' WHERE id = ?", [facts[1] as number]);

    expect(dirtyItems()).toEqual([items[1]]);
  });

  it("clears a mark only while it is the one that was read", () => {
    const item = insertItem(db, { type: "Project", name: "가", ...attrs });
    const read = listDirty(db);
    saveFact(db, { itemId: item, kind: "memo", value: "읽은 뒤에 바뀜", ...attrs });

    clearDirty(db, read);

    expect(dirtyItems()).toEqual([item]);
    expect(readReflectionState(db).dirtySeq).toBeGreaterThan(read[0]?.seq ?? 0);
  });
});

describe("reflection.triggers: the constant names every trigger (K02-R1)", () => {
  it("has insert, update and delete triggers for each listed table and none for the lint's own or the Wiki's", () => {
    const triggers = db
      .all(
        "SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'reflection\\_dirty\\_%' ESCAPE '\\'",
      )
      .map((r) => `${r.tbl_name as string}:${r.name as string}`)
      .sort();
    const wanted = Object.keys(REFLECTION_DIRTY_TABLES).flatMap((table) =>
      ["insert", "update", "delete"].map((e) => `${table}:reflection_dirty_${table}_${e}`),
    );
    expect(triggers).toEqual(wanted.sort());
    const excluded = db
      .all(
        "SELECT DISTINCT tbl_name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'reflection\\_dirty\\_%' ESCAPE '\\'",
      )
      .map((r) => r.tbl_name as string)
      .filter((t) => /^(lint_|reflection_|wiki_|insight)/.test(t));
    expect(excluded).toEqual([]);
  });
});
