// K01-R16, V02-R15: a page draws its claims with the status and conflict marker, and imported text
// (a page title with markup) only as text, never as elements.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PageView, type PageViewProps } from "./wiki.tsx";

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
