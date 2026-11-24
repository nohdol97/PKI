// K01-R16, V02-R15: a page draws its claims with the status and conflict marker, and imported text
// (a page title with markup) only as text, never as elements.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type ApiClient } from "./api.ts";
import { buildState, createPageReads, PageView, type PageViewProps } from "./wiki.tsx";

const noop = () => undefined;
const props: PageViewProps = {
  page: {
    key: "projects/1",
    kind: "projects",
    title: '<img src="https://tracker.example.test/x">',
    stale: true,
    members: [],
    claims: [
      {
        ref: { kind: "fact", id: 1 },
        kind: "target_date",
        value: "2026-12-05",
        status: "disputed",
        epistemic: "explicit",
        validAt: null,
        validUntil: null,
        evidence: [7],
        contradicts: [{ kind: "fact", id: 2 }],
        supersedes: [],
      },
    ],
    links: [],
    backlinks: [],
    hidden: [],
    notes: [],
    history: [],
    summary: { state: "off" },
  },
  source: undefined,
  headingRef: null,
  sourceHeadingRef: null,
  onOpenPage: noop,
  onOpenEvidence: noop,
  onHide: noop,
  onUnhide: noop,
  onAddNote: () => Promise.resolve(true),
  onRemoveNote: noop,
};

describe("PageView", () => {
  it("shows the status, the conflict marker and the stale notice, and draws the title as text", () => {
    const html = renderToStaticMarkup(<PageView {...props} />);
    expect(html).toContain("이의 있음 · 충돌 1건");
    expect(html).toContain("최신이 아닐 수 있습니다");
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain("&lt;img");
  });

  it("lists the page's hidden claims with a way back", () => {
    const claim = props.page.claims[0] as NonNullable<(typeof props.page.claims)[number]>;
    const html = renderToStaticMarkup(
      <PageView {...props} page={{ ...props.page, claims: [], hidden: [claim] }} />,
    );
    expect(html).toContain("다시 보이기");
    expect(html).toContain("2026-12-05");
  });
});

describe("buildState (#220)", () => {
  it("stops polling and reports failure once the build job is dead, and polls while it is only stale", () => {
    expect(buildState({ stale: true, buildDead: false }, undefined)).toBe("building");
    expect(buildState({ stale: true, buildDead: true }, { stale: true })).toBe("dead");
    expect(buildState({ stale: false, buildDead: false }, { stale: false })).toBe("idle");
  });
});

// UI01-C8 (R6, R7, R10): an opened page is the detail pane: its title is the focus target heading, its
// claims and sections follow, and the note form sits in the action bar under the body.
describe("PageView's detail pane", () => {
  it("is one section named 페이지 상세 with the title heading, the claims and the note form in the bar", () => {
    const html = renderToStaticMarkup(<PageView {...props} position="1 / 3" />);
    expect(html).toMatch(/^<section class="pane-detail" aria-label="페이지 상세">/);
    expect(html).toContain("페이지<span> 1 / 3</span>");
    expect(html).toMatch(/<h2 class="detail-title" id="wiki-page-heading" tabindex="-1">/);
    expect(html).toContain('aria-label="주장"');
    const bar = html.indexOf('<form class="actions"');
    expect(bar).toBeGreaterThan(html.indexOf("변경 이력"));
    expect(html.slice(bar)).toMatch(/메모 쓰기[\s\S]*메모 추가/);
  });
});

// UI01H-C1: a re-read that comes after another page was opened changes nothing; one with no page opened between applies.
describe("createPageReads (UI01H)", () => {
  const deferred = () => {
    let settle!: (value: unknown) => void;
    let fail!: (error: unknown) => void;
    const promise = new Promise<unknown>(
      (resolve, reject) => ((settle = resolve), (fail = reject)),
    );
    return { promise, settle, fail };
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const page = (key: string) => ({ key });
  const setup = () => {
    const reads: Array<ReturnType<typeof deferred>> = [];
    const api = (() => {
      const read = deferred();
      reads.push(read);
      return read.promise;
    }) as unknown as ApiClient;
    const on = { shown: vi.fn(), gone: vi.fn(), failed: vi.fn() };
    return { reads, on, pages: createPageReads(api, on) };
  };

  it.each([
    ["a page", (r: ReturnType<typeof deferred>) => r.settle(page("P"))],
    ["a 404", (r: ReturnType<typeof deferred>) => r.fail(new ApiError("not-found", 404))],
  ])("UI01H-C1: drops a re-read of P answered with %s after Q was opened", async (_, answer) => {
    const { reads, on, pages } = setup();
    void pages.open("P");
    reads[0]?.settle(page("P"));
    await flush();
    void pages.reread();
    void pages.open("Q");
    reads[2]?.settle(page("Q"));
    await flush();
    on.shown.mockClear();
    answer(reads[1] as ReturnType<typeof deferred>);
    await flush();
    expect(on.shown).not.toHaveBeenCalled();
    expect(on.gone).not.toHaveBeenCalled();
    expect(on.failed).not.toHaveBeenCalled();
  });

  it("UI01H-C1: applies the re-read of the page still shown", async () => {
    const { reads, on, pages } = setup();
    void pages.open("P");
    reads[0]?.settle(page("P"));
    await flush();
    void pages.reread();
    reads[1]?.settle(page("P"));
    await flush();
    expect(on.shown).toHaveBeenLastCalledWith(page("P"), false);
  });
});
