// I04-H1 `docs.site-setup` (I04-R18): every site follow-up item in the I04 spec has a
// same-numbered item under `## 배포처 설정 체크리스트`, the checklist's declared I04 range
// (S21~S22) holds exactly that many items, and what the S21/S22 items and the build-time
// table row name (files, constants, the runner command) still exists in the repository: a
// renamed constant or a removed path turns this red. A separate file from site-setup.test.ts
// (V01), as the I02-A test is, so the specs' tests do not touch the same file.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const docsDir = resolve(repoRoot, "docs");
const specText = readFileSync(resolve(docsDir, "specs/2026-11-21-I04-invalidation.md"), "utf8");
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

function checklistSection(site: string): string {
  const all = site.split("\n");
  const start = all.indexOf(CHECKLIST_HEADING);
  if (start < 0) return "";
  const rest = all.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

function checklistItems(site: string) {
  const section = checklistSection(site);
  const numbers = [...section.matchAll(/^- \[[ x]\] \*\*(S\d{2}) /gm)].flatMap((m) => m[1] ?? []);
  const range = /\[I04\]\([^)]*\) S(\d{2})~S(\d{2})/.exec(section);
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
    problems.push("site-setup: checklist does not declare the I04 number range");
  } else {
    const [from, to] = c.range as [number, number];
    const owned = c.numbers.filter((x) => Number(x.slice(1)) >= from && Number(x.slice(1)) <= to);
    if (owned.length !== s.numbers.length) {
      problems.push(
        `count mismatch: spec has ${s.numbers.length}, checklist I04 range has ${owned.length}`,
      );
    }
  }
  return problems;
}

/** The text of one checklist item (from its `- [ ] **Snn` line to the next item or heading). */
function itemText(site: string, number: string): string {
  const lines = checklistSection(site).split("\n");
  const start = lines.findIndex((l) => l.startsWith(`- [ ] **${number} `));
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("- [") || l.startsWith("#"));
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join("\n");
}

/** The build-time table row that names the scope policy constant (site-setup section 2). */
function buildTableRow(site: string): string {
  return site.split("\n").find((l) => l.startsWith("| 접근 범위 정책")) ?? "";
}

/** File paths a text names in backticks (`dir/file.ext`) or in a relative link target. */
function namedPaths(text: string): string[] {
  const ext = "(?:ts|tsx|py|md|json)";
  const ticked = [...text.matchAll(new RegExp("`([A-Za-z0-9_./-]+/[A-Za-z0-9_.-]+\\." + ext + ")`", "g"))];
  const linked = [...text.matchAll(new RegExp("\\]\\((?!https?:)([^)#]+\\." + ext + ")(?:#[^)]*)?\\)", "g"))];
  return [
    ...ticked.map((m) => m[1] as string),
    // a link target is relative to docs/
    ...linked.map((m) => resolve(docsDir, m[1] as string).slice(repoRoot.length + 1)),
  ];
}

/**
 * What the I04 items rely on in the code, by name: the doc must name it, and the file must hold it.
 * `item` says where the doc names it.
 */
const NAMED_FACTS = [
  {
    item: "S21",
    token: "SCOPE_POLICY",
    file: "apps/desktop/src/layout.production.ts",
    holds: 'export const SCOPE_POLICY = "',
  },
  {
    item: "S21",
    token: "PKI_SCOPE_POLICY",
    file: "apps/desktop/src/layout.ts",
    holds: "PKI_SCOPE_POLICY",
  },
  {
    item: "S21",
    token: "productScopePolicy",
    file: "backend/src/scope-policy.ts",
    holds: "export function productScopePolicy(",
  },
  {
    item: "S21",
    token: "ScopePolicy",
    file: "storage/src/derivatives.ts",
    holds: "export interface ScopePolicy {",
  },
  {
    item: "S21",
    token: "read-gate.ts",
    file: "backend/src/read-gate.ts",
    holds: "visible",
  },
  {
    item: "S22",
    token: "delete-scenario",
    file: "verification/v02-site-flow/run.py",
    holds: 'add_parser("delete-scenario")',
  },
  {
    item: "S22",
    token: "findCanaries",
    file: "packages/testkit/src/canary-files.ts",
    holds: "export function findCanaries(",
  },
] as const;

describe("docs.site-setup (I04)", () => {
  it("each I04 site follow-up item has a same-numbered checklist item", () => {
    expect(specItems(specText).numbers).toEqual(["S21", "S22"]);
    expect(correspondenceProblems(specText, siteText)).toEqual([]);
  });

  it("fails when a checklist item is missing", () => {
    const mutated = siteText.replace(/^- \[ \] \*\*S22 .*$/m, "");
    expect(correspondenceProblems(specText, mutated)).toContain(
      "site-setup: S22 appears 0 times, expected 1",
    );
  });

  it("fails when a checklist number is duplicated", () => {
    const mutated = siteText.replace("**S22 ", "**S21 ");
    const problems = correspondenceProblems(specText, mutated);
    expect(problems).toContain("site-setup: S21 appears 2 times, expected 1");
    expect(problems).toContain("site-setup: S22 appears 0 times, expected 1");
  });

  it("fails when the spec table and its declared count disagree", () => {
    const mutated = specText.replace(/^\| S22 \|.*\n/m, "");
    expect(correspondenceProblems(mutated, siteText)).toContain(
      "spec: declares 2 items but the table has 1",
    );
  });

  it("fails when the checklist's I04 range holds a different number of items", () => {
    const mutated = siteText.replace("S21~S22", "S21~S21");
    expect(correspondenceProblems(specText, mutated)).toContain(
      "count mismatch: spec has 2, checklist I04 range has 1",
    );
  });

  it("fails when the I04 range statement is dropped", () => {
    const mutated = siteText.replace("S21~S22", "");
    expect(correspondenceProblems(specText, mutated)).toContain(
      "site-setup: checklist does not declare the I04 number range",
    );
  });

  it("fails when the checklist heading is renamed", () => {
    const mutated = siteText.replace(CHECKLIST_HEADING, "## 체크리스트");
    expect(correspondenceProblems(specText, mutated).length).toBeGreaterThan(0);
  });
});

describe("docs.site-setup (I04): what the items name exists", () => {
  const s21 = itemText(siteText, "S21");
  const s22 = itemText(siteText, "S22");
  const row = buildTableRow(siteText);

  it("finds the two items and the build-time row", () => {
    expect(s21.length).toBeGreaterThan(200);
    expect(s22.length).toBeGreaterThan(200);
    expect(row).toContain("SCOPE_POLICY");
  });

  it("every file path S21, S22 and the build-time row name exists in the repository", () => {
    const paths = [...namedPaths(s21), ...namedPaths(s22), ...namedPaths(row)];
    expect(paths.length).toBeGreaterThanOrEqual(6);
    const missing = paths.filter((p) => !existsSync(resolve(repoRoot, p)));
    expect(missing).toEqual([]);
  });

  it.each(NAMED_FACTS)("$item names $token and $file holds it", (fact) => {
    expect(fact.item === "S21" ? s21 : s22).toContain(fact.token);
    expect(readFileSync(resolve(repoRoot, fact.file), "utf8")).toContain(fact.holds);
  });

  it("the build-time row names the constant the code defines", () => {
    expect(row).toContain("apps/desktop/src/layout.production.ts");
    expect(row).toContain("`SCOPE_POLICY`");
  });

  it("fails when a named constant is renamed in the doc", () => {
    const mutated = siteText.replaceAll("SCOPE_POLICY`", "SCOPE_POLICY_RENAMED`");
    expect(itemText(mutated, "S21")).not.toContain("`SCOPE_POLICY`");
    expect(buildTableRow(mutated)).not.toContain("`SCOPE_POLICY`");
  });

  it("fails when a file the doc names does not exist", () => {
    const mutated = itemText(siteText, "S21").replace(
      "backend/src/scope-policy.ts",
      "backend/src/no-such-scope-policy.ts",
    );
    const missing = namedPaths(mutated).filter((p) => !existsSync(resolve(repoRoot, p)));
    expect(missing).toEqual(["backend/src/no-such-scope-policy.ts"]);
  });

  it("fails when a link target in the items does not exist", () => {
    const mutated = itemText(siteText, "S22").replace(
      "](../verification/v02-site-flow/RUNBOOK.md)",
      "](../verification/v02-site-flow/NO-SUCH.md)",
    );
    const missing = namedPaths(mutated).filter((p) => !existsSync(resolve(repoRoot, p)));
    expect(missing).toEqual(["verification/v02-site-flow/NO-SUCH.md"]);
  });
});
