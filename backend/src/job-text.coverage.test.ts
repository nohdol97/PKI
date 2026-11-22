// I03-T11: the Activity screen words the codes the backend can put on a job. The screen
// cannot import the backend (module boundary), so this reads its text file as data: a hold reason
// added to the table of held-release.ts without a sentence in apps/web/src/job-text.ts fails here
// instead of reaching the screen as a bare code.
import { COVERED_BY_REBUILD, UNKNOWN_PROJECTION_CODE } from "@pki/storage";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HELD_REASONS } from "./held-release.ts";
import { JOB_BUDGET_EXHAUSTED } from "./job-outcomes.ts";

const text = readFileSync(resolve(import.meta.dirname, "../../apps/web/src/job-text.ts"), "utf8");
const worded = (code: string) => text.includes(`"${code}":`) || text.includes(`  ${code}:`);

describe("job reason words", () => {
  it("has a sentence for every reason a job can be held for", () => {
    const missing = Object.keys(HELD_REASONS).filter((code) => !worded(code));
    expect(missing).toEqual([]);
  });

  it("has a sentence for the other codes the runner and the projection jobs write", () => {
    const codes = [
      COVERED_BY_REBUILD,
      UNKNOWN_PROJECTION_CODE,
      JOB_BUDGET_EXHAUSTED,
      "source-too-large",
      "lineage-covered",
      "adapter-unavailable",
      "projection-unavailable",
      "manager-not-ready",
    ];
    expect(codes.filter((code) => !worded(code))).toEqual([]);
  });
});
