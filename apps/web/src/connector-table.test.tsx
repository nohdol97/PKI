// I01-R17, R19: the Sources screen says why a sync stopped (role alert) and marks a
// Connector whose rescan may have missed deletions.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConnectorTable } from "./connector-table.tsx";
import { CREDENTIAL_REASONS, type ConnectorSummary } from "@pki/contracts";
import {
  CREDENTIAL_REASON_TEXT,
  CREDENTIAL_SLOT_STATE_TEXT,
  DELETIONS_MAY_BE_MISSED,
  nextSyncStops,
  syncStopText,
} from "./connector-text.ts";

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

// I06-R14, I06-C11 ④ ⑤: the slots of an instance, their states, the entry and the words of the four reasons
const NAME = `connector.${"b".repeat(32)}.token`;
const declared = (over: Partial<ConnectorSummary> = {}): ConnectorSummary => ({
  id: "mail-1",
  kind: "k",
  state: "unavailable",
  reason: "credential-missing",
  credentials: [{ slot: "token", name: NAME, state: "missing" }],
  ...over,
});
const renderCredentials = (connector: ConnectorSummary, withBridge = true) =>
  render({
    connectors: [connector],
    canEnterCredentials: withBridge,
    credentialNotes: {},
    onCredentialChange: () => {},
  });

describe("ConnectorTable credentials", () => {
  it("shows each reason in its own words on the row of the instance", () => {
    const seen = CREDENTIAL_REASONS.map((reason) => {
      const html = renderCredentials(declared({ reason }));
      expect(html).toContain(CREDENTIAL_REASON_TEXT[reason]);
      return html;
    });
    expect(new Set(seen).size).toBe(CREDENTIAL_REASONS.length);
  });

  it("lists a slot with its state, a labelled password input and a save button, when the shell is there", () => {
    const html = renderCredentials(declared());
    expect(html).toContain(CREDENTIAL_SLOT_STATE_TEXT.missing);
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('aria-label="mail-1 token 값"');
    expect(html).toContain("저장");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>저장<\/button>/); // nothing typed: nothing to save
    expect(html).not.toContain("삭제"); // nothing stored: nothing to delete
  });

  it("offers the delete button only where a value is stored, and the stored name is not in the page", () => {
    const html = renderCredentials(
      declared({ credentials: [{ slot: "token", name: NAME, state: "present" }] }),
    );
    expect(html).toContain('aria-label="mail-1 token 삭제"');
    expect(html).toContain(CREDENTIAL_SLOT_STATE_TEXT.present);
    expect(html).not.toContain(NAME);
  });

  it("F2 the input is not controlled: no value attribute is drawn, so a typed value never sits in the DOM", () => {
    expect(renderCredentials(declared())).not.toMatch(/<input[^>]* value=/);
  });

  it("says the state of a slot the store cannot answer for, in its own words", () => {
    const html = renderCredentials(
      declared({
        reason: "credential-store-unavailable",
        credentials: [{ slot: "token", name: NAME, state: "unavailable" }],
      }),
    );
    expect(html).toContain(CREDENTIAL_SLOT_STATE_TEXT.unavailable);
    // F6, decision row 1: the state is the last check, so the input stays; a failed save says so (connector-credential.test ③)
    expect(html).toContain('type="password"');
    expect(html).toContain('aria-label="mail-1 token 저장"');
  });

  it("shows no input without the shell, only the notice that this run has no store", () => {
    const html = renderCredentials(declared(), false);
    expect(html).not.toContain("<input");
    expect(html).not.toContain('type="password"');
    expect(html).toContain("이 실행에는 저장소가 없습니다");
  });

  it("draws nothing of credentials for an instance that declared no slot, with or without the shell", () => {
    for (const withBridge of [true, false]) {
      const html = renderCredentials(
        { id: "plain", kind: "k", state: "ready" } as ConnectorSummary,
        withBridge,
      );
      expect(html).not.toContain("<input");
      expect(html).not.toContain("저장소가 없습니다");
    }
  });

  it("puts the note of the last credential action on the row of its instance only", () => {
    const html = render({
      connectors: [declared(), declared({ id: "other" })],
      canEnterCredentials: true,
      credentialNotes: { other: "곧 반영됩니다" },
      onCredentialChange: () => {},
    });
    expect(html.split("곧 반영됩니다")).toHaveLength(2);
    const [first, second] = html.split("<tr>").slice(1) as [string, string];
    expect(first).not.toContain("곧 반영됩니다");
    expect(second).toContain("곧 반영됩니다");
  });
});
