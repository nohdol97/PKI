// scope_policy_drops (I04-R4, R11, I04-T09): what commitDerived leaves out because
// the scope policy refuses the item's lineage, kept as content-free rows. The
// commit's policy answer is the policy's; an error of the policy is a refusal
// (fail closed); closeJob and checkpointJob hand the scope to commitDerived, but a
// projection job never meets it. `scope.policy` (storage part).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { commitDerived } from "./commit-derived.ts";
import {
  createCommitScope,
  clearScopePolicyDrops,
  countScopePolicyDrops,
  scopePolicyDropSources,
  type CommitScope,
  type DerivedItem,
  type ScopePolicy,
  type SourceVersionRef,
} from "./index.ts";
import { checkpointJob, closeJob, leaseNextJob, readJob, registerJob } from "./jobs.ts";
import { migrate } from "./migrations.ts";
import { PROJECTION_REMOVE_KIND } from "./job-kinds.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

const NOW = "2026-11-22T01:02:03.000Z";
const save = (name: string, scope: string | null) => {
  const saved = saveSourceRecord(db, "c1", { externalId: name, title: `제목 ${name}`, body: name });
  if (saved.status !== "created") throw new Error(saved.status);
  db.run("UPDATE sources SET access_scope = ? WHERE id = ?", [scope, saved.sourceId]);
  return { sourceId: saved.sourceId, version: saved.version };
};

/** a and b cannot be put together (the test policy of C1 `scope.policy`). */
const noAB: Pick<ScopePolicy, "combinable"> = {
  combinable: (scopes) => {
    const names = new Set(scopes.flatMap((s) => s ?? []));
    return !(names.has("a") && names.has("b"));
  },
};
const scopeOf = (policy: Pick<ScopePolicy, "combinable">): CommitScope =>
  createCommitScope({ policy, now: () => NOW });

const written: string[] = [];
beforeEach(() => void (written.length = 0));
const item = (key: string, lineage: SourceVersionRef[]): DerivedItem => ({
  kind: "fact",
  itemKey: key,
  lineage,
  write: () => void written.push(key),
});
const rows = () =>
  db.all(
    "SELECT source_id, version, kind, item_key_hash, reason, at FROM scope_policy_drops ORDER BY id",
  );

describe("recording a refused item (I04-R11)", () => {
  it("leaves out only the refused item, wherever it stands in the list, and records each refusal", () => {
    const a = save("a", '["a"]');
    const b = save("b", '["b"]');
    const result = db.transaction(() =>
      commitDerived(db, {
        source: b,
        scope: scopeOf(noAB),
        items: [
          item("ok-1", [b]),
          item("mixed-1", [b, a]),
          item("ok-2", [b]),
          item("mixed-2", [a, b]),
          item("ok-3", [b]),
        ],
      }),
    );
    expect(written).toEqual(["ok-1", "ok-2", "ok-3"]);
    expect(result.status).toBe("committed");
    if (result.status !== "committed") return;
    expect(result.written).toBe(3);
    expect(result.dropped.map((d) => [d.sourceId, d.version, d.kind, d.reason, d.at])).toEqual([
      [b.sourceId, b.version, "fact", "scope-policy", NOW],
      [b.sourceId, b.version, "fact", "scope-policy", NOW],
    ]);
    // the returned records are the stored rows
    expect(
      rows().map((r) => ({
        sourceId: r.source_id,
        version: r.version,
        kind: r.kind,
        itemKeyHash: r.item_key_hash,
        reason: r.reason,
        at: r.at,
      })),
    ).toEqual(result.dropped);
    expect(countScopePolicyDrops(db)).toBe(2);
  });

  it("keeps no item content: the key is a keyed hash, and two keys give two hashes", () => {
    const a = save("a", '["a"]');
    const b = save("b", '["b"]');
    db.transaction(() =>
      commitDerived(db, {
        source: b,
        scope: scopeOf(noAB),
        items: [item("qzcanary-name 값", [a, b]), item("other key", [a, b])],
      }),
    );
    const [one, two] = rows().map((r) => r.item_key_hash as string);
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(two).toMatch(/^[0-9a-f]{64}$/);
    expect(one).not.toBe(two);
    expect(JSON.stringify(db.all("SELECT * FROM scope_policy_drops"))).not.toContain("qzcanary");
  });

  it("records the same refused item once, so a second extraction does not double the count", () => {
    const a = save("a", '["a"]');
    const b = save("b", '["b"]');
    for (let i = 0; i < 2; i++) {
      db.transaction(() =>
        commitDerived(db, { source: b, scope: scopeOf(noAB), items: [item("same", [a, b])] }),
      );
    }
    expect(countScopePolicyDrops(db)).toBe(1);
  });

  it("writes everything and records nothing when no scope is given (the default policy)", () => {
    const a = save("a", '["a"]');
    const b = save("b", '["b"]');
    const result = db.transaction(() =>
      commitDerived(db, { source: b, items: [item("mixed", [a, b])] }),
    );
    expect(result).toEqual({ status: "committed", written: 1, dropped: [] });
    expect(countScopePolicyDrops(db)).toBe(0);
  });

  it("does not ask the policy, nor record, for a stale result (stale is not a refusal)", () => {
    const a = save("a", '["a"]');
    const b = save("b", '["b"]');
    db.run("DELETE FROM source_versions WHERE source_id = ?", [a.sourceId]);
    let asked = 0;
    const counting = {
      combinable: () => {
        asked++;
        return false;
      },
    };
    const result = db.transaction(() =>
      commitDerived(db, { source: b, scope: scopeOf(counting), items: [item("x", [a, b])] }),
    );
    expect(result).toEqual({ status: "stale", cause: "lineage-covered" });
    expect(asked).toBe(0);
    expect(countScopePolicyDrops(db)).toBe(0);
  });

  it("anchors a job without a source version to the item's first lineage version", () => {
    const a = save("a", '["a"]');
    const b = save("b", '["b"]');
    db.transaction(() =>
      commitDerived(db, { source: null, scope: scopeOf(noAB), items: [item("x", [b, a])] }),
    );
    expect(rows().map((r) => [r.source_id, r.version])).toEqual([[b.sourceId, b.version]]);
  });

  it("refuses to drop an item it cannot anchor (no source, no lineage): the commit throws, nothing is written", () => {
    const never: Pick<ScopePolicy, "combinable"> = { combinable: () => false };
    expect(() =>
      db.transaction(() =>
        commitDerived(db, { source: null, scope: scopeOf(never), items: [item("x", [])] }),
      ),
    ).toThrow(RangeError);
    expect(countScopePolicyDrops(db)).toBe(0);
  });
});

describe("a policy that cannot judge refuses (fail closed, I04-R14)", () => {
  it("drops and records the item when combinable throws, and still writes the items it did judge", () => {
    const a = save("a", '["a"]');
    const b = save("b", '["b"]');
    const flaky: Pick<ScopePolicy, "combinable"> = {
      combinable: (scopes) => {
        if (scopes.length > 1) throw new Error("cannot judge");
        return true;
      },
    };
    const result = db.transaction(() =>
      commitDerived(db, {
        source: b,
        scope: scopeOf(flaky),
        items: [item("one", [b]), item("two", [a, b]), item("three", [b])],
      }),
    );
    expect(written).toEqual(["one", "three"]);
    expect(result).toMatchObject({ status: "committed", written: 2 });
    expect(countScopePolicyDrops(db)).toBe(1);
  });

  it("treats a policy that answers something other than true as a refusal", () => {
    const b = save("b", '["b"]');
    const odd = { combinable: () => "yes" } as unknown as Pick<ScopePolicy, "combinable">;
    db.transaction(() =>
      commitDerived(db, { source: b, scope: scopeOf(odd), items: [item("x", [b])] }),
    );
    expect(written).toEqual([]);
    expect(countScopePolicyDrops(db)).toBe(1);
  });
});

describe("the records of a source (I04-R15)", () => {
  it("lists the sources that have a record, and clears one source's records only", () => {
    const a = save("a", '["a"]');
    const b = save("b", '["b"]');
    const c = save("c", '["a"]');
    db.transaction(() => {
      commitDerived(db, { source: b, scope: scopeOf(noAB), items: [item("x", [a, b])] });
      commitDerived(db, { source: c, scope: scopeOf(noAB), items: [item("y", [c, b])] });
    });
    expect(scopePolicyDropSources(db)).toEqual([b.sourceId, c.sourceId]);
    expect(clearScopePolicyDrops(db, b.sourceId)).toBe(1);
    expect(scopePolicyDropSources(db)).toEqual([c.sourceId]);
    expect(countScopePolicyDrops(db)).toBe(1);
  });
});

function leased(kind: string, sourceId: number, version: number) {
  registerJob(db, { kind, sourceId, fenceVersion: version, at: new Date(0) });
  const job = leaseNextJob(db, { kinds: [kind], now: new Date(0), leaseMs: 1000 });
  if (!job) throw new Error("expected a job");
  return job;
}

describe("closeJob and checkpointJob hand the scope to commitDerived (I04-T09)", () => {
  it("closes an extraction succeeded, not superseded, when the policy refuses one of its items", () => {
    const a = save("a", '["a"]');
    const b = save("b", '["b"]');
    const job = leased("extract", b.sourceId, b.version);
    const status = closeJob(
      db,
      job,
      { status: "succeeded", items: [item("keep", [b]), item("mixed", [a, b])] },
      new Date(0),
      scopeOf(noAB),
    );
    expect(status).toBe("succeeded");
    expect(readJob(db, job.id)?.status).toBe("succeeded");
    expect(written).toEqual(["keep"]);
    expect(countScopePolicyDrops(db)).toBe(1);
  });

  it("applies the scope to a checkpoint's write too", () => {
    const b = save("b", '["b"]');
    const job = leased("extract", b.sourceId, b.version);
    const saved = checkpointJob(
      db,
      job,
      { fields: [], value: {}, write: () => void written.push("lone") },
      new Date(0),
      scopeOf({ combinable: () => false }),
    );
    // a lone write is one item of the job's own version (single source): refused here by a policy that refuses everything
    expect(saved).toBe("saved");
    expect(written).toEqual([]);
    expect(countScopePolicyDrops(db)).toBe(1);
  });

  it("never passes the scope for a projection job: its write runs whatever the policy says", () => {
    const b = save("b", '["b"]');
    const job = leased(PROJECTION_REMOVE_KIND, b.sourceId, b.version);
    const status = closeJob(
      db,
      job,
      { status: "succeeded", write: () => void written.push("removed") },
      new Date(0),
      scopeOf({ combinable: () => false }),
    );
    expect(status).toBe("succeeded");
    expect(written).toEqual(["removed"]);
    expect(countScopePolicyDrops(db)).toBe(0);
  });
});
