// I01-R17, R19: the Sources screen says why a sync stopped (role alert) and marks a
// Connector whose rescan may have missed deletions.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConnectorTable } from "./connector-table.tsx";
import { DELETIONS_MAY_BE_MISSED, nextSyncStops, syncStopText } from "./connector-text.ts";

const render = (props: Partial<Parameters<typeof ConnectorTable>[0]> = {}) =>
  renderToStaticMarkup(
    <ConnectorTable
      connectors={[
        { id: "mail-1", kind: "k", state: "ready", deletionsMayBeMissed: true },
        { id: "plain", kind: "k", state: "ready" },
      ]}
      syncStops={{}}
      onSync={() => {}}
      {...props}
    />,
  );

describe("ConnectorTable", () => {
  it("shows the deletions note on the Connector that has it, and only there", () => {
    const html = render();
    expect(html.split(DELETIONS_MAY_BE_MISSED)).toHaveLength(2);
    expect(html).toContain("mail-1 동기화");
    expect(html).not.toContain('role="alert"');
  });

  it("shows a stop as an alert on the row of its instance only", () => {
    const html = render({ syncStops: { plain: syncStopText("rate-limited") } });
    expect(html.split('role="alert"')).toHaveLength(2);
    const [mail, plain] = html.split("<tr>").slice(1) as [string, string];
    expect(plain).toContain(`<p role="alert">${syncStopText("rate-limited")}</p>`);
    expect(mail).not.toContain('role="alert"');
  });
});

describe("nextSyncStops", () => {
  it("sets an instance's stop, leaves the others, and clears it when its next sync has none (or fails)", () => {
    const one = nextSyncStops({}, "a", "aborted");
    const two = nextSyncStops(one, "b", "storage-failed");
    expect(two).toEqual({ a: syncStopText("aborted"), b: syncStopText("storage-failed") });
    expect(nextSyncStops(two, "a", undefined)).toEqual({ b: syncStopText("storage-failed") });
    expect(render({ syncStops: nextSyncStops(one, "a", undefined) })).not.toContain('role="alert"');
  });
});
