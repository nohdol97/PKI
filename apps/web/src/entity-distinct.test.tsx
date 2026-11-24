// DPF-C3 (R3): the list of "다른 것" marks on the item in 항목 정리 against a fake API. Each row has a named release
// button; releasing calls `entityDistinct` with `on: false` and then reads the list again. (The press itself is not
// run here: these tests call the function a press calls.)
import type { RouteName } from "@pki/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "./api.ts";
import {
  createMarksSession,
  DistinctList,
  loadMarks,
  releaseMark,
  type DistinctMarks,
} from "./entity-distinct.tsx";

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

const marks = [
  { id: 9, type: "Project", name: "미리내 <b>", by: "user", at: "2026-11-24T01:00:00Z" },
  { id: 10, type: "Project", name: "은하수", by: "link-check", at: "2026-11-23T01:00:00Z" },
] as const;

describe("다른 것으로 표시한 항목 (DPF-C3)", () => {
  it("lists each mark with its name, who left it and a release button named after it", () => {
    const out = renderToStaticMarkup(
      <DistinctList marks={marks} truncated={false} onRelease={() => undefined} />,
    );
    expect(out).toContain("다른 것 표시 풀기: 미리내 &lt;b&gt;");
    expect(out).toContain("다른 것 표시 풀기: 은하수");
    expect(out).toContain("사용자");
    expect(out).toContain("연결 검사");
    expect(out).not.toContain("<b>");
  });

  it("says so when there is none, and when only the first 100 are shown", () => {
    const none = renderToStaticMarkup(
      <DistinctList marks={[]} truncated={false} onRelease={() => undefined} />,
    );
    expect(none).toContain("다른 것으로 표시한 항목이 없습니다");
    const cut = renderToStaticMarkup(
      <DistinctList marks={marks} truncated onRelease={() => undefined} />,
    );
    expect(cut).toContain("처음 100개만 보입니다");
  });

  it("releases through entityDistinct with on: false and then reads the list again", async () => {
    const { api, calls } = fake({
      entityDistinct: () => ({ status: "applied" }),
      entityDistinctMarks: () => ({ marks: [], truncated: false }),
    });
    expect(await loadMarks(api, 1)).toEqual({ marks: [], truncated: false });
    calls.length = 0;
    await releaseMark(api, 1, 9);
    expect(calls).toEqual([
      ["entityDistinct", { a: 1, b: 9, on: false }],
      ["entityDistinctMarks", { itemId: 1 }],
    ]);
  });
});

describe("안내는 지금 항목의 것만 보인다 (LCF-C3)", () => {
  type Seen = { state?: unknown; notice?: string | undefined };
  const sink = () => {
    const seen: Seen = {};
    return {
      seen,
      view: {
        setState: (state: unknown) => void (seen.state = state),
        setNotice: (notice: string | undefined) => void (seen.notice = notice),
      },
    };
  };
  const later = <T,>() => {
    let resolve: (value: T) => void = () => undefined;
    let reject: (error: Error) => void = () => undefined;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  const listB: DistinctMarks = { marks: [marks[0]], truncated: false };

  it("a release that fails after another item's read began leaves no notice; the newest failure is written", async () => {
    const failA = later<never>();
    const readB = later<DistinctMarks>();
    const api = vi.fn(async (name: string, request?: unknown) => {
      if (name === "entityDistinct") return failA.promise;
      if ((request as { itemId: number }).itemId === 2) return readB.promise;
      return { marks: [], truncated: false };
    }) as unknown as ApiClient;
    const { seen, view } = sink();
    const session = createMarksSession(api, view);

    const releasing = session.release(1, 9);
    session.load(2);
    failA.reject(new Error("boom"));
    await releasing;
    expect(seen.notice).toBeUndefined();
    readB.resolve(listB);
    await vi.waitFor(() => expect(seen.state).toEqual({ status: "ready", ...listB }));
    expect(seen.notice).toBeUndefined();

    const failC = later<never>();
    const apiC = vi.fn(async () => failC.promise) as unknown as ApiClient;
    const again = sink();
    const releasingC = createMarksSession(apiC, again.view).release(2, 9);
    failC.reject(new Error("boom"));
    await releasingC;
    expect(again.seen.notice).toContain("boom");
  });

  it("starting a read clears the notice of the item before", async () => {
    const api = vi.fn(async () => ({ marks: [], truncated: false })) as unknown as ApiClient;
    const { seen, view } = sink();
    seen.notice = "old";
    createMarksSession(api, view).load(3);
    expect(seen.notice).toBeUndefined();
  });
});
