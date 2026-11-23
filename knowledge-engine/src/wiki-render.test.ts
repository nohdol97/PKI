// K01-C1 (R1, R2): one row of each item type and one active Insight make the twelve kinds of page, the
// claims carry their evidence ids and status, a Metric page holds no check result, and the index and the
// log are read from what is stored.
import {
  listWikiIndex,
  listWikiLog,
  migrate,
  registerConnectorInstance,
  saveInsight,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEPENDS_ON } from "./dependency-delay.ts";
import { renderWikiPages } from "./wiki-render.ts";
import { addFact, addItem, addRelation, addSource, buildWiki, cite } from "./wiki.test-support.ts";

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

// the thirteen catalogue types, the two analytical ones and the page kind each lands in (K01-R1)
const TYPES: [string, string][] = [
  ["Concept", "concepts"],
  ["Project", "projects"],
  ["Person", "people"],
  ["Organization", "organizations"],
  ["System", "systems"],
  ["Decision", "decisions"],
  ["BusinessRule", "business-rules"],
  ["Metric", "metrics"],
  ["Task", "tasks"],
  ["Commitment", "tasks"],
  ["Issue", "issues"],
  ["OpenQuestion", "issues"],
  ["Event", "topics"],
  ["Dependency", "topics"],
  ["Dataset", "topics"],
];

describe("wiki.render: a page per target, by the kind its type maps to", () => {
  it("makes the twelve kinds, each claim with its evidence ids and status, and no check result on a Metric", () => {
    const a = addSource(db, "a", "합성 본문 가");
    const ids = new Map<string, number>();
    for (const [type] of TYPES) {
      const item = addItem(db, type, `${type} 항목`);
      ids.set(type, item);
      cite(db, { factId: addFact(db, item, "memo", `${type} 값`) }, a.id);
    }
    const project = ids.get("Project") as number;
    const system = ids.get("System") as number;
    const relation = addRelation(db, project, DEPENDS_ON, system);
    cite(db, { relationId: relation }, a.id);
    const evidenceId = db.all("SELECT id FROM evidence WHERE relation_id = ?", [relation])[0]
      ?.id as number;
    saveInsight(
      db,
      { rule: "dependency-delay", xItemId: project, yItemId: system },
      { state: "active", summary: "추론 요약", evidenceIds: [evidenceId] },
    );

    const pages = renderWikiPages(db);
    expect([...new Set(pages.map((p) => p.kind))].sort()).toEqual(
      [...new Set([...TYPES.map(([, kind]) => kind), "syntheses"])].sort(),
    );
    expect(new Set(pages.map((p) => p.kind)).size).toBe(12);
    // Event lands in topics; a relation claim names the other page by key
    expect(pages.find((p) => p.title === "Event 항목")?.kind).toBe("topics");
    const projectPage = pages.find((p) => p.key === `projects/${project}`);
    const claims = (projectPage?.body.claims ?? []) as {
      ref: { kind: string; id: number };
      status: string;
      evidence: number[];
      to?: string;
    }[];
    expect(claims.map((c) => c.ref.kind)).toEqual(["fact", "relation"]);
    expect(claims.every((c) => c.status === "candidate" && c.evidence.length === 1)).toBe(true);
    expect(claims[1]?.to).toBe(`systems/${system}`);
    // a Metric page states status only: the same claim shape as any other, no check field
    const metric = pages.find((p) => p.kind === "metrics");
    const metricClaim = (metric?.body.claims[0] ?? {}) as Record<string, unknown>;
    expect(Object.keys(metricClaim).sort()).toEqual(
      Object.keys((claims[0] ?? {}) as Record<string, unknown>).sort(),
    );
    expect(JSON.stringify(metric?.body)).not.toMatch(/check/i);
  });

  it("is the same bytes from the same state, and the index and the log read what was stored", () => {
    const a = addSource(db, "a", "합성 본문 가");
    const item = addItem(db, "Project", "미리내");
    cite(db, { factId: addFact(db, item, "memo", "값") }, a.id);
    const first = renderWikiPages(db);
    expect(JSON.stringify(renderWikiPages(db))).toBe(JSON.stringify(first));

    buildWiki(db);
    expect(listWikiIndex(db)).toEqual([
      { kind: "projects", pages: [{ key: `projects/${item}`, title: "미리내" }] },
    ]);
    expect(listWikiLog(db, { limit: 10 }).map((l) => [l.pageKey, l.action, l.added])).toEqual([
      [`projects/${item}`, "created", 1],
    ]);
  });
});
