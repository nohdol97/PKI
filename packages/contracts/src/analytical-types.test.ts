// S03-T08 `analytical.api` (contract part, S03-R18, R19): the schemas accept a read shaped as the API answers
// it, take no query or expression, and keep the `data-check-unmet` names in step with the refusal's.
import { describe, expect, it } from "vitest";
import {
  AnalyticalCheckRequestSchema,
  AnalyticalCheckResponseSchema,
  AnalyticalListSchema,
  ANALYTICAL_UNMET,
  limitationCodes,
  SemanticPiecesSchema,
} from "./analytical-types.ts";
import { DATA_CHECK_UNMET } from "./index.ts";

const fact = {
  id: 1,
  kind: "metric.calculation",
  value: '{"aggregation":"sum","column":"amount"}',
  context: null,
  status: "candidate",
  epistemic: "explicit",
  confidence: null,
  userDecided: false,
  userAuthored: false,
  evidenceIds: [3],
  evidenceCount: 1,
  checkNeeded: true,
  checks: [
    { check: "schema", passed: true, failure: null, examined: 2, violations: 0, skipped: 0 },
  ],
  unmet: ["check-missing"],
  awaitingSourceIds: [],
};
const item = {
  status: "candidate",
  epistemic: "explicit",
  userDecided: false,
  userAuthored: false,
  conflicts: [{ kind: "metric.unit", rowKind: "fact", ids: [4, 5] }],
};
const metric = {
  ...item,
  itemId: 2,
  name: "매출",
  terms: [],
  definitions: [],
  calculations: [fact],
  calculationConfirmed: false,
  datasets: [
    {
      itemId: 6,
      name: "orders",
      tables: [{ tableId: 1, sourceId: 7, rowCount: 2, limitations: ["xlsx.hidden-sheet"] }],
      groupTableItemIds: [],
      representativeLacksTable: false,
    },
  ],
  columns: [{ column: "amount", factId: 8, missing: null }],
  grain: [],
  joins: [],
  units: [],
  currencies: [],
  periods: [],
  versions: [],
  relations: [],
  members: [],
};

describe("analytical.api (contract)", () => {
  it("C3: a read with a Metric's checks, unmet conditions and conflicts parses; an added field (a computed value) or a query field does not", () => {
    const list = { datasets: [], metrics: [metric], joins: [], truncated: false };
    expect(AnalyticalListSchema.safeParse(list).success).toBe(true);
    const withValue = { ...list, metrics: [{ ...metric, total: 42 }] };
    expect(AnalyticalListSchema.safeParse(withValue).success).toBe(false);
    expect(AnalyticalCheckRequestSchema.safeParse({ itemId: 2 }).success).toBe(true);
    expect(
      AnalyticalCheckRequestSchema.safeParse({ itemId: 2, query: "sum(amount)" }).success,
    ).toBe(false);
    expect(AnalyticalCheckResponseSchema.parse({ jobIds: [9] })).toEqual({ jobIds: [9] });
  });

  it("U3: a Metric and a Join parse with a member listed under them; a member's own members must be empty", () => {
    const member = { ...metric, itemId: 3 };
    const nested = { ...metric, members: [{ ...member, members: [member] }] };
    const list = {
      datasets: [],
      metrics: [{ ...metric, members: [member] }],
      joins: [],
      truncated: false,
    };
    expect(AnalyticalListSchema.safeParse(list).success).toBe(true);
    expect(AnalyticalListSchema.safeParse({ ...list, metrics: [nested] }).success).toBe(false);
    const join = {
      ...item,
      itemId: 9,
      name: "j",
      left: [],
      right: [],
      keys: [],
      cardinality: [],
      relations: [],
    };
    const joins = [{ ...join, members: [{ ...join, itemId: 10, members: [] }] }];
    expect(AnalyticalListSchema.safeParse({ ...list, joins }).success).toBe(true);
  });

  it("U4: limitation codes are the unique sorted strings of meta.metadata.limitations; anything else is none", () => {
    const meta = JSON.stringify({ metadata: { limitations: ["b", "a", "b", 3] } });
    expect(limitationCodes(meta)).toEqual(["a", "b"]);
    for (const bad of ["{broken", "null", '"x"', "{}", null, undefined, 5]) {
      expect(limitationCodes(bad)).toEqual([]);
    }
  });

  it("C3: the unmet names equal the refusal's list; pieces of a calculation or a column set parse, a number does not", () => {
    expect([...ANALYTICAL_UNMET]).toEqual([...DATA_CHECK_UNMET]);
    expect(SemanticPiecesSchema.safeParse({ aggregation: "sum", column: "a" }).success).toBe(true);
    expect(SemanticPiecesSchema.safeParse(["a", "b"]).success).toBe(true);
    expect(SemanticPiecesSchema.safeParse(7).success).toBe(false);
    expect(SemanticPiecesSchema.safeParse("text").success).toBe(false);
  });
});
