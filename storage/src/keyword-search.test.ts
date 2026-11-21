// V01-C3 keyword search and assumption A17: the shipped driver build has
// SQLite full-text search, and the index follows the canonical rows.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./better-sqlite3-driver.ts";
import { searchKeyword } from "./keyword-search.ts";
import { migrate } from "./migrations.ts";
import type { SqlDriver } from "./sql-driver.ts";

let db: SqlDriver;

beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
});

afterEach(() => {
  db.close();
});

function addVersion(externalId: string, title: string, body: string): number {
  const source = db.run(
    "INSERT INTO sources (connector_instance_id, external_id) VALUES ('test', ?)",
    [externalId],
  );
  return db.run(
    "INSERT INTO source_versions (source_id, content_hash, title, body) VALUES (?, ?, ?, ?)",
    [source.lastInsertRowid, `hash-${externalId}`, title, body],
  ).lastInsertRowid;
}

describe("full-text search in the shipped driver build (A17)", () => {
  it("is compiled into the driver", () => {
    expect(db.all("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS fts5")).toEqual([
      { fts5: 1 },
    ]);
  });

  it("backs the keyword index", () => {
    expect(db.all("SELECT sql FROM sqlite_schema WHERE name = 'keyword_index'")[0]?.sql).toMatch(
      /USING fts5/i,
    );
  });
});

describe("searchKeyword", () => {
  it("finds versions by words in the title or the body", () => {
    const meeting = addVersion("1", "Weekly meeting", "Budget review for Q3");
    const lunch = addVersion("2", "Lunch", "Pasta place near the office");
    expect(searchKeyword(db, "budget")).toEqual([meeting]);
    expect(searchKeyword(db, "lunch")).toEqual([lunch]);
    expect(searchKeyword(db, "absent")).toEqual([]);
  });

  it("requires every term to match", () => {
    const both = addVersion("1", "Budget", "Review of the plan");
    addVersion("2", "Budget", "Something else");
    expect(searchKeyword(db, "budget review")).toEqual([both]);
  });

  it("matches Korean words followed by particles via prefix terms", () => {
    const id = addVersion("1", "주간 회의록", "예산을 검토했다");
    expect(searchKeyword(db, "회의")).toEqual([id]);
    expect(searchKeyword(db, "예산")).toEqual([id]);
  });

  it("treats query syntax characters as plain text", () => {
    addVersion("1", "Title", "body");
    for (const q of ['"', "AND", "NOT x", "a*b", "title:body", "(", "NEAR(a b)"]) {
      expect(() => searchKeyword(db, q)).not.toThrow();
    }
    expect(searchKeyword(db, "   ")).toEqual([]);
  });

  it("treats control characters, including NUL, as separators", () => {
    const id = addVersion("1", "alpha", "beta");
    for (const q of ["\u0000", "\u0001\u001f", "\u007f"]) expect(searchKeyword(db, q)).toEqual([]);
    expect(searchKeyword(db, "alpha\u0000beta")).toEqual([id]);
  });

  it("drops a deleted version from the index in the same transaction", () => {
    const id = addVersion("1", "Ephemeral", "gone soon");
    db.run("DELETE FROM source_versions WHERE id = ?", [id]);
    expect(searchKeyword(db, "ephemeral")).toEqual([]);
  });

  it("caps the number of results", () => {
    for (let i = 0; i < 5; i++) addVersion(String(i), "same", "word");
    expect(searchKeyword(db, "same", 3)).toHaveLength(3);
  });
});
