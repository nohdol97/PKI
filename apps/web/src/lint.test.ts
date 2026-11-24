// UI01 review A2: the "n / N" of a finding counts in the order the rows are drawn (grouped by rule), not in API order.
import { describe, expect, it } from "vitest";
import { drawnOrder } from "./lint.tsx";

describe("점검 drawn order", () => {
  it("groups findings by rule in the screen's rule order, keeping the API order inside a rule", () => {
    const f = (id: number, rule: string) => ({ id, rule }) as never;
    const api = [f(1, "missing-link"), f(2, "synonym"), f(3, "stale"), f(4, "synonym")];
    expect(drawnOrder(api).map((x: { id: number }) => x.id)).toEqual([2, 4, 3, 1]);
  });
});
