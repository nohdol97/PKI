// P3F-C2 (#233): `memoReads` answers an identical read once, forgets on any write, and hands out frozen rows.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { CHECK_LINES_READ } from "./analytical-check-lines.ts";
import { FACT_HEAD_READ, ITEM_TYPE_READ, OBJECTS_READ } from "./analytical-gate.ts";
import { batchWorld } from "./analytical-views.batch.test-support.ts";
import { ITEM_BASE_READ, ITEM_NAME_READ, OBJECTS_VIEW_READ } from "./analytical-views.ts";
import { SLOT_OWN_READ } from "./assertion-links.ts";
import { addEvidence, EVIDENCE_READS } from "./knowledge.ts";
import { migrate } from "./migrations.ts";
import { memoReads, preloadReads, type KeyedRead } from "./read-memo.ts";
import { LINEAGE_READS, USER_AUTHORED_READS } from "./row-lineage.ts";
import { automatedLifecycle, LINE_READS, ROW_READS } from "./semantic-lifecycle.ts";
import { registerConnectorInstance } from "./sources.ts";
import type { SqlDriver, SqlValue } from "./sql-driver.ts";

let base: SqlDriver;
let reads: number;
let memo: SqlDriver;
beforeEach(() => {
  base = openBetterSqlite3(":memory:");
  base.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  base.run("INSERT INTO t (v) VALUES ('a')");
  reads = 0;
  memo = memoReads({
    ...base,
    all: (sql, params) => {
      reads++;
      return base.all(sql, params);
    },
  });
});
afterEach(() => base.close());

const Q = "SELECT id, v FROM t ORDER BY id";

describe("memoReads", () => {
  it("P3F-C2: an identical (sql, params) reaches the driver once and both answers are equal", () => {
    const first = memo.all(Q);
    const second = memo.all(Q);
    expect(reads).toBe(1);
    expect(second).toEqual(first);
    memo.all("SELECT id FROM t WHERE id = ?", [1]);
    memo.all("SELECT id FROM t WHERE id = ?", [2]);
    expect(reads).toBe(3);
  });

  it("P3F-C2: a write through the wrapper clears the memo and the next read returns the changed rows", () => {
    expect(memo.all(Q)).toHaveLength(1);
    memo.run("INSERT INTO t (v) VALUES ('b')");
    expect(memo.all(Q)).toHaveLength(2);
    memo.transaction(() => memo.all(Q));
    memo.exec("DELETE FROM t");
    expect(memo.all(Q)).toHaveLength(0);
    expect(reads).toBe(4);
  });

  it("P3F-C2: a returned row and the list are frozen", () => {
    const rows = memo.all(Q);
    expect(() => {
      (rows[0] as Record<string, unknown>).v = "x";
    }).toThrow(TypeError);
    expect(() => rows.push({ id: 9, v: "z" })).toThrow(TypeError);
  });

  it("a bigint or byte-array param bypasses the memo", () => {
    memo.all("SELECT ? AS x", [1n]);
    memo.all("SELECT ? AS x", [1n]);
    expect(reads).toBe(2);
  });
});

describe("preloadReads (ARB-C2)", () => {
  const PAIR: KeyedRead = {
    one: "SELECT v FROM t WHERE id = ? AND v <> ? ORDER BY id",
    many: `SELECT id AS key, v FROM t WHERE id IN (SELECT value FROM json_each(?)) AND v <> ?
             ORDER BY id`,
  };
  const ids = [1, 2, 99];

  it("answers a point read for every id with no query, equal to the unprimed answer, an id with no row as the empty list", () => {
    base.run("INSERT INTO t (v) VALUES ('b')");
    const unprimed = ids.map((id) => base.all(PAIR.one, [id, "x"]));
    preloadReads(memo, PAIR, ids, ["x"]);
    expect(reads).toBe(1);
    expect(ids.map((id) => memo.all(PAIR.one, [id, "x"]))).toEqual(unprimed);
    expect(reads).toBe(1);
    expect(unprimed[2]).toEqual([]);
  });

  it("asks only the ids it has no answer for, and leaves a driver that is not a memo wrapper alone", () => {
    preloadReads(memo, PAIR, [1], ["x"]);
    preloadReads(memo, PAIR, [1], ["x"]);
    expect(reads).toBe(1);
    preloadReads(base, PAIR, ids, ["x"]);
    expect(reads).toBe(1);
  });

  it("forgets what it stored when the wrapper writes", () => {
    preloadReads(memo, PAIR, [1], ["x"]);
    memo.run("INSERT INTO t (v) VALUES ('b')");
    memo.all(PAIR.one, [1, "x"]);
    expect(reads).toBe(2);
  });
});

describe("every point read has a twin that answers alike (ARB-C2)", () => {
  type Twin = [name: string, read: KeyedRead, fixed: SqlValue[]];
  const twin = (name: string, read: KeyedRead, fixed: SqlValue[] = []): Twin => [name, read, fixed];
  const named = (label: string, reads: Record<string, KeyedRead>) =>
    Object.entries(reads).map(([k, r]) => twin(`${label} ${k}`, r));
  const twins: Twin[] = [
    ...named("evidence", EVIDENCE_READS),
    ...named("user_authored", USER_AUTHORED_READS),
    ...named("row", ROW_READS),
    ...named("lines", LINE_READS),
    ...named("lineage", LINEAGE_READS),
    twin("check lines", CHECK_LINES_READ),
    twin("slot", SLOT_OWN_READ),
    twin("fact head", FACT_HEAD_READ),
    twin("item type", ITEM_TYPE_READ),
    twin("item name", ITEM_NAME_READ),
    twin("item base", ITEM_BASE_READ),
    ...["MEASURED_ON", "JOIN_LEFT", "JOIN_RIGHT"].map((t) =>
      twin(`gate objects ${t}`, OBJECTS_READ, [t]),
    ),
    ...["MEASURED_ON", "USES_JOIN", "JOIN_LEFT", "JOIN_RIGHT"].map((t) =>
      twin(`view objects ${t}`, OBJECTS_VIEW_READ, [t]),
    ),
  ];

  it.each(twins)(
    "%s: mixed ids, a primed point read reaches no driver and equals the plain one",
    (_name, read, fixed) => {
      const world = openBetterSqlite3(":memory:");
      migrate(world);
      registerConnectorInstance(world, "c1", "test-fixtures");
      batchWorld(world);
      for (const r of world.all("SELECT id FROM relations"))
        automatedLifecycle.created(
          world,
          { kind: "relation", id: r.id as number },
          "extraction",
          null,
        );
      addEvidence(world, {
        target: { relationId: world.all("SELECT min(id) AS id FROM relations")[0]?.id as number },
        sourceVersionId: world.all("SELECT min(id) AS id FROM source_versions")[0]?.id as number,
        start: 0,
        end: 1,
        quote: "a",
      });
      let sent = 0;
      const counting: SqlDriver = {
        ...world,
        all: (sql, params) => {
          sent++;
          return world.all(sql, params);
        },
      };
      const ids = [...Array.from({ length: 60 }, (_, i) => i + 1), 999_999];
      const plain = ids.map((id) => world.all(read.one, [id, ...fixed]));
      expect(plain.some((rows) => rows.length > 0)).toBe(true);
      const memoized = memoReads(counting);
      preloadReads(memoized, read, ids, fixed);
      expect(sent).toBe(1);
      expect(ids.map((id) => memoized.all(read.one, [id, ...fixed]))).toEqual(plain);
      expect(sent).toBe(1);
      world.close();
    },
  );
});
