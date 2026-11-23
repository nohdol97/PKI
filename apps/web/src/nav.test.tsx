// X02-C1a ① (R5): screens reach one another through `go(screen, target)`. The target waits for the screen it
// names and is dropped once the user is on another screen, so a later click on the nav button opens the screen
// plain. The Ask screen's related-knowledge links call `go` with the item and the page key.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
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
