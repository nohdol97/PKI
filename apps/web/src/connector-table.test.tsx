// I01-R17, R19: the Sources screen says why a sync stopped (role alert) and marks a
// Connector whose rescan may have missed deletions.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConnectorTable } from "./connector-table.tsx";
import { DELETIONS_MAY_BE_MISSED, syncStopText } from "./connector-text.ts";

const render = (props: Partial<Parameters<typeof ConnectorTable>[0]> = {}) =>
  renderToStaticMarkup(
    <ConnectorTable
      connectors={[
        { id: "mail-1", kind: "k", state: "ready", deletionsMayBeMissed: true },
        { id: "plain", kind: "k", state: "ready" },
      ]}
      syncStop={undefined}
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

  it("shows a stop as an alert with the text of its code", () => {
    const html = render({ syncStop: syncStopText("rate-limited") });
    expect(html).toContain(`<p role="alert">${syncStopText("rate-limited")}</p>`);
  });
});
