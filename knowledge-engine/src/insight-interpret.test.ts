// P01-C1a (opportunity), C3a (R7, D12-D18): the Insight interpretation job and the `opportunity` rule. The
// Broker is a double here; the real one is exercised in providers/src/broker.insight-interpret.test.ts.
import {
  addEvidence,
  insertItem,
  migrate,
  readInsight,
  registerConnectorInstance,
  saveFact,
  saveInsight,
  saveSourceRecord,
  type InsightKey,
  type KnowledgeAttributes,
  type SqlDriver,
  type StoredInsight,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recomputeInsights } from "./insight-code-rules.ts";

const allow = { combinable: () => true };
const at = "2026-11-23T00:00:00.000Z";
const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
};

let db: SqlDriver;
let item: number;
let sourceVersion = 0;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
  item = insertItem(db, { type: "Project", name: "미리내 프로젝트", ...attrs });
  sourceVersion = 0;
});
afterEach(() => db.close());

/** A fact of the item with one evidence row; each call stores its own source. */
function fact(kind: string, value: string): void {
  const body = `${kind} ${value}`;
  saveSourceRecord(db, "c1", { externalId: `e${++sourceVersion}`, title: kind, body });
  const version = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
  const { id } = saveFact(db, { itemId: item, kind, value, ...attrs });
  addEvidence(db, {
    target: { factId: id },
    sourceVersionId: version,
    start: 0,
    end: body.length,
    quote: body,
  });
}

/** Judges the rules; the parent here is the schedule_conflict of one item (target before completion). */
const judge = () => recomputeInsights(db, [item], { scope: allow, at });
const parentKey = (): InsightKey => ({ rule: "schedule_conflict", xItemId: item, yItemId: item });
const oppKey = (): InsightKey => ({ rule: "opportunity", xItemId: item, yItemId: item });

/** What the handler writes for an opportunity (D18): the parent's evidence and lines, the statement as summary. */
function propose(parent: StoredInsight): number {
  return saveInsight(db, oppKey(), {
    state: "active",
    summary: "합성 기회 문장",
    factLines: parent.factLines,
    reasoningSummary: "합성 코드 이유",
    confidence: Math.min(parent.confidence ?? 40, 40),
    urgencyDate: parent.urgencyDate,
    evidenceIds: parent.evidenceIds,
    userInputs: parent.userInputs,
    linkIds: parent.linkIds,
    changedAt: at,
  });
}

describe("the opportunity rule (P01-C1a, D18)", () => {
  it("stands while the parent Insight is unchanged and is resolved after the parent's fact line changes", () => {
    fact("target_date", "2026-12-01");
    fact("completion_date", "2026-12-10");
    judge();
    const parent = readInsight(db, parentKey()) as StoredInsight;
    expect(parent.state).toBe("active");
    propose(parent);

    expect(judge().filter((o) => o.outcome !== "unchanged")).toEqual([]);
    const stands = readInsight(db, oppKey());
    expect(stands).toMatchObject({ state: "active", summary: "합성 기회 문장" });
    expect(stands?.evidenceIds).toEqual(parent.evidenceIds);
    expect(stands?.confidence).toBeLessThanOrEqual(40);

    fact("completion_date", "2026-12-20");
    judge();
    expect(readInsight(db, oppKey())).toMatchObject({ state: "resolved", summary: null });
    // a resolved row is not revived by the rule: only a new proposal brings it back
    expect(judge().filter((o) => o.key.rule === "opportunity")).toEqual([
      { key: oppKey(), outcome: "unchanged" },
    ]);
  });
});
