// I04-R11 (I04-T06): the fence of a derivative's write. assertFresh (the version is
// stored, the source's latest and covered by no tombstone), assertLineage (every
// other source version the item came from is stored and uncovered) and
// commitDerived, the one write function: a stale source or lineage discards the
// whole result (`stale`, the job closes superseded); a scope the policy refuses
// (`combinable`, I04-R14) discards that item only. `fence.fresh` (C2).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import {
  assertFresh,
  assertLineage,
  commitDerived,
  isFenceCurrent,
  StaleDerivativeError,
} from "./commit-derived.ts";
import type { DerivedItem, ScopePolicyDrop, SourceVersionRef } from "./derivatives.ts";
import { seedLegacyTombstone } from "@pki/testkit";
import { migrate } from "./migrations.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";
import { recordTombstoneLift } from "./tombstones.ts";

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

const AT = "2026-11-22T00:00:00Z";
/** Source `name`'s next version (the product version numbers 1, 2, ...). */
const save = (name: string, body: string, scope?: string) => {
  const saved = saveSourceRecord(db, "c1", { externalId: name, title: `제목 ${name}`, body });
  if (saved.status !== "created") throw new Error(`expected a new version, got ${saved.status}`);
  if (scope) db.run("UPDATE sources SET access_scope = ? WHERE id = ?", [scope, saved.sourceId]);
  return { sourceId: saved.sourceId, version: saved.version };
};
const cover = (sourceId: number, version: number) =>
  seedLegacyTombstone(db, { sourceId, version, at: AT, reason: "source-deleted" });

const written: string[] = [];
beforeEach(() => void (written.length = 0));
const item = (key: string, lineage: SourceVersionRef[]): DerivedItem => ({
  kind: "fact",
  itemKey: key,
  lineage,
  write: () => void written.push(key),
});
const causeOf = (run: () => void) => {
  try {
    run();
  } catch (error) {
    if (error instanceof StaleDerivativeError) return error.cause;
    throw error;
  }
  return null;
};

describe("fence.fresh: assertFresh (I04-R11)", () => {
  it("passes the stored, latest, uncovered version of the source", () => {
    const a = save("a", "첫째");
    save("a", "둘째");
    expect(causeOf(() => assertFresh(db, a.sourceId, 2))).toBeNull();
    expect(isFenceCurrent(db, { sourceId: a.sourceId, fenceVersion: 2 })).toBe(true);
  });

  it("names a version that is not stored: missing", () => {
    const a = save("a", "첫째");
    expect(causeOf(() => assertFresh(db, a.sourceId, 7))).toBe("missing");
    expect(causeOf(() => assertFresh(db, 404, 1))).toBe("missing");
  });

  it("names a version a newer one replaced: not-latest", () => {
    const a = save("a", "첫째");
    save("a", "둘째");
    expect(causeOf(() => assertFresh(db, a.sourceId, 1))).toBe("not-latest");
    expect(isFenceCurrent(db, { sourceId: a.sourceId, fenceVersion: 1 })).toBe(false);
  });

  it("names a version a tombstone covers: covered, before any other cause", () => {
    const a = save("a", "첫째");
    save("a", "둘째");
    cover(a.sourceId, 1);
    // version 1 is also not the latest: the cover is the fact that decides
    expect(causeOf(() => assertFresh(db, a.sourceId, 1))).toBe("covered");
  });

  it("keeps a lifted cover covering what it covers, and frees the versions above it", () => {
    const a = save("a", "첫째");
    save("a", "둘째");
    cover(a.sourceId, 1);
    recordTombstoneLift(db, a.sourceId, AT);
    expect(causeOf(() => assertFresh(db, a.sourceId, 1))).toBe("covered");
    // the lifted tombstone's row stays: it is not why version 2 would be refused
    expect(causeOf(() => assertFresh(db, a.sourceId, 2))).toBeNull();
    save("a", "셋째");
    expect(causeOf(() => assertFresh(db, a.sourceId, 2))).toBe("not-latest");
    expect(causeOf(() => assertFresh(db, a.sourceId, 3))).toBeNull();
  });

  it("is a StaleDerivativeError, not a plain failure", () => {
    expect(() => assertFresh(db, 404, 1)).toThrow(StaleDerivativeError);
  });
});

describe("fence.fresh: assertLineage (I04-R11)", () => {
  it("passes versions that are stored and uncovered, the latest or not", () => {
    const b = save("b", "첫째");
    save("b", "둘째");
    expect(causeOf(() => assertLineage(db, [b, { sourceId: b.sourceId, version: 2 }]))).toBeNull();
    expect(causeOf(() => assertLineage(db, []))).toBeNull();
  });

  it("refuses a version that is gone or covered: lineage-covered", () => {
    const b = save("b", "첫째");
    expect(causeOf(() => assertLineage(db, [{ sourceId: b.sourceId, version: 9 }]))).toBe(
      "lineage-covered",
    );
    cover(b.sourceId, 1);
    expect(causeOf(() => assertLineage(db, [b]))).toBe("lineage-covered");
    recordTombstoneLift(db, b.sourceId, AT); // a lift uncovers nothing
    expect(causeOf(() => assertLineage(db, [b]))).toBe("lineage-covered");
  });
});

describe("fence.fresh: commitDerived (I04-R11)", () => {
  it("writes every item of a fresh source whose lineage holds, in order", () => {
    const a = save("a", "첫째");
    const b = save("b", "첫째");
    expect(commitDerived(db, { source: a, items: [item("x", [a, b]), item("y", [a])] })).toEqual({
      status: "committed",
      written: 2,
      dropped: [],
    });
    expect(written).toEqual(["x", "y"]);
  });

  it("discards the whole result when another source's version in the lineage is covered", () => {
    const a = save("a", "첫째");
    const b = save("b", "첫째");
    cover(b.sourceId, 1);
    expect(commitDerived(db, { source: a, items: [item("x", [a]), item("y", [a, b])] })).toEqual({
      status: "stale",
      cause: "lineage-covered",
    });
    expect(written).toEqual([]);
  });

  it("checks the lineage of a job that has no source version too", () => {
    const b = save("b", "첫째");
    cover(b.sourceId, 1);
    expect(commitDerived(db, { source: null, items: [item("x", [b])] })).toEqual({
      status: "stale",
      cause: "lineage-covered",
    });
    expect(commitDerived(db, { source: null, items: [item("x", [])] })).toMatchObject({
      status: "committed",
    });
  });

  it("reports the source's own cause first when both the source and the lineage are stale", () => {
    const a = save("a", "첫째");
    const b = save("b", "첫째");
    save("a", "둘째");
    cover(b.sourceId, 1);
    expect(commitDerived(db, { source: a, items: [item("x", [b])] })).toEqual({
      status: "stale",
      cause: "not-latest",
    });
  });

  it("asks no policy and records no drop when the source is stale", () => {
    const a = save("a", "첫째");
    save("a", "둘째");
    const asked: unknown[] = [];
    const result = commitDerived(db, {
      source: a,
      items: [item("x", [a])],
      scope: {
        policy: { combinable: (scopes) => (asked.push(scopes), false) },
        recordDrop: () => {
          throw new Error("a stale result records no drop");
        },
      },
    });
    expect(result).toEqual({ status: "stale", cause: "not-latest" });
    expect(asked).toEqual([]);
  });
});

describe("fence.fresh: a combinable failure discards only that item (I04-R11, R14)", () => {
  it("drops the item the policy refuses, writes the rest and returns the records", () => {
    const a = save("a", "첫째", "team-a");
    const b = save("b", "첫째", "team-b");
    const seen: (readonly string[] | null)[][] = [];
    const record = (tx: SqlDriver, dropped: DerivedItem): ScopePolicyDrop => {
      expect(tx).toBe(db);
      return {
        sourceId: a.sourceId,
        version: a.version,
        kind: dropped.kind,
        itemKeyHash: `hash-of-${dropped.itemKey}`,
        reason: "scope-policy",
        at: AT,
      };
    };
    const result = commitDerived(db, {
      source: a,
      items: [item("own", [a]), item("mixed", [a, b]), item("also-own", [a])],
      scope: {
        policy: {
          // a and b cannot be combined: two different scopes
          combinable: (scopes) => (seen.push([...scopes]), scopes.length < 2),
        },
        recordDrop: record,
      },
    });
    expect(written).toEqual(["own", "also-own"]);
    expect(result).toEqual({
      status: "committed",
      written: 2,
      dropped: [
        {
          sourceId: a.sourceId,
          version: a.version,
          kind: "fact",
          itemKeyHash: "hash-of-mixed",
          reason: "scope-policy",
          at: AT,
        },
      ],
    });
    // the policy saw each item's scopes, computed from its lineage's sources
    expect(seen).toEqual([[["team-a"]], [["team-a"], ["team-b"]], [["team-a"]]]);
  });

  it("writes every item when no policy is given (the default policy combines all)", () => {
    const a = save("a", "첫째", "team-a");
    const b = save("b", "첫째", "team-b");
    expect(commitDerived(db, { source: a, items: [item("x", [a, b])] })).toMatchObject({
      status: "committed",
      written: 1,
      dropped: [],
    });
  });
});
