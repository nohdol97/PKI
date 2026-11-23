// S02-T09 `graph.trace`, `graph.paths`, `graph.scope-crossing` (S02-R21~R24, decision 31): the evidence chain and the
// relation paths, read from the canonical rows and judged edge by edge. Few cases by the test-slimming rules: one or two
// per proof, and the two guards that decide what leaves the store (the per-edge `visible`, the whole-path `combinable`).
// Items here are written by the user (no lineage of their own), so a relation's source is the only scope an edge has.
// All data is synthetic.
import {
  addEvidence,
  insertAssertionLink,
  insertItem,
  migrate,
  registerConnectorInstance,
  saveFact,
  saveRelation,
  saveSourceRecord,
  defaultScopePolicy,
  type ScopePolicy,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { describe, expect, it } from "vitest";
import { createProductRegistry } from "./canonical-kinds.ts";
import { GRAPH_EXPANSION_LIMIT, relationPaths, traceChains } from "./graph-read.ts";

const attrs = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
} as const;

/** The scope of a source; a policy below reads it. */
type Scope = string[] | null;
const open = createProductRegistry({ policy: defaultScopePolicy });
const policyOf = (over: Partial<ScopePolicy>) =>
  createProductRegistry({ policy: { ...defaultScopePolicy, ...over } });
/** The two scopes `x` and `y` may not be put together; `secret` is not shown at all. */
const exclusive = policyOf({
  combinable: (scopes) => new Set(scopes.map((s) => s?.join(","))).size <= 1,
});
const hiding = policyOf({ allows: (scopes) => !scopes.some((s) => s?.includes("secret")) });
const throwing = policyOf({
  allows: () => {
    throw new Error("policy down");
  },
});

function kit(db: SqlDriver) {
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
  let counter = 0;
  /** An item the user wrote: no lineage of its own, so only the relations and facts on it carry scopes. */
  const item = (name: string) =>
    db.run(
      `INSERT INTO items (type, name, epistemic, status, observed_at, user_authored)
       VALUES ('Project', ?, 'user-approved', 'verified', ?, 1)`,
      [name, attrs.observedAt],
    ).lastInsertRowid;
  const version = (accessScope: Scope = null) => {
    saveSourceRecord(db, "c1", {
      externalId: `s${++counter}`,
      title: "t",
      body: "body text",
      accessScope,
    });
    return db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
  };
  const relation = (
    subjectId: number,
    type: string,
    objectId: number,
    own: { accessScope?: Scope; versionId?: number; status?: "candidate" | "rejected" } = {},
  ) => {
    const id = saveRelation(db, {
      subjectId,
      type,
      objectId,
      ...attrs,
      ...(own.status ? { status: own.status } : {}),
    }).id;
    addEvidence(db, {
      target: { relationId: id },
      sourceVersionId: own.versionId ?? version(own.accessScope ?? null),
      start: 0,
      end: 4,
      quote: "body",
    });
    return id;
  };
  const fact = (itemId: number, value: string, accessScope: Scope = null) => {
    const id = saveFact(db, { itemId, kind: "target_date", value, ...attrs }).id;
    const versionId = version(accessScope);
    addEvidence(db, {
      target: { factId: id },
      sourceVersionId: versionId,
      start: 5,
      end: 9,
      quote: "text",
    });
    return { id, versionId };
  };
  const merge = (member: number, representative: number) =>
    db.run(
      "INSERT INTO item_merges (member_id, representative_id, active, at) VALUES (?, ?, 1, ?)",
      [member, representative, "2026-11-23T00:00:00.000Z"],
    );
  return { item, version, relation, fact, merge };
}
const fresh = () => {
  const db = openBetterSqlite3(":memory:");
  return { db, ...kit(db) };
};
const ok = (r: ReturnType<typeof relationPaths>) => {
  if (r?.status !== "ok") throw new Error(`not ok: ${JSON.stringify(r)}`);
  return r;
};
const ends = (paths: { from: number; to: number }[][]) =>
  paths.map((p) => [p[0]?.from, ...p.map((h) => h.to)]);

describe("graph.trace (S02-R21)", () => {
  it("an Insight's chain reaches the source span", () => {
    const k = fresh();
    const [x, y] = [k.item("X"), k.item("Y")] as const;
    const f = k.fact(x, "2026-12-05");
    const evidenceId = k.db.all("SELECT id FROM evidence WHERE fact_id = ?", [f.id])[0]
      ?.id as number;
    k.db.run(
      `INSERT INTO insights (rule, x_item_id, y_item_id, epistemic, state, summary)
       VALUES ('r', ?, ?, 'inferred', 'active', 'late')`,
      [x, y],
    );
    k.db.run("INSERT INTO insight_evidence (insight_id, evidence_id) VALUES (1, ?)", [evidenceId]);
    const read = traceChains(k.db, open, { kind: "insight", id: 1 }, "display");
    expect(read?.truncated).toBe(false);
    expect(read?.chains).toEqual([
      [
        {
          edge: "DERIVED_FROM",
          from: { kind: "insight", id: 1 },
          to: { kind: "fact", id: f.id, effectiveUntil: null },
        },
        {
          edge: "SUPPORTS",
          from: { kind: "fact", id: f.id, effectiveUntil: null },
          to: { kind: "evidence", id: evidenceId, start: 5, end: 9 },
        },
        {
          edge: "MENTIONS",
          from: { kind: "evidence", id: evidenceId, start: 5, end: 9 },
          to: { kind: "source-version", id: f.versionId },
        },
      ],
    ]);
    // an unknown start is absent, not an empty chain
    expect(traceChains(k.db, open, { kind: "insight", id: 99 }, "display")).toBeUndefined();
  });

  it("a contradicted fact reaches the other fact's evidence, a merged item its member's, a user row ends in user-input", () => {
    const k = fresh();
    const [r, m] = [k.item("R"), k.item("M")] as const;
    const a = k.fact(r, "2026-12-01");
    const b = k.fact(r, "2026-12-02");
    const linkId = insertAssertionLink(k.db, {
      type: "CONTRADICTS",
      fromFactId: a.id,
      toFactId: b.id,
      createdBy: "rule",
      at: "2026-11-23T00:00:00.000Z",
    }).id;
    const read = traceChains(k.db, open, { kind: "fact", id: a.id }, "display");
    const viaLink = read?.chains.find((c) => c[0]?.edge === "CONTRADICTS");
    expect(viaLink?.map((h) => h.edge)).toEqual(["CONTRADICTS", "SUPPORTS", "MENTIONS"]);
    expect(viaLink?.[0]).toMatchObject({ linkId, direction: "forward" });
    expect(viaLink?.at(-1)?.to).toEqual({ kind: "source-version", id: b.versionId });

    const own = k.fact(m, "2026-12-03");
    k.merge(m, r);
    const item = traceChains(k.db, open, { kind: "item", id: r }, "display");
    const viaMember = item?.chains.find((c) => c[0]?.edge === "SAME_AS");
    expect(viaMember?.map((h) => h.edge)).toEqual(["SAME_AS", "HAS", "SUPPORTS", "MENTIONS"]);
    expect(viaMember?.at(-1)?.to).toEqual({ kind: "source-version", id: own.versionId });

    const typed = k.db.run(
      `INSERT INTO facts (item_id, kind, value, epistemic, status, observed_at, user_authored)
       VALUES (?, 'note', 'mine', 'user-approved', 'verified', ?, 1)`,
      [r, attrs.observedAt],
    ).lastInsertRowid;
    const user = traceChains(k.db, open, { kind: "fact", id: typed }, "display");
    expect(user?.chains.at(0)?.at(-1)?.to).toEqual({ kind: "user-input" });
  });
});

describe("graph.paths (S02-R22)", () => {
  it("A-B-C-D by depth, with the order, the walk's direction and the refusal", () => {
    const k = fresh();
    const [a, b, c, d] = [k.item("A"), k.item("B"), k.item("C"), k.item("D")] as const;
    k.relation(a, "DEPENDS_ON", b);
    k.relation(c, "DEPENDS_ON", b);
    k.relation(c, "DEPENDS_ON", d);
    k.relation(a, "DEPENDS_ON", d, { status: "rejected" });
    const at = (depth: number) => ok(relationPaths(k.db, open, { from: a, depth }, "display"));
    expect(ends(at(1).paths)).toEqual([[a, b]]);
    expect(ends(at(2).paths)).toEqual([
      [a, b],
      [a, b, c],
    ]);
    expect(ends(at(3).paths)).toEqual([
      [a, b],
      [a, b, c],
      [a, b, c, d],
    ]);
    expect(
      at(3)
        .paths.at(2)
        ?.map((h) => h.direction),
    ).toEqual(["forward", "backward", "forward"]);
    expect(at(3)).toEqual(at(3));
    expect(
      ends(ok(relationPaths(k.db, open, { from: a, to: c, depth: 3 }, "display")).paths),
    ).toEqual([[a, b, c]]);
    expect(relationPaths(k.db, open, { from: a, depth: 4 }, "display")).toEqual({
      status: "refused",
      reason: "depth-exceeded",
    });
  });

  it("a member's relation is reported at the representative; the expansion limit truncates", () => {
    const k = fresh();
    const [a, b, member] = [k.item("A"), k.item("B"), k.item("B2")] as const;
    k.merge(member, b);
    const viaMember = k.relation(a, "DEPENDS_ON", member);
    const read = ok(relationPaths(k.db, open, { from: a, depth: 1 }, "display"));
    expect(read.paths).toEqual([
      [{ relationId: viaMember, type: "DEPENDS_ON", direction: "forward", from: a, to: b }],
    ]);

    const star = fresh();
    const hub = star.item("hub");
    const shared = star.version();
    for (let i = 0; i < GRAPH_EXPANSION_LIMIT + 5; i++) {
      star.relation(hub, "DEPENDS_ON", star.item(`n${i}`), { versionId: shared });
    }
    const wide = ok(relationPaths(star.db, open, { from: hub, depth: 1 }, "display"));
    expect(wide.truncated).toBe(true);
    // the start counts as one of the expanded items
    expect(new Set(wide.paths.map((p) => p[0]?.to)).size).toBeLessThanOrEqual(
      GRAPH_EXPANSION_LIMIT,
    );
  });
});

describe("graph.scope-crossing (S02-R24)", () => {
  /** Source x gives A-B, source y gives B-C; a third source `secret` gives B-S when asked. */
  function line(k: ReturnType<typeof fresh>, withHidden: boolean) {
    const [a, b, c] = [k.item("A"), k.item("B"), k.item("C")] as const;
    k.relation(a, "DEPENDS_ON", b, { accessScope: ["x"] });
    k.relation(b, "DEPENDS_ON", c, { accessScope: ["y"] });
    // an extracted item has the lineage of its relations: the end that exists only behind the hidden source is hidden too
    if (withHidden) {
      const hidden = insertItem(k.db, { type: "Project", name: "S", ...attrs });
      k.relation(b, "DEPENDS_ON", hidden, { accessScope: ["secret"] });
    }
    return { a, b, c };
  }

  it("sources that may not be put together: the through path is gone, each edge stays", () => {
    const k = fresh();
    const { a, b, c } = line(k, false);
    expect(ends(ok(relationPaths(k.db, open, { from: a, depth: 2 }, "display")).paths)).toEqual([
      [a, b],
      [a, b, c],
    ]);
    expect(
      ends(ok(relationPaths(k.db, exclusive, { from: a, depth: 2 }, "display")).paths),
    ).toEqual([[a, b]]);
    expect(
      ends(ok(relationPaths(k.db, exclusive, { from: b, depth: 1 }, "display")).paths),
    ).toEqual([
      [b, a],
      [b, c],
    ]);
  });

  it("a hidden source leaves the same answer as a database without it; a policy that throws leaves no path", () => {
    const withIt = fresh();
    const a1 = line(withIt, true);
    const without = fresh();
    const a2 = line(without, false);
    const asked = (k: typeof withIt, who: typeof a1, registry = hiding) => ({
      paths: relationPaths(k.db, registry, { from: who.a, depth: 3 }, "display"),
      toHidden: relationPaths(k.db, registry, { from: who.a, to: 4, depth: 3 }, "display"),
      chains: traceChains(k.db, registry, { kind: "item", id: who.b }, "display"),
    });
    // the hidden rows come last, so the ids line up between the two databases
    expect(asked(withIt, a1)).toEqual(asked(without, a2));
    // the end that exists only behind the hidden source is not found, as in the database without it
    expect(asked(withIt, a1).toHidden).toBeUndefined();
    const thrown = relationPaths(withIt.db, throwing, { from: a1.a, depth: 3 }, "display");
    expect(thrown === undefined || (thrown.status === "ok" && thrown.paths.length === 0)).toBe(
      true,
    );
    expect(() =>
      traceChains(withIt.db, throwing, { kind: "item", id: a1.b }, "display"),
    ).not.toThrow();
  });
});
