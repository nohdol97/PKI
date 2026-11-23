// X02B-C4 ①② (R8): a line's valid-interval fix and action history against a fake API. The fix goes to
// `semanticValidity` with the dates as typed (blank is none), the answer's `previous` puts the interval back,
// a 400 is a sentence, and the history lines come in time order with known action codes in words.
import type { RouteName } from "@pki/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type ApiClient } from "./api.ts";
import { fixValidity, HistoryView, loadHistory, RowDetail, validityFailure } from "./row-detail.tsx";

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
const line = (seq: number, at: string, action: string) => ({
  seq,
  at,
  actor: "user" as const,
  action,
  fromStatus: "candidate" as const,
  toStatus: "verified" as const,
  fromEpistemic: null,
  toEpistemic: "user-approved" as const,
  reason: null,
  basisSourceId: null,
  basisVersion: null,
  batch: null,
  revertsSeq: null,
});

describe("줄 상세 (X02B-C4 ①②)", () => {
  it("fixes the interval with the typed dates (blank is none) and puts the previous one back", async () => {
    const { api, calls } = fake({
      semanticValidity: () => ({
        status: "applied",
        seq: 3,
        previous: { from: "2026-01-01", until: null },
      }),
    });
    const done = await fixValidity(api, "fact", 5, "2026-02-01", "");
    expect(calls[0]).toEqual([
      "semanticValidity",
      { kind: "fact", id: 5, from: "2026-02-01", until: null },
    ]);
    expect(done.previous).toEqual({ from: "2026-01-01", until: null });
    await fixValidity(api, "fact", 5, done.previous.from ?? "", done.previous.until ?? "");
    expect(calls[1]).toEqual([
      "semanticValidity",
      { kind: "fact", id: 5, from: "2026-01-01", until: null },
    ]);
  });

  it("turns a 400 into a sentence and shows it as an alert; other errors keep their message", () => {
    expect(validityFailure(new ApiError("bad-request", 400))).toContain("YYYY-MM-DD");
    expect(validityFailure(new Error("API 500"))).toContain("API 500");
    const out = renderToStaticMarkup(
      <RowDetail
        api={fake({}).api}
        kind="fact"
        id={5}
        name="사실 memo 메모"
        validity={{ from: "2026-01-01", until: null }}
        onChanged={() => undefined}
      />,
    );
    expect(out).toContain('aria-label="기간 고치기: 사실 memo 메모"');
    expect(out).toContain('aria-label="이력 보기: 사실 memo 메모"');
  });

  it("reads the history of the row and shows it in time order, known codes in words, unknown as they are", async () => {
    const { api, calls } = fake({
      semanticHistory: () => ({
        lines: [line(2, "2026-02-01T00:00:00Z", "approve"), line(1, "2026-01-01T00:00:00Z", "zz-new")],
      }),
    });
    const lines = await loadHistory(api, "item", 1);
    expect(calls[0]).toEqual(["semanticHistory", { kind: "item", id: 1 }]);
    const out = renderToStaticMarkup(<HistoryView lines={lines} />);
    expect(out.indexOf("zz-new")).toBeLessThan(out.indexOf("승인"));
    expect(out).not.toContain(">approve<");
    expect(renderToStaticMarkup(<HistoryView lines={[]} />)).toContain("기록된 조치가 없습니다");
  });
});
