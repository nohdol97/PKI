// V01-H1, V02-H1 `docs.site-setup`: every site follow-up item in a spec's
// non-goals table has a same-numbered item under `## 배포처 설정 체크리스트`,
// and the checklist's declared number range for that spec holds the same count.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const docsDir = resolve(import.meta.dirname, "../../docs");
const specText = readFileSync(resolve(docsDir, "specs/2026-11-21-V01-vertical-skeleton.md"), "utf8");
const v02Text = readFileSync(resolve(docsDir, "specs/2026-11-21-V02-vertical-slice.md"), "utf8");
const siteText = readFileSync(resolve(docsDir, "site-setup.md"), "utf8");

const CHECKLIST_HEADING = "## 배포처 설정 체크리스트";

function specItems(spec: string) {
  const header = /^\*\*배포처 후속 항목\*\*\((\d+)개/m.exec(spec);
  if (!header) return { declared: undefined, numbers: [] };
  const lines = spec.slice(header.index).split("\n").slice(1);
  const start = lines.findIndex((l) => l.startsWith("|"));
  const table = [];
  for (const line of lines.slice(start)) {
    if (!line.startsWith("|")) break;
    table.push(line);
  }
  const numbers = table.flatMap((l) => /^\|\s*(S\d{2})\s*\|/.exec(l)?.[1] ?? []);
  return { declared: Number(header[1]), numbers };
}

function checklistItems(site: string, spec: string) {
  const start = site.split("\n").indexOf(CHECKLIST_HEADING);
  if (start < 0) return { numbers: [], range: undefined };
  const rest = site.split("\n").slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  const section = (end < 0 ? rest : rest.slice(0, end)).join("\n");
  const numbers = [...section.matchAll(/^- \[[ x]\] \*\*(S\d{2}) /gm)].flatMap((m) => m[1] ?? []);
  const range = new RegExp(`\\[${spec}\\]\\([^)]*\\) S(\\d{2})~S(\\d{2})`).exec(section);
  return { numbers, range: range ? [Number(range[1]), Number(range[2])] : undefined };
}

function correspondenceProblems(spec: string, site: string, label = "V01"): string[] {
  const problems: string[] = [];
  const s = specItems(spec);
  const c = checklistItems(site, label);
  if (s.numbers.length === 0) problems.push("spec: site follow-up table not found");
  if (s.declared !== s.numbers.length) {
    problems.push(`spec: declares ${s.declared} items but the table has ${s.numbers.length}`);
  }
  if (c.numbers.length === 0) problems.push(`site-setup: no items under ${CHECKLIST_HEADING}`);
  for (const n of s.numbers) {
    const hits = c.numbers.filter((x) => x === n).length;
    if (hits !== 1) problems.push(`site-setup: ${n} appears ${hits} times, expected 1`);
  }
  if (!c.range) {
    problems.push(`site-setup: checklist does not declare the ${label} number range`);
  } else {
    const [from, to] = c.range as [number, number];
    const owned = c.numbers.filter((x) => Number(x.slice(1)) >= from && Number(x.slice(1)) <= to);
    if (owned.length !== s.numbers.length) {
      problems.push(
        `count mismatch: spec has ${s.numbers.length}, checklist ${label} range has ${owned.length}`,
      );
    }
  }
  return problems;
}

describe("docs.site-setup", () => {
  it("each V01 site follow-up item has a same-numbered checklist item", () => {
    expect(specItems(specText).numbers).toHaveLength(13);
    expect(correspondenceProblems(specText, siteText)).toEqual([]);
  });

  it("fails when a checklist item is missing", () => {
    const mutated = siteText.replace(/^- \[ \] \*\*S07 .*$/m, "");
    expect(correspondenceProblems(specText, mutated)).toContain(
      "site-setup: S07 appears 0 times, expected 1",
    );
  });

  it("fails when a checklist number is duplicated", () => {
    const mutated = siteText.replace("**S08 ", "**S07 ");
    const problems = correspondenceProblems(specText, mutated);
    expect(problems).toContain("site-setup: S07 appears 2 times, expected 1");
    expect(problems).toContain("site-setup: S08 appears 0 times, expected 1");
  });

  it("fails when the spec table and its declared count disagree", () => {
    const mutated = specText.replace(/^\| S13 \|.*\n/m, "");
    expect(correspondenceProblems(mutated, siteText)).toContain(
      "spec: declares 13 items but the table has 12",
    );
  });

  it("fails when the checklist's V01 range holds a different number of items", () => {
    const mutated = siteText.replace("S01~S13", "S01~S14");
    expect(correspondenceProblems(specText, mutated)).toContain(
      "count mismatch: spec has 13, checklist V01 range has 14",
    );
  });

  it("fails when the checklist heading is renamed", () => {
    const mutated = siteText.replace(CHECKLIST_HEADING, "## 체크리스트");
    expect(correspondenceProblems(specText, mutated).length).toBeGreaterThan(0);
  });
});

describe("docs.site-setup V02", () => {
  it("each V02 site follow-up item has a same-numbered checklist item", () => {
    expect(specItems(v02Text).numbers).toEqual(["S14", "S15"]);
    expect(correspondenceProblems(v02Text, siteText, "V02")).toEqual([]);
  });

  it("fails when a V02 checklist item is missing", () => {
    const mutated = siteText.replace(/^- \[ \] \*\*S15 .*$/m, "");
    expect(correspondenceProblems(v02Text, mutated, "V02")).toContain(
      "site-setup: S15 appears 0 times, expected 1",
    );
  });

  it("fails when the V02 spec table and its declared count disagree", () => {
    const mutated = v02Text.replace(/^\| S15 \|.*\n/m, "");
    expect(correspondenceProblems(mutated, siteText, "V02")).toContain(
      "spec: declares 2 items but the table has 1",
    );
  });

  it("fails when the checklist's V02 range holds a different number of items", () => {
    const mutated = siteText.replace("S14~S15", "S13~S15");
    expect(correspondenceProblems(v02Text, mutated, "V02")).toContain(
      "count mismatch: spec has 2, checklist V02 range has 3",
    );
  });

  it("fails when the checklist does not declare the V02 range", () => {
    const mutated = siteText.replace(/\[V02\]\([^)]*\) S14~S15/, "V02");
    expect(correspondenceProblems(v02Text, mutated, "V02")).toContain(
      "site-setup: checklist does not declare the V02 number range",
    );
  });
});
