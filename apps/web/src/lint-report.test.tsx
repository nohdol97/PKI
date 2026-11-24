// CUF-C1 (R1): the "놓친 것 알리기" form of the 점검 screen. The request the form sends is built by a plain
// function, so the rule of "how many items does this rule take" is tested without a DOM; the drawn form is
// checked for a name on every input.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ApiClient } from "./api.ts";
import { LintReport, reportRequest, sendReport, withoutSent } from "./lint-report.tsx";
import { REPORT_EXISTS, REPORT_NOT_FOUND } from "./lint-text.ts";

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
    expect(html).toMatch(/<h2[^>]*>놓친 것 알리기<\/h2>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>알리기<\/button>/);
  });

  it("limits the search input to 200 characters and says so (UIF2-C3)", () => {
    const api = (() => Promise.reject(new Error("not called"))) as unknown as ApiClient;
    const html = renderToStaticMarkup(<LintReport api={api} onReported={() => {}} />);
    expect(html).toMatch(/<input[^>]*maxLength="200"|<input[^>]*maxlength="200"/i);
    expect(html).toContain("200자");
  });
});

describe("sendReport (UIF2-C1)", () => {
  const request = { rule: "synonym", kind: "item", a: 1, b: 2 } as const;
  const answering = (status: string) => (async () => ({ status })) as unknown as ApiClient;
  it("keeps the picks for exists, tells not-found without rereading, and alerts on failure", async () => {
    const exists = await sendReport(answering("exists"), request);
    expect(exists).toEqual({
      notice: { text: REPORT_EXISTS, alert: false },
      clear: false,
      reread: true,
    });
    const missing = await sendReport(answering("not-found"), request);
    expect(missing).toEqual({
      notice: { text: REPORT_NOT_FOUND, alert: false },
      clear: false,
      reread: false,
    });
    const failed = await sendReport(
      (() => Promise.reject(new Error("끊김"))) as unknown as ApiClient,
      request,
    );
    expect(failed.notice.alert).toBe(true);
    expect(failed.notice.text).toMatch(/^알리지 못했습니다/);
    expect([failed.clear, failed.reread]).toEqual([false, false]);
  });
});

describe("withoutSent (UIF2-C2)", () => {
  it("drops only the items the request sent", () => {
    const item = (id: number) => ({ id, name: `n${id}`, type: "t" });
    const rest = withoutSent([item(1), item(2), item(3)], {
      rule: "synonym",
      kind: "item",
      a: 1,
      b: 2,
    });
    expect(rest.map((i) => i.id)).toEqual([3]);
  });
});
