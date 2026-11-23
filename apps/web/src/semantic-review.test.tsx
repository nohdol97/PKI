// X02-C2c (R7, R8): the 지식 검토 screen against a fake API. An action goes to the existing route, the list is
// read again so the screen shows the row's new state, a refusal is shown as words (never the bare code), and a
// conflict pair disappears once the list is read again without it. Imported text only reaches the page as text.
import type { RouteName, RouteResponse } from "@pki/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "./api.ts";
import { loadReview, perform, ReviewView, type Review } from "./semantic-review.tsx";

const row = {
  confidence: null,
  userDecided: false,
  userAuthored: false,
  evidenceCount: 1,
  epistemic: "explicit",
} as const;
const list = (status: "candidate" | "verified"): RouteResponse<"semantic"> => ({
  truncated: false,
  items: [
    {
      id: 1,
      type: "Project",
      name: '<img src="https://tracker.example.test/x"> 미리내',
      status: "verified",
      ...row,
      facts: [{ id: 7, status, kind: "target_date", value: "2026-12-10", context: null, ...row }],
      relations: [],
      members: [],
    },
  ],
});
const noConflicts: RouteResponse<"conflicts"> = { links: [], truncated: false };
const conflictPair: RouteResponse<"conflicts"> = {
  truncated: false,
  links: [
    {
      id: 3,
      type: "CONTRADICTS",
      createdBy: "rule",
      from: { factId: 7, itemId: 1, effectiveUntil: null },
      to: { factId: 8, itemId: 1, effectiveUntil: null },
    },
  ],
};

/** A fake API answering by route name; each handler may be a function of the request. */
function fake(handlers: Partial<Record<RouteName, (request: unknown) => unknown>>) {
  const calls: [string, unknown][] = [];
  const api = vi.fn(async (name: string, request?: unknown) => {
    calls.push([name, request]);
    const handler = handlers[name as RouteName];
    if (!handler) throw new Error(`unexpected route ${name}`);
    return handler(request);
  });
  return { api: api as unknown as ApiClient, calls };
}
const view = (review: Review, filter: "candidate" | "all" = "candidate", notice?: string) =>
  renderToStaticMarkup(
    <ReviewView
      review={review}
      filter={filter}
      notice={notice}
      onAct={() => undefined}
      onFilter={() => undefined}
    />,
  );

describe("지식 검토 (X02-C2c)", () => {
  it("approves a candidate fact through semanticDecide, reads the list again and shows it as 확정; a refusal is shown in words", async () => {
    let status: "candidate" | "verified" = "candidate";
    const { api, calls } = fake({
      semantic: () => list(status),
      conflicts: () => noConflicts,
      semanticDecide: () => {
        status = "verified";
        return {
          status: "applied",
          seq: 1,
          entry: { kind: "fact", id: 7, status: "verified", epistemic: "user-approved" },
        };
      },
    });
    const done = await perform(api, { type: "decide", kind: "fact", id: 7, action: "approve" });
    expect(calls[0]).toEqual(["semanticDecide", { kind: "fact", id: 7, action: "approve" }]);
    expect(
      calls
        .slice(1)
        .map(([name]) => name)
        .sort(),
    ).toEqual(["conflicts", "semantic"]);
    expect(done.refusal).toBeUndefined();
    const out = view(done.review, "all");
    expect(out).toContain("확정");
    expect(out).toContain("&lt;img"); // the name, as text
    expect(out).not.toContain("<img");

    const refused = fake({
      semantic: () => list("candidate"),
      conflicts: () => noConflicts,
      semanticDecide: () => ({ status: "refused", reason: "basis-required" }),
    });
    const again = await perform(refused.api, {
      type: "decide",
      kind: "fact",
      id: 7,
      action: "approve",
    });
    expect(again.refusal).toContain("근거");
    expect(again.refusal).not.toContain("basis-required");
  });

  it("fixes a fact's value through semanticCorrect with `replace`", async () => {
    const { api, calls } = fake({
      semantic: () => list("candidate"),
      conflicts: () => noConflicts,
      semanticCorrect: () => ({
        status: "applied",
        seq: 2,
        entry: { kind: "fact", id: 9, status: "verified", epistemic: "user-approved" },
      }),
    });
    await perform(api, { type: "replace", id: 7, value: "2026-12-11" });
    expect(calls[0]).toEqual([
      "semanticCorrect",
      { correction: { action: "replace", id: 7, value: "2026-12-11" } },
    ]);
  });

  it("drops a conflict pair from the list once one side is rejected and the list is read again", async () => {
    let rejected = false;
    const { api } = fake({
      semantic: () => list("candidate"),
      conflicts: () => (rejected ? noConflicts : conflictPair),
      semanticDecide: () => {
        rejected = true;
        return {
          status: "applied",
          seq: 3,
          entry: { kind: "fact", id: 8, status: "rejected", epistemic: "explicit" },
        };
      },
    });
    const before = await loadReview(api);
    expect(view(before)).toContain("어긋남");
    const after = await perform(api, { type: "decide", kind: "fact", id: 8, action: "reject" });
    expect(view(after.review)).not.toContain("어긋남");
  });

  it("says when the list was cut and where to find the rest, and when nothing matches", () => {
    const cut: Review = { list: { ...list("candidate"), truncated: true }, conflicts: noConflicts };
    expect(view(cut)).toContain("탐색");
    const empty: Review = { list: { items: [], truncated: false }, conflicts: noConflicts };
    expect(view(empty)).toContain("보여 줄 지식이 없습니다");
  });
});
