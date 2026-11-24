// UI01-C4 (R3, R6): the frame around the screens: one nav with the eleven buttons as they were,
// the screen inside main > div.pane-list, a status line without a live role, nothing else added.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./App.tsx";
import type { ApiClient } from "./api.ts";

const NAMES = [
  "홈",
  "원본",
  "알림",
  "위키",
  "점검",
  "질문",
  "탐색",
  "지식 검토",
  "유형 정의",
  "활동",
  "설정",
];

const html = renderToStaticMarkup(
  <App api={(() => new Promise(() => undefined)) as unknown as ApiClient} />,
);

describe("the app frame", () => {
  it("has one nav whose eleven buttons keep their order, each an icon then its name, the first screen current", () => {
    expect(html.match(/<nav[ >]/g)).toHaveLength(1);
    const nav = /<nav[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
    const buttons = [...nav.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)];
    expect(buttons.map((b) => (b[2] ?? "").replace(/<svg[\s\S]*?<\/svg>/, ""))).toEqual(NAMES);
    for (const b of buttons) {
      expect(b[2]?.match(/<svg[^>]*aria-hidden="true"/g)).toHaveLength(1);
      expect(b[2]).toMatch(/^<svg/);
    }
    expect(buttons.filter((b) => b[1]?.includes('aria-current="page"'))).toHaveLength(1);
    expect(buttons[0]?.[1]).toContain('aria-current="page"');
  });

  it("draws the first screen as two panes in main, with one h1", () => {
    expect(html).toMatch(/<main class="screen screen-split" data-screen="home">/);
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html).toContain('<div class="pane-list">');
    expect(html).toContain('<section class="pane-detail" aria-label="Insight 상세">');
  });

  it("ends with a status line that has no role or live region", () => {
    const footer = /<footer([^>]*)>/.exec(html);
    expect(footer?.[1]).toContain('class="statusbar"');
    expect(footer?.[1]).not.toMatch(/role=|aria-live/);
  });

  it("adds no image, style attribute or live region of its own", () => {
    expect(html).not.toMatch(/<img|\sstyle=|aria-live/);
  });
});
