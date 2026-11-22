// I01-R17: the Sources screen marks a Connector whose rescan may have missed
// deletions, so that a source gone at the origin but still shown is not a surprise.
import { describe, expect, it } from "vitest";
import { connectorNote, DELETIONS_MAY_BE_MISSED } from "./connector-text.ts";

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
