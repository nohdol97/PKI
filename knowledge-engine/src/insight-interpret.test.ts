// P01-C1a (opportunity), C3a (R7, D12-D18): the Insight interpretation job and the `opportunity` rule. The
// Broker is a double here; the real one is exercised in providers/src/broker.insight-interpret.test.ts.
import {
  addEvidence,
  insertItem,
  insightBasis,
  INSIGHT_INTERPRET_KIND,
  migrate,
  readInsightById,
  setInsightInterpret,
  type DerivedItem,
  type StoredJob,
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
import type { BrokerResult } from "@pki/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recomputeInsights } from "./insight-code-rules.ts";
import { createInsightInterpretHandler } from "./insight-interpret.ts";
import { knowledgeCandidates } from "./linking.ts";

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

describe("the interpretation job (P01-C3a, D12-D18)", () => {
  const answer = (opportunity: { statement: string } | null = null) => ({
    reasoningSummary: "합성 해석",
    impact: 80,
    actionability: 20,
    opportunity,
  });
  const broker = (result: BrokerResult) => ({
    call: vi.fn<(raw: unknown) => Promise<BrokerResult>>(async () => result),
  });
  const ok = (output: unknown): BrokerResult => ({ status: "ok", output }) as BrokerResult;

  /** The schedule_conflict Insight, the setting on, and the job the queue made for it. */
  function setUp(): { parent: StoredInsight; job: StoredJob } {
    fact("target_date", "2026-12-01");
    fact("completion_date", "2026-12-10");
    judge();
    expect(setInsightInterpret(db, true, new Date())).toBe(1);
    const parent = readInsight(db, parentKey()) as StoredInsight;
    const job = {
      id: 1,
      leaseToken: 1,
      kind: INSIGHT_INTERPRET_KIND,
      target: `${parent.id}#${insightBasis(parent)}`,
    } as unknown as StoredJob;
    return { parent, job };
  }
  const run = async (job: StoredJob, b: { call: (raw: unknown) => Promise<BrokerResult> }) => {
    const result = await createInsightInterpretHandler({ db })(job, { broker: b });
    if (result.status === "succeeded")
      db.transaction(() => result.items.forEach((i: DerivedItem) => i.write(db)));
    return result;
  };

  it("stores only the three interpretation columns; judging again is unchanged and keeps them", async () => {
    const { parent, job } = setUp();
    const b = broker(ok(answer()));
    await run(job, b);
    expect(b.call.mock.calls[0]?.[0]).toMatchObject({
      taskKind: "insight-interpret",
      candidateItemIds: [String(item), `insight:${parent.id}`],
      sourceVersionIds: expect.any(Array) as string[],
    });
    const after = readInsightById(db, parent.id) as StoredInsight;
    expect(after).toEqual({
      ...parent,
      interpretation: { reasoningSummary: "합성 해석", impact: 80, actionability: 20 },
    });
    expect(judge().filter((o) => o.outcome !== "unchanged")).toEqual([]);
    expect(readInsightById(db, parent.id)?.interpretation).not.toBeNull();
  });

  it("hands a blocked Broker result back and leaves the row as it was; nothing is sent while the setting is off", async () => {
    const { parent, job } = setUp();
    const blocked = { status: "blocked", reason: "consent-missing" } as unknown as BrokerResult;
    expect(await run(job, broker(blocked))).toEqual(blocked);
    expect(readInsightById(db, parent.id)).toEqual(parent);

    setInsightInterpret(db, false, new Date());
    const silent = broker(ok(answer()));
    await run(job, silent);
    expect(silent.call).not.toHaveBeenCalled();
  });

  it("writes one opportunity with the parent's evidence and drops a second proposal while it is active", async () => {
    const { parent, job } = setUp();
    await run(job, broker(ok(answer({ statement: "합성 기회 A" }))));
    const opp = readInsight(db, oppKey());
    expect(opp).toMatchObject({ state: "active", summary: "합성 기회 A", epistemic: "inferred" });
    expect(opp?.evidenceIds).toEqual(parent.evidenceIds);
    expect(opp?.factLines).toEqual(parent.factLines);
    expect(opp?.confidence).toBeLessThanOrEqual(40);

    // the parent is interpreted again and proposes another: dropped, the first stays
    const again = readInsightById(db, parent.id) as StoredInsight;
    saveInsight(db, parentKey(), {
      state: "active",
      summary: again.summary as string,
      factLines: again.factLines,
      reasoningSummary: again.reasoningSummary,
      confidence: again.confidence,
      urgencyDate: again.urgencyDate,
      evidenceIds: again.evidenceIds,
      changedAt: at,
    });
    const next = {
      ...job,
      target: `${parent.id}#${insightBasis(readInsightById(db, parent.id) as StoredInsight)}`,
    };
    await run(next as StoredJob, broker(ok(answer({ statement: "합성 기회 B" }))));
    expect(readInsight(db, oppKey())?.summary).toBe("합성 기회 A");
  });

  it("offers the Insight as a graded candidate: its lineage, and the strictest class when it used a user input", () => {
    const { parent } = setUp();
    const lookup = knowledgeCandidates(db).lookup(`insight:${parent.id}`);
    expect(lookup?.name).toContain(parent.factLines[0] as string);
    expect(lookup?.evidenceSourceVersionIds).toHaveLength(2);
    expect(lookup?.nameUnsourced).toBe(false);

    const factId = db.all("SELECT id FROM facts ORDER BY id")[0]?.id as number;
    saveInsight(db, parentKey(), {
      state: "active",
      summary: "합성",
      evidenceIds: parent.evidenceIds,
      userInputs: [{ kind: "fact", id: factId }],
    });
    expect(knowledgeCandidates(db).lookup(`insight:${parent.id}`)?.nameUnsourced).toBe(true);
  });
});
