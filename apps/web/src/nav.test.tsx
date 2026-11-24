// X02-C1a ① (R5): screens reach one another through `go(screen, target)`. The target waits for the screen it
// names and is dropped once the user is on another screen, so a later click on the nav button opens the screen
// plain. The Ask screen's related-knowledge links call `go` with the item and the page key.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { App, NavBadge } from "./App.tsx";
import type { ApiClient } from "./api.ts";
import { relatedActions } from "./ask.tsx";
import { NavProvider, pendingFor, useNav, type NavState } from "./nav.tsx";

describe("nav target", () => {
  it("is offered to the screen it names only, and dropped when the user is on another screen", () => {
    const pending: NavState = { screen: "explore", target: { itemId: 9 } };
    expect(pendingFor(pending, "explore")).toBe(pending);
    expect(pendingFor(pending, "home")).toBeUndefined();
    expect(pendingFor(undefined, "explore")).toBeUndefined();
  });

  it("gives a screen under the provider the target through useNav, and none without a go", () => {
    function Probe() {
      const nav = useNav();
      return <p>{JSON.stringify(nav.target("explore") ?? null)}</p>;
    }
    expect(renderToStaticMarkup(<Probe />)).toContain("null");
    expect(
      renderToStaticMarkup(
        <NavProvider screen="home" onScreen={() => undefined}>
          <Probe />
        </NavProvider>,
      ),
    ).toContain("null");
  });
});

describe("related knowledge links of the Ask screen", () => {
  it("opens the item in 탐색 by its number and the Wiki title in 위키 by its key", () => {
    const go = vi.fn();
    const related = {
      itemId: 9,
      name: "물결 프로젝트",
      wikiKey: "projects/9",
      wikiTitle: "물결 위키",
    };
    const actions = relatedActions(go, related);
    actions.openItem();
    actions.openWiki?.();
    expect(go).toHaveBeenNthCalledWith(1, "explore", { itemId: 9 });
    expect(go).toHaveBeenNthCalledWith(2, "wiki", { wikiKey: "projects/9" });
    expect(
      relatedActions(go, { ...related, wikiKey: null, wikiTitle: null }).openWiki,
    ).toBeUndefined();
  });
});

describe("the navigation", () => {
  it("lists 탐색 and 지식 검토 next to the existing screens", () => {
    const out = renderToStaticMarkup(
      <App api={(() => new Promise(() => undefined)) as unknown as ApiClient} />,
    );
    expect(out).toMatch(/<button[^>]*>(<svg[\s\S]*?<\/svg>)?지식 검토<\/button>/);
    expect(out).toMatch(/<button[^>]*>(<svg[\s\S]*?<\/svg>)?탐색<\/button>/);
    expect(out).toMatch(/<button[^>]*>(<svg[\s\S]*?<\/svg>)?질문<\/button>/);
  });
});

// UI01I-C1: the notifications badge says what it counts; the visible text stays the number.
describe("the notifications badge", () => {
  it("names the unread count to a screen reader and draws nothing at zero", () => {
    const out = renderToStaticMarkup(<NavBadge unread={3} />);
    expect(out).toContain('<span class="sr-only">읽지 않음 </span>');
    expect(out).toContain('<span class="sr-only">건</span>');
    expect(out).toContain("3");
    expect(renderToStaticMarkup(<NavBadge unread={0} />)).toBe("");
  });
});
