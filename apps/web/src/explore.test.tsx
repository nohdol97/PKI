// X02-C3a (R6, R8): the 탐색 screen against a fake API. The list shows loading, empty and failed; "더 보기" reads
// the next page with `after` and appends it; turning a relation type off takes its lines out of the table; the
// timeline runs by start date with the undated last; choosing an item puts a focusable heading on the page.
// Imported names and values only reach the page as text inside <bdi>. (Real keyboard focus is the e2e's.)
import type { RouteName } from "@pki/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "./api.ts";
import {
  ItemList,
  createExploreSession,
  type ListState,
  Neighbourhood,
  searchMore,
  searchPage,
  shownEdges,
  timelineOf,
  traceEvidence,
  type Center,
  type Read,
} from "./explore.tsx";

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

const row = {
  status: "candidate",
  epistemic: "explicit",
  confidence: null,
  userDecided: false,
  userAuthored: false,
  evidenceCount: 1,
} as const;
const center: Center = {
  id: 1,
  type: "Project",
  name: '<img src="https://tracker.example.test/x"> 미리내',
  wikiKey: "projects/1",
  members: [],
  facts: [
    {
      id: 5,
      itemId: 1,
      kind: "memo",
      value: "나중",
      context: null,
      validAt: "2026-03-01",
      validUntil: null,
      ...row,
    },
    {
      id: 4,
      itemId: 1,
      kind: "memo",
      value: "처음",
      context: null,
      validAt: "2026-01-01",
      validUntil: null,
      ...row,
    },
    {
      id: 6,
      itemId: 1,
      kind: "memo",
      value: "시점 모름",
      context: null,
      validAt: null,
      validUntil: null,
      ...row,
    },
    {
      id: 7,
      itemId: 1,
      kind: "memo",
      value: "끝만 있음",
      context: null,
      validAt: null,
      validUntil: "2026-12-31",
      ...row,
    },
  ],
  relations: [
    {
      id: 8,
      type: "DEPENDS_ON",
      subjectId: 1,
      objectId: 2,
      validAt: "2026-02-01",
      validUntil: null,
      ...row,
    },
  ],
};
const read: Read = {
  status: "ok",
  center,
  items: [
    { id: 2, type: "System", name: "물결 API" },
    { id: 3, type: "System", name: "바다 API" },
  ],
  edges: [
    { relationId: 8, type: "DEPENDS_ON", direction: "forward", from: 1, to: 2, step: 1 },
    { relationId: 9, type: "OWNS", direction: "backward", from: 1, to: 3, step: 1 },
  ],
  truncated: false,
};
const noop = () => undefined;
const neighbourhood = (over: Partial<Parameters<typeof Neighbourhood>[0]> = {}) =>
  renderToStaticMarkup(
    <Neighbourhood
      api={fake({}).api}
      read={read}
      depth={1}
      off={new Set()}
      headingRef={null}
      sourceHeadingRef={null}
      evidence={undefined}
      onDepth={noop}
      onToggleType={noop}
      onOpen={noop}
      onEvidence={noop}
      onAct={noop}
      onChanged={noop}
      onWiki={noop}
      {...over}
    />,
  );

describe("탐색 목록 (X02-C3a ①, ②)", () => {
  it("shows loading, an empty list and a failure each in its own role", () => {
    const loading = renderToStaticMarkup(
      <ItemList state={{ status: "loading" }} onOpen={noop} onMore={noop} />,
    );
    expect(loading).toContain('role="status"');
    const empty = renderToStaticMarkup(
      <ItemList
        state={{ status: "ready", items: [], next: null, query: "" }}
        onOpen={noop}
        onMore={noop}
      />,
    );
    expect(empty).toContain("찾은 항목이 없습니다");
    const failed = renderToStaticMarkup(
      <ItemList state={{ status: "failed", error: "API 500" }} onOpen={noop} onMore={noop} />,
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("API 500");
  });

  it("reads the next page with `after` and puts it after the first", async () => {
    const { api, calls } = fake({
      exploreItems: (request) =>
        (request as { after?: number }).after === undefined
          ? { items: [{ id: 1, type: "Project", name: "가" }], next: 1 }
          : { items: [{ id: 2, type: "Project", name: "나" }], next: null },
    });
    const first = await searchPage(api, "ㅇ");
    expect(calls[0]).toEqual(["exploreItems", { query: "ㅇ" }]);
    const more = await searchPage(api, "ㅇ", first);
    expect(calls[1]).toEqual(["exploreItems", { query: "ㅇ", after: 1 }]);
    expect(more.items.map((i) => i.name)).toEqual(["가", "나"]);
    expect(more.next).toBeNull();
    const out = renderToStaticMarkup(
      <ItemList state={{ status: "ready", ...more }} onOpen={noop} onMore={noop} />,
    );
    expect(out).not.toContain("더 보기");
  });

  it("continues with the query that made the list, not a later-edited input", async () => {
    const { api, calls } = fake({
      exploreItems: (request) =>
        (request as { after?: number }).after === undefined
          ? { items: [{ id: 1, type: "Project", name: "가" }], next: 1 }
          : { items: [{ id: 2, type: "Project", name: "나" }], next: null },
    });
    const first = await searchPage(api, "미리내");
    // the input box now reads "물결", but nothing was submitted
    await searchMore(api, first);
    expect(calls[1]).toEqual(["exploreItems", { query: "미리내", after: 1 }]);
  });
});

describe("이웃과 타임라인 (X02-C3a ③~⑤)", () => {
  it("takes a relation type's lines out of the table when it is turned off", () => {
    const all = neighbourhood();
    expect(all).toContain("물결 API");
    expect(all).toContain("바다 API");
    const off = neighbourhood({ off: new Set(["OWNS"]) });
    expect(off).toContain("물결 API");
    expect(off).not.toContain("바다 API");
    expect(shownEdges(read.edges, new Set(["DEPENDS_ON", "OWNS"]))).toEqual([]);
  });

  it("draws the neighbours as a picture above the table and gives each line its own detail controls", () => {
    const out = neighbourhood();
    expect(out.indexOf('role="img"')).toBeLessThan(out.indexOf('aria-label="이웃 표"'));
    expect(out).toContain('aria-label="이력 보기: 사실 memo: 처음"');
    expect(out).toContain('aria-label="이력 보기: 항목 ');
  });

  it("orders the timeline by start date and puts what has no start last under 시점 없음", () => {
    expect(timelineOf(center).map((e) => `${e.kind}${e.id}`)).toEqual([
      "fact4",
      "relation8",
      "fact5",
      "fact7",
      "fact6",
    ]);
    const out = neighbourhood();
    expect(out.indexOf("처음")).toBeLessThan(out.indexOf("나중"));
    expect(out.indexOf("나중")).toBeLessThan(out.indexOf("시점 모름"));
    expect(out).toContain("시점 없음");
  });

  it("shows a row with only an end date with its 까지 date, after the dated rows and outside 시점 없음 (X02F-C3)", () => {
    const out = neighbourhood();
    expect(out).toContain("2026-12-31까지");
    expect(out.indexOf("나중")).toBeLessThan(out.indexOf("끝만 있음"));
    expect(out.indexOf("끝만 있음")).toBeLessThan(out.indexOf("시점 없음"));
  });

  it("shows the alias of a found item next to its name as text (X02F-C3)", () => {
    const out = renderToStaticMarkup(
      <ItemList
        state={{
          status: "ready",
          items: [{ id: 1, type: "Project", name: "미리내", alias: "<i>별칭</i>" }],
          next: null,
          query: "별",
        }}
        onOpen={noop}
        onMore={noop}
      />,
    );
    expect(out).toContain("&lt;i&gt;별칭&lt;/i&gt;");
    expect(out).not.toContain("<i>");
  });

  it("puts the chosen item's name in a heading focus can be sent to, as text, with a way to its Wiki page", () => {
    const out = neighbourhood();
    expect(out).toMatch(/<h2[^>]*tabindex="-1"[^>]*>/);
    expect(out).toContain("&lt;img");
    expect(out).not.toContain("<img");
    expect(out).toContain("위키 페이지 열기");
    expect(
      neighbourhood({ read: { ...read, center: { ...center, wikiKey: null } } }),
    ).not.toContain("위키 페이지 열기");
  });
});

describe("근거 보기 (R6 ④)", () => {
  it("traces a fact to its evidence and reads each source through evidenceSource", async () => {
    const source = {
      evidenceId: 11,
      quote: "q",
      start: 0,
      end: 1,
      locator: null,
      sourceVersion: { id: 3, version: 1, latestVersion: 2, title: "t", body: "qq" },
    };
    const { api, calls } = fake({
      graphTrace: () => ({
        truncated: false,
        chains: [
          [
            {
              edge: "SUPPORTS",
              from: { kind: "fact", id: 4, effectiveUntil: null },
              to: { kind: "evidence", id: 11, start: 0, end: 1 },
            },
            {
              edge: "MENTIONS",
              from: { kind: "evidence", id: 11, start: 0, end: 1 },
              to: { kind: "source-version", id: 3 },
            },
          ],
        ],
      }),
      evidenceSource: () => source,
    });
    const sources = await traceEvidence(api, { kind: "fact", id: 4 }, 1);
    expect(calls[0]).toEqual(["graphTrace", { kind: "fact", id: 4 }]);
    expect(calls[1]).toEqual(["evidenceSource", { evidenceId: 11 }]);
    expect(sources).toEqual([source]);
  });

  it("finds a relation's evidence in the centre item's trace, among the chains through that relation only", async () => {
    const { api, calls } = fake({
      graphTrace: () => ({
        truncated: false,
        chains: [
          [
            { edge: "HAS", from: { kind: "item", id: 1 }, to: { kind: "relation", id: 8 } },
            {
              edge: "SUPPORTS",
              from: { kind: "relation", id: 8 },
              to: { kind: "evidence", id: 21, start: 0, end: 1 },
            },
          ],
          [
            { edge: "HAS", from: { kind: "item", id: 1 }, to: { kind: "relation", id: 9 } },
            {
              edge: "SUPPORTS",
              from: { kind: "relation", id: 9 },
              to: { kind: "evidence", id: 22, start: 0, end: 1 },
            },
          ],
        ],
      }),
      evidenceSource: () => ({}),
    });
    await traceEvidence(api, { kind: "relation", id: 8 }, 1);
    expect(calls[0]).toEqual(["graphTrace", { kind: "item", id: 1 }]);
    expect(calls.filter(([name]) => name === "evidenceSource")).toEqual([
      ["evidenceSource", { evidenceId: 21 }],
    ]);
  });
});

/** A promise a test settles by hand: the answers arrive in the order the test chooses. */
function later<T>() {
  let settle: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => (settle = resolve));
  return { promise, settle };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function recorder() {
  const seen = {
    lists: [] as ListState[],
    reads: [] as (Read | undefined)[],
    evidence: [] as unknown[],
    notices: [] as (string | undefined)[],
  };
  const show = {
    list: (state: ListState) => seen.lists.push(state),
    read: (r: Read | undefined) => seen.reads.push(r),
    evidence: (e: unknown) => seen.evidence.push(e),
    notice: (text: string | undefined) => seen.notices.push(text),
  };
  return { seen, show };
}
const okRead = (id: number) => ({ ...read, center: { ...center, id } });

describe("늦은 응답 (X02F-C4)", () => {
  it("keeps the list of the newest search when a slower 더 보기 answers after it", async () => {
    const slow = later<unknown>();
    const { api } = fake({
      exploreItems: (request) => {
        const { query, after } = request as { query?: string; after?: number };
        if (after !== undefined) return slow.promise;
        return {
          items: [{ id: query === "새" ? 7 : 1, type: "Project", name: query ?? "", alias: null }],
          next: query === "새" ? null : 1,
        };
      },
    });
    const { seen, show } = recorder();
    const session = createExploreSession(api, show);
    session.search("옛");
    await flush();
    const first = seen.lists.at(-1) as ListState & { status: "ready" };
    session.more(first);
    session.search("새");
    await flush();
    slow.settle({ items: [{ id: 2, type: "Project", name: "옛 뒤", alias: null }], next: null });
    await flush();
    const last = seen.lists.at(-1) as ListState & { status: "ready" };
    expect(last.items.map((i) => i.id)).toEqual([7]);
  });

  it("drops the evidence of a line when another item was opened before its read ended", async () => {
    const trace = later<unknown>();
    const { api } = fake({
      exploreItem: (request) => ({ ...okRead((request as { itemId: number }).itemId) }),
      graphTrace: () => trace.promise,
    });
    const { seen, show } = recorder();
    const session = createExploreSession(api, show);
    session.open(1);
    await flush();
    session.evidence({ kind: "fact", id: 4 }, "사실");
    session.open(2);
    await flush();
    trace.settle({ truncated: false, chains: [] });
    await flush();
    expect(seen.evidence).toEqual([]);
  });

  it("does not read item A again after an action on A when B was opened before the action ended", async () => {
    const done = later<unknown>();
    const { api, calls } = fake({
      exploreItem: (request) => okRead((request as { itemId: number }).itemId),
      semanticDecide: () => done.promise,
    });
    const { show } = recorder();
    const session = createExploreSession(api, show);
    session.open(1);
    await flush();
    session.act({ type: "decide", kind: "fact", id: 4, action: "approve" }, 1);
    session.open(2);
    await flush();
    done.settle({ status: "applied" });
    await flush();
    expect(
      calls
        .filter(([name]) => name === "exploreItem")
        .map(([, r]) => (r as { itemId: number }).itemId),
    ).toEqual([1, 2]);
    // an action that ends while its item is still open is read again
    session.act({ type: "decide", kind: "fact", id: 4, action: "approve" }, 2);
    await flush();
    expect(calls.filter(([name]) => name === "exploreItem")).toHaveLength(3);
  });
});
