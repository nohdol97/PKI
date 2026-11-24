// UI01 review A2: the "n / N" of a finding counts in the order the rows are drawn (grouped by rule), not in API order.
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "./api.ts";
import { drawnOrder, evidenceOpener } from "./lint.tsx";

describe("점검 drawn order", () => {
  it("groups findings by rule in the screen's rule order, keeping the API order inside a rule", () => {
    const f = (id: number, rule: string) => ({ id, rule }) as never;
    const api = [f(1, "missing-link"), f(2, "synonym"), f(3, "stale"), f(4, "synonym")];
    expect(drawnOrder(api).map((x: { id: number }) => x.id)).toEqual([2, 4, 3, 1]);
  });
});

// UI01F-C2: an evidence read that was out when another finding was chosen shows neither its source nor a failure.
describe("점검 원본 읽기 (UI01F-C2)", () => {
  const deferred = () => {
    let settle!: (value: unknown) => void;
    const promise = new Promise<unknown>((resolve) => (settle = resolve));
    return { promise, settle };
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("drops the answer of a read that reset() left behind, and shows one that was not", async () => {
    const slow = deferred();
    const api = (() => slow.promise) as unknown as ApiClient;
    const show = vi.fn();
    const fail = vi.fn();
    const opener = evidenceOpener(api, show, fail);
    opener.open(1);
    opener.reset();
    slow.settle({ evidenceId: 1 });
    await flush();
    expect(show).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();

    const quick = deferred();
    const shown = evidenceOpener((() => quick.promise) as unknown as ApiClient, show, fail);
    shown.open(2);
    quick.settle({ evidenceId: 2 });
    await flush();
    expect(show).toHaveBeenCalledWith({ evidenceId: 2 });
  });
});
