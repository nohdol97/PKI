// I01-R17: the Sources screen marks a Connector whose rescan may have missed
// deletions, so that a source gone at the origin but still shown is not a surprise.
import { SYNC_STOP_CODES } from "@pki/contracts";
import { describe, expect, it } from "vitest";
import { connectorNote, DELETIONS_MAY_BE_MISSED, syncStopText } from "./connector-text.ts";

describe("connectorNote", () => {
  it("says deletions during the expired window may be missed, when the Connector says so", () => {
    expect(connectorNote({ id: "c", kind: "k", state: "ready", deletionsMayBeMissed: true })).toBe(
      DELETIONS_MAY_BE_MISSED,
    );
    expect(DELETIONS_MAY_BE_MISSED).toBe("만료된 동안 지워진 원본을 놓쳤을 수 있음");
  });

  it("says nothing otherwise", () => {
    expect(connectorNote({ id: "c", kind: "k", state: "ready" })).toBeUndefined();
    expect(
      connectorNote({ id: "c", kind: "k", state: "ready", deletionsMayBeMissed: false }),
    ).toBeUndefined();
  });
});

describe("syncStopText", () => {
  it("has its own text for every stop code of the closed list", () => {
    const texts = SYNC_STOP_CODES.map(syncStopText);
    expect(texts.every((t) => t.length > 0)).toBe(true);
    expect(new Set(texts).size).toBe(SYNC_STOP_CODES.length);
  });
});
