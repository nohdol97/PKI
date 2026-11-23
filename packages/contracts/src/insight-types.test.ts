// P01-C1b: the 13 Insight types live in one table; a type that is not supported says why.
import { describe, expect, it } from "vitest";
import { INSIGHT_TYPE_NAMES, INSIGHT_TYPES, insightType } from "./insight-types.ts";

describe("INSIGHT_TYPES (P01-R1)", () => {
  it("has a row for each of the 13 requested types", () => {
    expect(INSIGHT_TYPE_NAMES).toHaveLength(13);
    expect(INSIGHT_TYPES.map((t) => t.type)).toEqual([...INSIGHT_TYPE_NAMES]);
    expect(insightType("dependency_delay")?.label).toBeTruthy();
    expect(insightType("nope")).toBeUndefined();
  });

  it("gives every unsupported type a reason and makes every supported type code-judged but opportunity", () => {
    for (const t of INSIGHT_TYPES) {
      if (t.status === "unsupported") expect(t.reason).toBeTruthy();
      else
        expect([t.judgedBy, t.reason]).toEqual([t.type === "opportunity" ? "llm" : "code", null]);
      expect(t.impact).toBeGreaterThanOrEqual(0);
      expect(t.actionability).toBeLessThanOrEqual(100);
    }
    expect(INSIGHT_TYPES.filter((t) => t.status === "supported").map((t) => t.type)).toEqual([
      "important_change",
      "schedule_conflict",
      "dependency_delay",
      "conflict",
      "opportunity",
    ]);
  });
});
