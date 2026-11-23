// K01-R16: the Wiki screen's words. A claim shows its status always, and a conflict or replacement
// marker when it has one; a code the file does not know is shown as itself.
import type { WikiClaim } from "@pki/contracts";
import { describe, expect, it } from "vitest";
import { claimMarks, pageKindText, validityText } from "./wiki-text.ts";

const claim: WikiClaim = {
  ref: { kind: "fact", id: 1 },
  kind: "target_date",
  value: "2026-12-05",
  status: "disputed",
  epistemic: "explicit",
  validAt: "2026-12-05",
  validUntil: null,
  evidence: [1],
  contradicts: [{ kind: "fact", id: 2 }],
  supersedes: [],
};

describe("claim words", () => {
  it("marks the status and the conflict, and words the validity", () => {
    expect(claimMarks(claim)).toEqual(["이의 있음", "충돌 1건"]);
    expect(claimMarks({ ...claim, status: "verified", contradicts: [] })).toEqual(["확인됨"]);
    expect(validityText(claim)).toBe("2026-12-05부터");
  });

  it("shows a kind it does not know as its code", () => {
    expect(pageKindText("projects")).toBe("프로젝트");
    expect(pageKindText("future-kind")).toBe("future-kind");
  });
});
