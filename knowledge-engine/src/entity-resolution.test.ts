// S02-T06 `resolution.signals`, `resolution.candidates` and `resolution.scope` (the candidate part): the eight
// signals between two items, the candidates built from them (S02-R9, R10) and kept current by the derivative
// kind `merge-candidate` (R14). One case per signal and per ground; the stored-row cases that need an interval
// end (`organization-mismatch` on stored rows, case ⑦) are S02-T08's. All data is synthetic.
import {
  addEvidence,
  insertItem,
  listInvalidations,
  migrate,
  registerConnectorInstance,
  saveFact,
  saveRelation,
  saveSourceRecord,
  type KnowledgeAttributes,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { seedLegacyTombstone, setStatusForTest, memoryDbTemplate } from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { propagateCanonical } from "./canonical-kinds.ts";
import {
  intervalsOverlap,
  refreshCandidates,
  signalsBetween,
  type Signal,
} from "./entity-resolution.ts";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);

const AT = "2026-11-23T00:00:00.000Z";
const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
};
const permissive = { combinable: () => true };

let db: SqlDriver;
let versions = 0;
beforeEach(() => {
  db = freshDb();
  registerConnectorInstance(db, "c1", "test-fixtures");
  versions = 0;
});
afterEach(() => db.close());

/** A source (one version) and its version row id; the rows built from it cite its whole body. */
function source(name = "doc") {
  const saved = saveSourceRecord(db, "c1", {
    externalId: `${name}-${versions++}`,
    title: name,
    body: `body of ${name}`,
  });
  if (saved.status !== "created") throw new Error(saved.status);
  const id = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
  return { sourceId: saved.sourceId, version: saved.version, id };
}
const cite = (target: { factId: number } | { relationId: number }, from: { id: number }) =>
  addEvidence(db, {
    target,
    sourceVersionId: from.id,
    start: 0,
    end: 4,
    quote: "body",
  });

/** Items, facts and relations that all rest on one source, as an extraction leaves them. */
function world() {
  const from = source();
  const item = (type: string, name: string) => insertItem(db, { type, name, ...attrs });
  const fact = (
    itemId: number,
    kind: string,
    value: string,
    options: { context?: string; status?: KnowledgeAttributes["status"] } = {},
  ) => {
    const saved = saveFact(db, {
      itemId,
      kind,
      value,
      context: options.context ?? null,
      ...attrs,
      status: options.status ?? "candidate",
    });
    cite({ factId: saved.id }, from);
    return saved.id;
  };
  const relation = (
    subjectId: number,
    type: string,
    objectId: number,
    interval: { from: string | null; until: string | null } = { from: null, until: null },
  ) => {
    const saved = saveRelation(db, {
      subjectId,
      type,
      objectId,
      ...attrs,
      validAt: interval.from,
      validUntil: interval.until,
    });
    cite({ relationId: saved.id }, from);
    return saved.id;
  };
  /** A Person carrying a fact, so the item stands on a source's evidence. */
  const person = (name: string) => {
    const id = item("Person", name);
    fact(id, "role", "engineer");
    return id;
  };
  return { from, item, fact, relation, person };
}

const refresh = (
  touched: number[],
  scope = permissive,
  onRefused?: (a: number, b: number) => void,
) => db.transaction(() => refreshCandidates(db, touched, scope, onRefused ? { onRefused } : {}));
const rows = () =>
  db.all("SELECT item_a, item_b, signals, at FROM merge_candidates ORDER BY item_a, item_b");

describe("resolution.signals (S02-R9)", () => {
  it.each<[string, (w: ReturnType<typeof world>) => [number, number], Signal, boolean]>([
    ["same-type", (w) => [w.person("Kim"), w.person("Lee")], "same-type", true],
    [
      "name-match on the processed name",
      (w) => [w.person("Kim  Minsu"), w.person("kim minsu")],
      "name-match",
      true,
    ],
    [
      "name-match on a verified form of one side",
      (w) => {
        const a = w.person("Minsu Kim");
        w.fact(a, "alias.synonym", "Mina", { status: "verified" });
        return [a, w.person("Mina")];
      },
      "name-match",
      true,
    ],
    [
      "a candidate form is not a name",
      (w) => {
        const a = w.person("Minsu Kim");
        w.fact(a, "alias.synonym", "Mina");
        return [a, w.person("Mina")];
      },
      "name-match",
      false,
    ],
    [
      "identifier-match on the same email",
      (w) => {
        const [a, b] = [w.person("Kim"), w.person("Lee")];
        w.fact(a, "identifier.email", "SHARED@example.test");
        w.fact(b, "identifier.email", "shared@example.test");
        return [a, b];
      },
      "identifier-match",
      true,
    ],
    [
      "identifier-mismatch on the same tag with another key",
      (w) => {
        const [a, b] = [w.person("Kim"), w.person("Kim")];
        w.fact(a, "identifier.key", "1001", { context: "hr" });
        w.fact(b, "identifier.key", "1002", { context: "hr" });
        return [a, b];
      },
      "identifier-mismatch",
      true,
    ],
    [
      "keys under different tags are not compared",
      (w) => {
        const [a, b] = [w.person("Kim"), w.person("Kim")];
        w.fact(a, "identifier.key", "1001", { context: "hr" });
        w.fact(b, "identifier.key", "1002", { context: "badge" });
        return [a, b];
      },
      "identifier-mismatch",
      false,
    ],
    [
      "organization-match",
      (w) => {
        const [a, b, org] = [w.person("Kim"), w.person("Kim"), w.item("Organization", "Acme")];
        w.relation(a, "BELONGS_TO", org);
        w.relation(b, "BELONGS_TO", org);
        return [a, b];
      },
      "organization-match",
      true,
    ],
    [
      "a rejected BELONGS_TO gives no organization-match",
      (w) => {
        const [a, b, org] = [w.person("Kim"), w.person("Kim"), w.item("Organization", "Acme")];
        w.relation(a, "BELONGS_TO", org);
        const rejected = w.relation(b, "BELONGS_TO", org);
        setStatusForTest(db, "relation", rejected, "rejected");
        return [a, b];
      },
      "organization-match",
      false,
    ],
    [
      "project-match",
      (w) => {
        const [a, b, project] = [w.person("Kim"), w.person("Kim"), w.item("Project", "Alpha")];
        w.relation(a, "WORKS_ON", project);
        w.relation(b, "WORKS_ON", project);
        return [a, b];
      },
      "project-match",
      true,
    ],
    [
      "shared-neighbor",
      (w) => {
        const [a, b, task] = [w.person("Kim"), w.person("Kim"), w.item("Task", "Report")];
        w.relation(a, "RELATED_TO", task);
        w.relation(b, "RELATED_TO", task);
        return [a, b];
      },
      "shared-neighbor",
      true,
    ],
  ])("%s", (_name, build, signal, on) => {
    const [a, b] = build(world());
    expect(signalsBetween(db, a, b).includes(signal)).toBe(on);
  });

  it("compares nothing across types", () => {
    const w = world();
    const [a, b] = [w.person("Alpha"), w.item("Project", "Alpha")];
    w.fact(b, "role", "x");
    expect(signalsBetween(db, a, b)).toEqual([]);
  });

  it("organization-mismatch needs two known overlapping intervals: different organizations at the same time are a mismatch, at different times or with one interval unknown they are not (S02-R9, ⑦)", () => {
    const w = world();
    const [orgA, orgB] = [w.item("Organization", "Acme"), w.item("Organization", "Beta")];
    const belongs = (person: number, org: number, from: string | null, until: string | null) =>
      w.relation(person, "BELONGS_TO", org, { from, until });
    const pair = (a: [string | null, string | null], b: [string | null, string | null]) => {
      const [p, q] = [w.person("Kim"), w.person("Kim")];
      belongs(p, orgA, ...a);
      belongs(q, orgB, ...b);
      return signalsBetween(db, p, q);
    };
    expect(pair(["2026-01-01", "2026-12-31"], ["2026-06-01", null])).toContain(
      "organization-mismatch",
    );
    // [2026-01-01, 2026-06-01) and [2026-06-01, ...) share no day
    expect(pair(["2026-01-01", "2026-06-01"], ["2026-06-01", null])).not.toContain(
      "organization-mismatch",
    );
    expect(pair([null, null], ["2026-06-01", null])).not.toContain("organization-mismatch");
    // the same organization at disjoint times is not a match either; with one interval unknown it is
    const [p, q, r] = [w.person("Kim"), w.person("Kim"), w.person("Kim")];
    belongs(p, orgA, "2026-01-01", "2026-03-01");
    belongs(q, orgA, "2026-06-01", null);
    belongs(r, orgA, null, null);
    expect(signalsBetween(db, p, q)).not.toContain("organization-match");
    expect(signalsBetween(db, p, r)).toContain("organization-match");
  });

  it("a BELONGS_TO that ends at a Project gives no organization signal (S02F-R2)", () => {
    const w = world();
    const [projA, projB] = [w.item("Project", "Apollo"), w.item("Project", "Borealis")];
    const [p, q] = [w.person("Kim"), w.person("Kim")];
    w.relation(p, "BELONGS_TO", projA, { from: "2026-01-01", until: "2026-12-31" });
    w.relation(q, "BELONGS_TO", projB, { from: "2026-06-01", until: null });
    expect(signalsBetween(db, p, q)).not.toContain("organization-mismatch");
  });

  it("an interval overlaps another only when both are known and share a day (the stored-row cases are S02-T08's)", () => {
    const span = (from: string | null, to: string | null) => ({ from, to });
    expect(intervalsOverlap(span("2026-01-01", "2026-06-30"), span("2026-06-01", null))).toBe(true);
    expect(intervalsOverlap(span("2026-01-01", "2026-03-31"), span("2026-06-01", null))).toBe(
      false,
    );
    expect(intervalsOverlap(span(null, null), span("2026-06-01", null))).toBe(false);
  });
});

describe("resolution.candidates (S02-R10)", () => {
  /** Two Persons named alike, plus whatever the case adds; the pair is the first two ids returned. */
  it.each<[string, (w: ReturnType<typeof world>) => [number, number], boolean]>([
    ["① name only: no row", (w) => [w.person("Kim"), w.person("Kim")], false],
    [
      "② name and organization: a row",
      (w) => {
        const [a, b, org] = [w.person("Kim"), w.person("Kim"), w.item("Organization", "Acme")];
        w.relation(a, "BELONGS_TO", org);
        w.relation(b, "BELONGS_TO", org);
        return [a, b];
      },
      true,
    ],
    [
      "③ name and project: a row",
      (w) => {
        const [a, b, p] = [w.person("Kim"), w.person("Kim"), w.item("Project", "Alpha")];
        w.relation(a, "WORKS_ON", p);
        w.relation(b, "WORKS_ON", p);
        return [a, b];
      },
      true,
    ],
    [
      "④ name and neighbour: a row",
      (w) => {
        const [a, b, t] = [w.person("Kim"), w.person("Kim"), w.item("Task", "Report")];
        w.relation(a, "RELATED_TO", t);
        w.relation(b, "RELATED_TO", t);
        return [a, b];
      },
      true,
    ],
    [
      "⑤ different names, same email: a row",
      (w) => {
        const [a, b] = [w.person("Kim"), w.person("Lee")];
        w.fact(a, "identifier.email", "shared@example.test");
        w.fact(b, "identifier.email", "shared@example.test");
        return [a, b];
      },
      true,
    ],
    [
      "⑥ same name and organization, another key under one tag: no row",
      (w) => {
        const [a, b, org] = [w.person("Kim"), w.person("Kim"), w.item("Organization", "Acme")];
        w.relation(a, "BELONGS_TO", org);
        w.relation(b, "BELONGS_TO", org);
        w.fact(a, "identifier.key", "1001", { context: "hr" });
        w.fact(b, "identifier.key", "1002", { context: "hr" });
        return [a, b];
      },
      false,
    ],
    [
      "⑧ another type: no row",
      (w) => {
        const [a, b, t] = [w.person("Kim"), w.item("System", "Kim"), w.item("Task", "Report")];
        w.fact(b, "role", "x");
        w.relation(a, "RELATED_TO", t);
        w.relation(b, "RELATED_TO", t);
        return [a, b];
      },
      false,
    ],
    [
      "⑨ a distinct mark: no row",
      (w) => {
        const [a, b] = [w.person("Kim"), w.person("Lee")];
        w.fact(a, "identifier.email", "shared@example.test");
        w.fact(b, "identifier.email", "shared@example.test");
        db.run("INSERT INTO item_distinct (item_a, item_b, by, at) VALUES (?, ?, 'user', ?)", [
          Math.min(a, b),
          Math.max(a, b),
          AT,
        ]);
        return [a, b];
      },
      false,
    ],
  ])("%s", (_name, build, expected) => {
    const [a, b] = build(world());
    refresh([a, b]);
    expect(rows().map((r) => [r.item_a, r.item_b])).toEqual(expected ? [[a, b]] : []);
  });

  it("writes the two ids (smaller first), sorted codes and a time, no fixture text; a second run changes nothing", () => {
    const w = world();
    const [a, b] = [w.person("Zebra Name"), w.person("Zebra Name")];
    w.fact(a, "identifier.email", "mail-canary@example.test");
    w.fact(b, "identifier.email", "mail-canary@example.test");
    expect(refresh([b, a])).toEqual({ created: 1, removed: 0, updated: 0 });
    const [row] = rows();
    expect(row).toMatchObject({
      item_a: Math.min(a, b),
      item_b: Math.max(a, b),
      signals: JSON.stringify(["same-type", "name-match", "identifier-match"]),
    });
    expect(Number.isNaN(Date.parse(row?.at as string))).toBe(false);
    expect(JSON.stringify(rows())).not.toMatch(/zebra|canary/i);
    expect(refresh([a, b])).toEqual({ created: 0, removed: 0, updated: 0 });
    expect(rows()[0]?.at).toBe(row?.at);
  });

  it("removes the row when its support is gone and when the two become one group", () => {
    const w = world();
    const [a, b, org] = [w.person("Kim"), w.person("Kim"), w.item("Organization", "Acme")];
    w.relation(a, "BELONGS_TO", org);
    const supporting = w.relation(b, "BELONGS_TO", org);
    refresh([a, b]);
    expect(rows()).toHaveLength(1);
    setStatusForTest(db, "relation", supporting, "rejected");
    expect(refresh([a, b])).toMatchObject({ removed: 1 });
    expect(rows()).toEqual([]);
    setStatusForTest(db, "relation", supporting, "candidate");
    refresh([a, b]);
    expect(rows()).toHaveLength(1);
    db.run(
      "INSERT INTO item_merges (member_id, representative_id, active, at) VALUES (?, ?, 1, ?)",
      [Math.max(a, b), Math.min(a, b), AT],
    );
    refresh([a, b]);
    expect(rows()).toEqual([]);
  });

  it("a deleted source that carried the support removes the candidate in the same propagation, counted in the record", () => {
    const w = world();
    const [a, b, org] = [w.person("Kim"), w.person("Kim"), w.item("Organization", "Acme")];
    const other = source("org-doc");
    const link = (itemId: number) => {
      const saved = saveRelation(db, {
        subjectId: itemId,
        type: "BELONGS_TO",
        objectId: org,
        ...attrs,
      });
      cite({ relationId: saved.id }, other);
    };
    w.fact(org, "role", "x");
    link(a);
    link(b);
    refresh([a, b]);
    expect(rows()).toHaveLength(1);
    db.transaction(() => {
      seedLegacyTombstone(db, {
        sourceId: other.sourceId,
        version: other.version,
        at: AT,
        reason: "source-deleted",
      });
      propagateCanonical(
        db,
        {
          kind: "source-deleted",
          sourceId: other.sourceId,
          coversVersion: other.version,
          lastRevision: null,
        },
        AT,
      );
    });
    expect(rows()).toEqual([]);
    expect(listInvalidations(db, 1)[0]?.removedByKind["merge-candidate"]).toBe(1);
  });
});

describe("resolution.scope (S02-R10, the candidate part)", () => {
  it("makes no row and reports the pair when the policy will not put the two lineages together", () => {
    const w = world();
    const [a, b] = [w.person("Kim"), w.person("Lee")];
    w.fact(a, "identifier.email", "shared@example.test");
    w.fact(b, "identifier.email", "shared@example.test");
    const refused: [number, number][] = [];
    refresh([a, b], { combinable: () => false }, (x, y) => refused.push([x, y]));
    expect(rows()).toEqual([]);
    expect(refused).toEqual([[Math.min(a, b), Math.max(a, b)]]);
    refresh([a, b]);
    expect(rows()).toHaveLength(1);
  });
});
