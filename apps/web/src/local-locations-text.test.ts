// I02B-R38, C28 (approval half), FU-5: every approval refusal code has one text, the key set is the
// contract's list, and the unreachable-location text says how to clear it.
import { LOCAL_APPROVAL_REJECTION_CODES, LOCAL_SKIP_REASON_CODES } from "@pki/contracts";
import { expect, it } from "vitest";
import { APPROVAL_REJECTION_TEXT, SKIP_REASON_TEXT } from "./local-locations-text.ts";

it("has one text per refusal code, and the unreachable one says to reconnect", () => {
  expect(Object.keys(APPROVAL_REJECTION_TEXT).sort()).toEqual(
    [...LOCAL_APPROVAL_REJECTION_CODES].sort(),
  );
  for (const text of Object.values(APPROVAL_REJECTION_TEXT)) expect(text.length).toBeGreaterThan(0);
  expect(APPROVAL_REJECTION_TEXT["location-unreachable"]).toContain("다시 연결");
});

it("has one text per skip reason code (C28)", () => {
  expect(Object.keys(SKIP_REASON_TEXT).sort()).toEqual([...LOCAL_SKIP_REASON_CODES].sort());
  for (const text of Object.values(SKIP_REASON_TEXT)) expect(text.length).toBeGreaterThan(0);
});
