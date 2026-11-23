// P01-D26 (a fix to D16): the text of an `insight:<id>` candidate carries the names of its two items, so it is
// graded, and the scope policy asked, over the Insight's lineage AND the group lineage of X and Y (as an item
// candidate is graded); an item with no lineage of its own (a user-made one) makes it unsourced. Also the
// deletion cases the rework checked against #231 (D13): evidence that goes while the text stays clears the reading
// and the opportunity, and an opportunity never stays active on an empty evidence set. Synthetic data.
import type { BrokerResult } from "@pki/providers";
import {
  addEvidence,
  insertItem,
  insightBasis,
  INSIGHT_INTERPRET_KIND,
  migrate,
  readInsight,
  readInsightById,
  registerConnectorInstance,
  saveFact,
  saveInsight,
  saveSourceRecord,
  setInsightInterpret,
  writeInsightInterpretation,
  type KnowledgeAttributes,
  type ScopePolicy,
  type SqlDriver,
  type StoredInsight,
  type StoredJob,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProductRegistry, derivativeRegistry } from "./canonical-kinds.ts";
import { recomputeInsights } from "./insight-code-rules.ts";
import { purgeSource } from "./purge.test-support.ts";
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
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
  item = insertItem(db, { type: "Project", name: "미리내 프로젝트", ...attrs });
});
afterEach(() => db.close());

/** A source with a body; returns its version row id. */
function source(externalId: string, body: string, accessScope?: string[]): number {
  saveSourceRecord(db, "c1", {
    externalId,
    title: externalId,
    body,
    ...(accessScope ? { accessScope } : {}),
  });
  return db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
}
function cite(factId: number, version: number, quote: string): void {
  const body = db.all("SELECT body FROM source_versions WHERE id = ?", [version])[0]
    ?.body as string;
  const start = [...body.slice(0, body.indexOf(quote))].length;
  addEvidence(db, {
    target: { factId },
    sourceVersionId: version,
    start,
    end: start + [...quote].length,
    quote,
  });
}
const sourceOf = (version: number) =>
  db.all("SELECT source_id FROM source_versions WHERE id = ?", [version])[0]?.source_id as number;
const fact = (kind: string, value: string) =>
  saveFact(db, { itemId: item, kind, value, ...attrs }).id;

/** The schedule_conflict Insight: the target date cited by v1 and v3, the completion date by v2. */
function scenario() {
  const v1 = source("s1", "목표일은 2026-12-01 입니다.");
  const v2 = source("s2", "완료일은 2026-12-10 입니다.");
  const v3 = source("s3", "목표일은 2026-12-01 입니다.");
  const target = fact("target_date", "2026-12-01");
  cite(target, v1, "목표일은 2026-12-01");
  cite(target, v3, "목표일은 2026-12-01");
  cite(fact("completion_date", "2026-12-10"), v2, "완료일은 2026-12-10");
  recomputeInsights(db, [item], { scope: allow, at });
  const key = { rule: "schedule_conflict", xItemId: item, yItemId: item };
  return { key, parent: readInsight(db, key) as StoredInsight, v1, v2, v3 };
}

describe("the insight candidate is graded by the items' lineage too (P01-D26)", () => {
  it("adds the lineage of the items whose names it carries, and is unsourced when an item has none", () => {
    const { parent } = scenario();
    const named = source("named", "미리내 프로젝트 코드 KX-9");
    cite(fact("identifier.key", "KX-9"), named, "KX-9");
    const lookup = knowledgeCandidates(db).lookup;
    const found = lookup(`insight:${parent.id}`);
    expect(found?.evidenceSourceVersionIds).toContain(String(named));
    expect(found?.nameUnsourced).toBe(false);
    const userMade = knowledgeCandidates(db, {
      lineage: (d, ref) =>
        ref.kind === "item" && ref.id === String(item) ? [] : derivativeRegistry.lineage(d, ref),
    });
    expect(userMade.lookup(`insight:${parent.id}`)?.nameUnsourced).toBe(true);
  });

  it("asks the scope policy over that union: a source that only names the item makes the job end without a call", async () => {
    const { parent } = scenario();
    const named = source("named", "미리내 프로젝트 코드 KX-9", ["z"]);
    cite(fact("identifier.key", "KX-9"), named, "KX-9");
    setInsightInterpret(db, true, new Date());
    const job = {
      id: 1,
      leaseToken: 1,
      kind: INSIGHT_INTERPRET_KIND,
      target: `${parent.id}#${insightBasis(parent)}`,
    } as unknown as StoredJob;
    const apart: ScopePolicy = {
      compare: () => "equal",
      strictest: (scopes) => scopes[0] ?? null,
      combinable: (scopes) => new Set(scopes.map((s) => JSON.stringify(s))).size <= 1,
      allows: () => true,
    };
    const call = vi.fn<(raw: unknown) => Promise<BrokerResult>>(
      async () =>
        ({
          status: "ok",
          output: {},
        }) as BrokerResult,
    );
    const handler = createInsightInterpretHandler({
      db,
      registry: createProductRegistry({ policy: apart }),
    });
    await handler(job, { broker: { call } });
    expect(call).not.toHaveBeenCalled();
  });
});

describe("evidence that goes while the text stays (rework M2 check against #231, P01-R3)", () => {
  it("clears the reading and resolves the opportunity; an opportunity on an empty evidence set is not kept", () => {
    const { key, parent, v1, v3 } = scenario();
    writeInsightInterpretation(db, parent.id, insightBasis(parent), {
      reasoningSummary: "합성 해석",
      impact: 50,
      actionability: 50,
    });
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
    // the first source is deleted (the real purge path); its fact is still cited by the third, so the fact lines are the same
    purgeSource(db, sourceOf(v1), { reason: "source-deleted", at: "2026-11-24T00:00:00.000Z" });
    expect(readInsightById(db, parent.id)).toMatchObject({ state: "active", interpretation: null });
    expect(readInsight(db, oppKey)).toMatchObject({ state: "resolved" });

    // the case that left an active opportunity with no evidence and no input: its parent's evidence moved on
    saveInsight(db, oppKey, {
      state: "active",
      summary: "합성 기회",
      factLines: parent.factLines,
      reasoningSummary: "합성",
      confidence: 40,
      urgencyDate: parent.urgencyDate,
      evidenceIds: [],
      userInputs: [],
      changedAt: at,
    });
    purgeSource(db, sourceOf(v3), { reason: "source-deleted", at: "2026-11-25T00:00:00.000Z" });
    recomputeInsights(db, [item], { scope: allow, at: "2026-11-25T00:00:00.000Z" });
    expect(readInsight(db, oppKey)?.state).not.toBe("active");
  });
});
