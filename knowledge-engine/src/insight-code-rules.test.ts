// P01-C1, C3a, C3b: the code-judged types over the synthetic scenarios of fixtures/p01-insights.json. Each
// supported type has a scenario that makes exactly one Insight and a variant that breaks its condition. No
// Provider is built anywhere in this file: code judges these types alone.
import { readFileSync } from "node:fs";
import { INSIGHT_TYPE_NAMES, INSIGHT_TYPES } from "@pki/contracts";
import {
  addEvidence,
  insertItem,
  listInsightKeys,
  type InsightKey,
  migrate,
  readInsight,
  registerConnectorInstance,
  saveFact,
  saveRelation,
  saveSourceRecord,
  type KnowledgeAttributes,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { setStatusForTest } from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { refreshConflicts } from "./conflicts.ts";
import { INSIGHT_RULES, recomputeInsights } from "./insight-code-rules.ts";
import { locateQuote } from "./quote.ts";

interface FactSpec {
  item: string;
  kind: string;
  value: string;
  source: string;
  quote: string;
  validAt?: string;
  confidence?: number;
}
interface Scenario {
  items: { ref: string; type: string; name: string }[];
  sources: { ref: string; body: string }[];
  facts: FactSpec[];
  relations: RelationSpec[];
}
interface RelationSpec {
  subject: string;
  type: string;
  object: string;
  source: string;
  quote: string;
  observedAt?: string;
}
interface TypeEntry {
  support: "supported" | "unsupported";
  scenario?: Scenario;
  variant?: { facts?: FactSpec[]; relations?: RelationSpec[] };
  expected?: { x: string; y: string; factLines: string[]; evidenceQuotes: string[] };
}
const fixture = JSON.parse(
  readFileSync(new URL("../../fixtures/p01-insights.json", import.meta.url), "utf8"),
) as { types: Record<string, TypeEntry> };

const allow = { combinable: () => true };
let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

const attrs = (over: Partial<KnowledgeAttributes> = {}): KnowledgeAttributes => ({
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
  ...over,
});

/** Writes the scenario (with `facts` replaced for a variant); returns the item id of each ref. */
function seed(
  scenario: Scenario,
  over: { facts?: FactSpec[]; relations?: RelationSpec[] } = {},
): Map<string, number> {
  const facts = over.facts ?? scenario.facts;
  const relations = over.relations ?? scenario.relations;
  const items = new Map(
    scenario.items.map((i) => [i.ref, insertItem(db, { type: i.type, name: i.name, ...attrs() })]),
  );
  const bodies = new Map(scenario.sources.map((s) => [s.ref, s.body]));
  const version = new Map<string, number>();
  for (const s of scenario.sources) {
    saveSourceRecord(db, "c1", { externalId: s.ref, title: s.ref, body: s.body });
    version.set(s.ref, db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number);
  }
  const cite = (target: { factId: number } | { relationId: number }, source: string, q: string) => {
    const span = locateQuote(bodies.get(source) ?? "", q);
    if ("dropped" in span) throw new Error(`fixture quote ${span.dropped}: ${q}`);
    addEvidence(db, {
      target,
      sourceVersionId: version.get(source) as number,
      ...span,
      quote: q,
    });
  };
  for (const f of facts) {
    const { id } = saveFact(db, {
      itemId: items.get(f.item) as number,
      kind: f.kind,
      value: f.value,
      ...attrs({
        validAt: f.validAt ?? null,
        ...(f.confidence === undefined ? {} : { confidence: f.confidence }),
      }),
    });
    cite({ factId: id }, f.source, f.quote);
  }
  for (const r of relations) {
    const { id } = saveRelation(db, {
      subjectId: items.get(r.subject) as number,
      type: r.type,
      objectId: items.get(r.object) as number,
      ...attrs(r.observedAt === undefined ? {} : { observedAt: r.observedAt }),
    });
    cite({ relationId: id }, r.source, r.quote);
  }
  return items;
}

/** Links first, as every execution site does (S02-R19), then the rules. */
const judge = (items: Map<string, number>) => {
  const ids = [...items.values()];
  db.transaction(() => refreshConflicts(db, ids, allow, { at: "2026-11-23T00:00:00.000Z" }));
  return recomputeInsights(db, ids, { scope: allow, at: "2026-11-23T00:00:00.000Z" });
};
const insightsOf = (type: string) =>
  db
    .all("SELECT x_item_id, y_item_id FROM insights WHERE rule = ? AND state = 'active'", [type])
    .map((r) => ({ rule: type, xItemId: r.x_item_id as number, yItemId: r.y_item_id as number }));
const quotesOf = (evidenceIds: number[]) =>
  evidenceIds
    .map((id) => db.all("SELECT quote FROM evidence WHERE id = ?", [id])[0]?.quote as string)
    .sort();

// an llm-judged type has no code scenario: knowledge-engine/src/insight-interpret.test.ts proves it
const supported = Object.entries(fixture.types).filter(
  ([, e]) => e.support === "supported" && e.scenario,
);
const supportedNames = Object.entries(fixture.types)
  .filter(([, e]) => e.support === "supported")
  .map(([type]) => type);

describe("the code rules over the fixture scenarios (P01-C1a, C3a)", () => {
  it.each(supported)(
    "%s: one Insight with the expected lines and quotes; none for the variant",
    (type, entry) => {
      const { scenario, variant, expected } = entry as Required<TypeEntry>;
      const items = seed(scenario);
      judge(items);
      const found = insightsOf(type);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        xItemId: items.get(expected.x),
        yItemId: items.get(expected.y),
      });
      const insight = readInsight(db, found[0] as InsightKey);
      expect(insight?.factLines).toEqual(expected.factLines);
      expect(quotesOf(insight?.evidenceIds ?? [])).toEqual([...expected.evidenceQuotes].sort());
      expect(insight?.reasoningSummary).toBeTruthy();

      db.close();
      db = openBetterSqlite3(":memory:");
      migrate(db);
      registerConnectorInstance(db, "c1", "test-fixtures");
      judge(seed(scenario, variant));
      expect(insightsOf(type)).toEqual([]);
    },
  );
});

describe("the type table and the fixture agree (P01-C1b)", () => {
  it("name the same 13 types with the same support, and no scenario makes an unsupported type", () => {
    expect(Object.keys(fixture.types)).toEqual([...INSIGHT_TYPE_NAMES]);
    for (const t of INSIGHT_TYPES) expect(fixture.types[t.type]?.support).toBe(t.status);
    expect(INSIGHT_RULES.map((r) => r.type).sort()).toEqual(
      INSIGHT_TYPES.filter((t) => t.status === "supported")
        .map((t) => t.type)
        .sort(),
    );
    expect(supportedNames.sort()).toEqual(
      INSIGHT_TYPES.filter((t) => t.status === "supported")
        .map((t) => t.type)
        .sort(),
    );
    // every supported code-judged type keeps a scenario: the filter above must not drop one silently
    const withScenario = supported.map(([type]) => type);
    for (const t of INSIGHT_TYPES.filter(
      (x) => x.status === "supported" && x.judgedBy === "code",
    )) {
      expect(withScenario).toContain(t.type);
    }
    for (const [, entry] of supported) {
      judge(seed((entry as Required<TypeEntry>).scenario));
      db.close();
      db = openBetterSqlite3(":memory:");
      migrate(db);
      registerConnectorInstance(db, "c1", "test-fixtures");
    }
    const unsupportedNames = INSIGHT_TYPES.filter((t) => t.status === "unsupported").map(
      (t) => t.type,
    );
    for (const name of unsupportedNames) {
      expect(listInsightKeys(db, name, [1, 2, 3])).toEqual([]);
    }
  });
});

describe("one Insight per item (P01-R8, C3b)", () => {
  it("two contradicting slots on one item are one conflict with two fact lines, unchanged on a second run", () => {
    const scenario: Scenario = {
      items: [{ ref: "p", type: "Project", name: "미리내 프로젝트" }],
      sources: [
        { ref: "a", body: "목표일은 2026-12-05, 완료일은 2026-12-01 입니다." },
        { ref: "b", body: "목표일은 2026-12-12, 완료일은 2026-12-02 라는 글도 있습니다." },
      ],
      facts: [
        {
          item: "p",
          kind: "target_date",
          value: "2026-12-05",
          source: "a",
          quote: "목표일은 2026-12-05",
        },
        {
          item: "p",
          kind: "target_date",
          value: "2026-12-12",
          source: "b",
          quote: "목표일은 2026-12-12",
        },
        {
          item: "p",
          kind: "completion_date",
          value: "2026-12-01",
          source: "a",
          quote: "완료일은 2026-12-01",
        },
        {
          item: "p",
          kind: "completion_date",
          value: "2026-12-02",
          source: "b",
          quote: "완료일은 2026-12-02",
        },
      ],
      relations: [],
    };
    const items = seed(scenario);
    judge(items);
    const found = insightsOf("conflict");
    expect(found).toHaveLength(1);
    const insight = readInsight(db, found[0] as InsightKey);
    expect(insight?.factLines).toHaveLength(2);
    expect(judge(items).filter((o) => o.outcome !== "unchanged")).toEqual([]);
    expect(readInsight(db, found[0] as InsightKey)?.id).toBe(insight?.id);
  });
});

describe("the status and relation rules in detail (P01-R12)", () => {
  const scenarioOf = (type: string) => (fixture.types[type] as Required<TypeEntry>).scenario;
  const insightOf = (type: string, items: Map<string, number>, ref: string) => {
    const id = items.get(ref) as number;
    return readInsight(db, { rule: type, xItemId: id, yItemId: id });
  };

  it("pending_request: the earliest valid target date is the urgency; a closed status makes it stand down", () => {
    const items = seed(scenarioOf("pending_request"));
    judge(items);
    expect(insightOf("pending_request", items, "r")?.urgencyDate).toBe("2026-12-10");
    // a second, closed status on the same item: the conflict rule's business, this one stands down
    const closed = db.run(
      `INSERT INTO facts (item_id, kind, value, epistemic, status, observed_at)
       VALUES (?, 'status', 'done', 'explicit', 'candidate', '2026-11-21T00:00:00Z')`,
      [items.get("r") as number],
    ).lastInsertRowid;
    addEvidence(db, {
      target: { factId: closed },
      sourceVersionId: 1,
      start: 0,
      end: 4,
      quote: "결제 연",
    });
    const outcomes = recomputeInsights(db, [items.get("r") as number], {
      scope: allow,
      at: "2026-11-23T00:00:00.000Z",
    });
    expect(outcomes.filter((o) => o.key.rule === "pending_request")).toMatchObject([
      { outcome: "resolved" },
    ]);
  });

  it("new_relation: a user's approval of the relation takes the Insight back", () => {
    const items = seed(scenarioOf("new_relation"));
    judge(items);
    expect(insightsOf("new_relation")).toHaveLength(1);
    setStatusForTest(db, "relation", 1, "verified");
    judge(items);
    expect(insightsOf("new_relation")).toEqual([]);
  });

  it("a status written with another case still counts as its value", () => {
    const entry = scenarioOf("open_issue");
    const items = seed(entry, { facts: [{ ...entry.facts[0], value: "In_Progress" } as FactSpec] });
    judge(items);
    expect(insightsOf("open_issue")).toHaveLength(1);
  });
});
