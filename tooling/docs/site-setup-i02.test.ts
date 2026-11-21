// I02A-H1 `docs.site-setup`: every site follow-up item in the I02-A spec has a
// same-numbered item under `## 배포처 설정 체크리스트`, and the checklist's declared
// I02-A range (S16~S17) holds exactly that many items. A separate file from
// site-setup.test.ts (V01) so the two specs' tests do not touch the same file.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const docsDir = resolve(import.meta.dirname, "../../docs");
const specText = readFileSync(
  resolve(docsDir, "specs/2026-11-21-I02-document-normalization.md"),
  "utf8",
);
const siteText = readFileSync(resolve(docsDir, "site-setup.md"), "utf8");

const CHECKLIST_HEADING = "## 배포처 설정 체크리스트";

function specItems(spec: string) {
  const header = /^\*\*배포처 후속 항목\*\*\((\d+)개/m.exec(spec);
  if (!header) return { declared: undefined, numbers: [] as string[] };
  const lines = spec.slice(header.index).split("\n").slice(1);
  const start = lines.findIndex((l) => l.startsWith("|"));
  const table: string[] = [];
  for (const line of lines.slice(start)) {
    if (!line.startsWith("|")) break;
    table.push(line);
  }
  const numbers = table.flatMap((l) => /^\|\s*(S\d{2})\s*\|/.exec(l)?.[1] ?? []);
  return { declared: Number(header[1]), numbers };
}

function checklistItems(site: string) {
  const all = site.split("\n");
  const start = all.indexOf(CHECKLIST_HEADING);
  if (start < 0) return { numbers: [] as string[], range: undefined };
  const rest = all.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  const section = (end < 0 ? rest : rest.slice(0, end)).join("\n");
  const numbers = [...section.matchAll(/^- \[[ x]\] \*\*(S\d{2}) /gm)].flatMap((m) => m[1] ?? []);
  const range = /\[I02-A\]\([^)]*\) S(\d{2})~S(\d{2})/.exec(section);
  return { numbers, range: range ? [Number(range[1]), Number(range[2])] : undefined };
}

function correspondenceProblems(spec: string, site: string): string[] {
  const problems: string[] = [];
  const s = specItems(spec);
  const c = checklistItems(site);
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
    problems.push("site-setup: checklist does not declare the I02-A number range");
  } else {
    const [from, to] = c.range as [number, number];
    const owned = c.numbers.filter((x) => Number(x.slice(1)) >= from && Number(x.slice(1)) <= to);
    if (owned.length !== s.numbers.length) {
      problems.push(
        `count mismatch: spec has ${s.numbers.length}, checklist I02-A range has ${owned.length}`,
      );
    }
  }
  return problems;
}

describe("docs.site-setup (I02-A)", () => {
  it("each I02-A site follow-up item has a same-numbered checklist item", () => {
    expect(specItems(specText).numbers).toEqual(["S16", "S17"]);
    expect(correspondenceProblems(specText, siteText)).toEqual([]);
  });

  it("fails when a checklist item is missing", () => {
    const mutated = siteText.replace(/^- \[ \] \*\*S17 .*$/m, "");
    expect(correspondenceProblems(specText, mutated)).toContain(
      "site-setup: S17 appears 0 times, expected 1",
    );
  });

  it("fails when a checklist number is duplicated", () => {
    const mutated = siteText.replace("**S17 ", "**S16 ");
    const problems = correspondenceProblems(specText, mutated);
    expect(problems).toContain("site-setup: S16 appears 2 times, expected 1");
    expect(problems).toContain("site-setup: S17 appears 0 times, expected 1");
  });

  it("fails when the spec table and its declared count disagree", () => {
    const mutated = specText.replace(/^\| S17 \|.*\n/m, "");
    expect(correspondenceProblems(mutated, siteText)).toContain(
      "spec: declares 2 items but the table has 1",
    );
  });

  it("fails when the checklist's I02-A range holds a different number of items", () => {
    const mutated = siteText.replace("S16~S17", "S15~S17");
    expect(correspondenceProblems(specText, mutated)).toContain(
      "count mismatch: spec has 2, checklist I02-A range has 3",
    );
  });

  it("fails when the I02-A range statement is dropped", () => {
    const mutated = siteText.replace("S16~S17", "");
    expect(correspondenceProblems(specText, mutated)).toContain(
      "site-setup: checklist does not declare the I02-A number range",
    );
  });

  it("fails when the checklist heading is renamed", () => {
    const mutated = siteText.replace(CHECKLIST_HEADING, "## 체크리스트");
    expect(correspondenceProblems(specText, mutated).length).toBeGreaterThan(0);
  });
});
