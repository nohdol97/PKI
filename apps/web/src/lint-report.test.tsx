// CUF-C1 (R1): the "놓친 것 알리기" form of the 점검 screen. The request the form sends is built by a plain
// function, so the rule of "how many items does this rule take" is tested without a DOM; the drawn form is
// checked for a name on every input.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ApiClient } from "./api.ts";
import { LintReport, reportRequest } from "./lint-report.tsx";

describe("reportRequest (CUF-C1)", () => {
  it("asks two different items for a pair rule and one item for the overdue rule", () => {
    expect(reportRequest("synonym", [3, 4])).toEqual({ rule: "synonym", kind: "item", a: 3, b: 4 });
    expect(reportRequest("synonym", [3])).toBeUndefined();
    expect(reportRequest("synonym", [3, 3])).toBeUndefined();
    expect(reportRequest("overdue-work", [5])).toEqual({
      rule: "overdue-work",
      kind: "item",
      a: 5,
    });
    expect(reportRequest("overdue-work", [5, 6])).toBeUndefined();
  });
});

describe("LintReport (CUF-C1)", () => {
  it("names every input and keeps the button off until the count fits", () => {
    const api = (() => Promise.reject(new Error("not called"))) as unknown as ApiClient;
    const html = renderToStaticMarkup(<LintReport api={api} onReported={() => {}} />);
    const controls = html.match(/<(input|select)\b[^>]*>/g) ?? [];
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) expect(control).toMatch(/aria-label="[^"]+"/);
    expect(html).toMatch(/<h3[^>]*>놓친 것 알리기<\/h3>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>알리기<\/button>/);
  });
});
