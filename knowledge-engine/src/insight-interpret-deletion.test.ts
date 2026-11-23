// P01-R3, D13: text a model wrote after reading a source does not stay at rest once that source is deleted,
// even when the Insight's own fields are unchanged (the interpretation columns and an `opportunity` row).
import {
  addEvidence,
  insertItem,
  insightBasis,
  migrate,
  readInsight,
  readInsightById,
  registerConnectorInstance,
  saveFact,
  saveInsight,
  saveSourceRecord,
  userDecisions,
  writeInsightInterpretation,
  type KnowledgeAttributes,
  type SqlDriver,
  type StoredInsight,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recomputeInsights } from "./insight-code-rules.ts";
import { propagateNewVersion } from "./propagation.ts";
import { purgeSource } from "./purge.test-support.ts";
import { memoryDbTemplate } from "@pki/testkit";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);

const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
};
const at = "2026-11-23T00:00:00.000Z";
let db: SqlDriver;
beforeEach(() => {
  db = freshDb();
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

/** An interpreted Insight with an active opportunity; `other` is a source only its lineage (not its evidence) holds. */
function seed() {
  const item = insertItem(db, { type: "Project", name: "미리내 프로젝트", ...attrs });
  const source = (ext: string, kind: string, value: string) => {
    const body = `${kind} ${value}`;
    saveSourceRecord(db, "c1", { externalId: ext, title: kind, body });
    const v = db.all("SELECT max(id) AS id, max(source_id) AS s FROM source_versions")[0];
    const { id } = saveFact(db, { itemId: item, kind, value, ...attrs });
    addEvidence(db, {
      target: { factId: id },
      sourceVersionId: v?.id as number,
      start: 0,
      end: body.length,
      quote: body,
    });
    return v?.s as number;
  };
  // a user-written target date has no evidence: its lineage is the item's, so the other source is read too
  userDecisions.add(db, {
    kind: "fact",
    itemId: item,
    factKind: "target_date",
    value: "2026-12-01",
  });
  source("e1", "completion_date", "2026-12-10");
  const other = source("e2", "owner", "합성 담당자");
  recomputeInsights(db, [item], { scope: { combinable: () => true }, at });
  const key = { rule: "schedule_conflict", xItemId: item, yItemId: item };
  const parent = readInsight(db, key) as StoredInsight;
  expect(parent.userInputs).toHaveLength(1);
  expect(
    writeInsightInterpretation(db, parent.id, insightBasis(parent), {
      reasoningSummary: "합성 해석",
      impact: 50,
      actionability: 50,
    }),
  ).toBe(true);
  const oppKey = { ...key, rule: "opportunity" };
  saveInsight(db, oppKey, {
    state: "active",
    summary: "합성 기회",
    factLines: parent.factLines,
    reasoningSummary: "합성",
    confidence: 40,
    urgencyDate: parent.urgencyDate,
    evidenceIds: parent.evidenceIds,
    userInputs: parent.userInputs,
    linkIds: parent.linkIds,
    changedAt: at,
  });

  return { other, parent, oppKey };
}

describe("a source the interpretation read changes (P01-R3, D13)", () => {
  it("deleting it clears the interpretation and resolves the opportunity though the Insight's own fields are unchanged", () => {
    const { other, parent, oppKey } = seed();
    purgeSource(db, other, { reason: "source-deleted", at: "2026-11-23T01:00:00.000Z" });
    expect(readInsightById(db, parent.id)).toMatchObject({ state: "active", interpretation: null });
    expect(readInsight(db, oppKey)).toMatchObject({ state: "resolved", summary: null });
  });

  it("a new version of it leaves the interpretation and the active opportunity in place", () => {
    const { other, parent, oppKey } = seed();
    saveSourceRecord(db, "c1", { externalId: "e2", title: "owner", body: "owner 새 담당자" });
    propagateNewVersion(db, other);
    expect(readInsightById(db, parent.id)).toMatchObject({
      state: "active",
      interpretation: { reasoningSummary: "합성 해석" },
    });
    expect(readInsight(db, oppKey)).toMatchObject({ state: "active", summary: "합성 기회" });
  });
});
