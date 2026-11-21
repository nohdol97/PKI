// V02-R14 evidence views (spec "T10이 넘기는 것" 2): an Insight's evidence says
// whether its version is the source's latest, and the source view reads the version
// the evidence points to while naming the latest. Only active Insights are listed.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { listActiveInsights, readEvidenceSource, readInsightEvidence } from "./evidence-view.ts";
import { saveInsight } from "./insights.ts";
import { addEvidence, insertItem, saveFact, type KnowledgeAttributes } from "./knowledge.ts";
import { migrate } from "./migrations.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";

let db: SqlDriver;
const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
};

beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

function version(body: string): number {
  saveSourceRecord(db, "c1", { externalId: "s1", title: "합성 제목", body });
  return db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
}

/** An active Insight whose one evidence quotes "12월" in version 1 of source s1. */
function seed() {
  const v1 = version("🙂 기한은 12월");
  const x = insertItem(db, { ...attrs, type: "Project", name: "X" });
  const y = insertItem(db, { ...attrs, type: "System", name: "Y" });
  const fact = saveFact(db, { ...attrs, itemId: x, kind: "target_date", value: "2026-12-05" });
  const evidenceId = addEvidence(db, {
    target: { factId: fact.id },
    sourceVersionId: v1,
    start: 6,
    end: 9,
    quote: "12월",
  });
  const key = { rule: "dependency_delay", xItemId: x, yItemId: y };
  saveInsight(db, key, { state: "active", summary: "위험(추론)", evidenceIds: [evidenceId] });
  const insightId = listActiveInsights(db)[0]?.id as number;
  return { v1, evidenceId, insightId, key };
}

describe("evidence views", () => {
  it("marks evidence on an older version as not current, and opens that version", () => {
    const { v1, evidenceId, insightId } = seed();
    expect(readInsightEvidence(db, insightId)?.evidence[0]).toMatchObject({
      id: evidenceId,
      version: 1,
      current: true,
    });
    version("🙂 기한은 1월");
    expect(readInsightEvidence(db, insightId)?.evidence[0]).toMatchObject({
      version: 1,
      current: false,
    });
    expect(readEvidenceSource(db, evidenceId)).toEqual({
      evidenceId,
      quote: "12월",
      start: 6,
      end: 9,
      sourceVersion: {
        id: v1,
        version: 1,
        latestVersion: 2,
        title: "합성 제목",
        body: "🙂 기한은 12월",
      },
    });
  });

  it("lists and opens only active Insights", () => {
    const { insightId, key } = seed();
    expect(listActiveInsights(db)).toEqual([
      { id: insightId, epistemic: "inferred", summary: "위험(추론)", evidenceCount: 1 },
    ]);
    saveInsight(db, key, { state: "resolved" });
    expect(listActiveInsights(db)).toEqual([]);
    expect(readInsightEvidence(db, insightId)).toBeUndefined();
  });

  it("finds no source for evidence that does not exist", () => {
    expect(readEvidenceSource(db, 42)).toBeUndefined();
  });
});
