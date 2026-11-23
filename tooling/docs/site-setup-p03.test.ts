// P03-T5 `docs.feedback-learned`: the setting key the docs name is the code's constant, and the three docs the
// spec lists carry what they must: the site-setup item S36 (once, with the key), ARCHITECTURE's storage row for
// the feedback table, and EVALUATION's before/after metrics. A separate file from the other site-setup tests.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");

const constant = /FEEDBACK_LEARNED_SETTING = "([^"]+)"/.exec(read("storage/src/feedback.ts"))?.[1];

describe("docs.feedback-learned (P03-T5)", () => {
  it("names the setting key the code reads, in the site-setup table and item S36", () => {
    expect(constant).toBe("feedback.learned");
    const site = read("docs/site-setup.md");
    expect(site).toContain(`| \`${constant}\` |`);
    const items = [...site.matchAll(/^- \[[ x]\] \*\*S36 .*$/gm)];
    expect(items).toHaveLength(1);
    expect(items[0]?.[0]).toContain("`feedback.learned`");
  });

  it("ARCHITECTURE's storage row describes the feedback table, and EVALUATION defines both metrics", () => {
    const arch = read("docs/ARCHITECTURE.md");
    expect(arch).not.toContain("피드백·선호 | 아직 없다");
    expect(arch).toMatch(/^\| 피드백\(`feedback`, P03-T1, 스키마 v32\)/m);
    const evaluation = read("docs/EVALUATION.md");
    expect(evaluation).toContain("상위 3건 관련 비율");
    expect(evaluation).toContain("관련 있음 평균 순위");
  });
});
