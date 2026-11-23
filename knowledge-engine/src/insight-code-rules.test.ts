// P01-C1, C3a, C3b: the code-judged types over the synthetic scenarios of fixtures/p01-insights.json. Each
// supported type has a scenario that makes exactly one Insight and a variant that breaks its condition. No
// Provider is built anywhere in this file: code judges these types alone.
import { readFileSync } from "node:fs";
import { INSIGHT_TYPE_NAMES, INSIGHT_TYPES } from "@pki/contracts";
import {
  addEvidence,
  insertItem,
  listInsightKeys,
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
  relations: { subject: string; type: string; object: string; source: string; quote: string }[];
}
interface TypeEntry {
  support: "supported" | "unsupported";
  scenario?: Scenario;
  variant?: { facts: FactSpec[] };
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
function seed(scenario: Scenario, facts: FactSpec[] = scenario.facts): Map<string, number> {
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
  for (const r of facts === scenario.facts ? scenario.relations : scenario.relations) {
    const { id } = saveRelation(db, {
      subjectId: items.get(r.subject) as number,
      type: r.type,
      objectId: items.get(r.object) as number,
      ...attrs(),
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

const supported = Object.entries(fixture.types).filter(([, e]) => e.support === "supported");

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
      const insight = readInsight(db, found[0]!);
      expect(insight?.factLines).toEqual(expected.factLines);
      expect(quotesOf(insight?.evidenceIds ?? [])).toEqual([...expected.evidenceQuotes].sort());
      expect(insight?.reasoningSummary).toBeTruthy();

      db.close();
      db = openBetterSqlite3(":memory:");
      migrate(db);
      registerConnectorInstance(db, "c1", "test-fixtures");
      judge(seed(scenario, variant.facts));
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
    const insight = readInsight(db, found[0]!);
    expect(insight?.factLines).toHaveLength(2);
    expect(judge(items).filter((o) => o.outcome !== "unchanged")).toEqual([]);
    expect(readInsight(db, found[0]!)?.id).toBe(insight?.id);
  });
});
