// I03-H1 `docs.site-setup` (I03-R26): every site follow-up item in the I03 spec has a
// same-numbered item under `## 배포처 설정 체크리스트` exactly once, the checklist's declared
// I03 range (S19~S20) holds exactly that many items, the runtime-settings table names
// `jobs.maxConcurrent` as the code reads it, and what S19 and S20 name (files, constants,
// the runner command, the API path) still exists in the repository: a removed item or a
// renamed constant turns this red. A separate file from the other site-setup tests so the
// specs' tests do not touch the same file.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const docsDir = resolve(repoRoot, "docs");
const specText = readFileSync(resolve(docsDir, "specs/2026-11-21-I03-persistent-queue.md"), "utf8");
const siteText = readFileSync(resolve(docsDir, "site-setup.md"), "utf8");

const CHECKLIST_HEADING = "## 배포처 설정 체크리스트";
const SETTINGS_HEADING = "### 실행 중 설정";

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

function sectionAfter(site: string, heading: string): string {
  const all = site.split("\n");
  const start = all.indexOf(heading);
  if (start < 0) return "";
  const rest = all.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,3} /.test(l) && !l.startsWith("####"));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
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
  const range = /\[I03\]\([^)]*\) S(\d{2})~S(\d{2})/.exec(section);
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
    problems.push("site-setup: checklist does not declare the I03 number range");
  } else {
    const [from, to] = c.range as [number, number];
    const owned = c.numbers.filter((x) => Number(x.slice(1)) >= from && Number(x.slice(1)) <= to);
    if (owned.length !== s.numbers.length) {
      problems.push(
        `count mismatch: spec has ${s.numbers.length}, checklist I03 range has ${owned.length}`,
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

/** The runtime-settings table row whose first cell names `key`. */
function settingsRow(site: string, key: string): string {
  return (
    sectionAfter(site, SETTINGS_HEADING)
      .split("\n")
      .find((l) => l.startsWith(`| \`${key}\``)) ?? ""
  );
}

/** File paths a text names in backticks (`dir/file.ext`) or in a relative link target. */
function namedPaths(text: string): string[] {
  const ext = "(?:ts|tsx|py|md|json)";
  const ticked = [...text.matchAll(new RegExp("`([A-Za-z0-9_./-]+/[A-Za-z0-9_.-]+\\." + ext + ")`", "g"))];
  const linked = [...text.matchAll(new RegExp("\\]\\((?!https?:)([^)#]+\\." + ext + ")(?:#[^)]*)?\\)", "g"))];
  return [
    ...ticked.map((m) => m[1] as string),
    ...linked.map((m) => resolve(docsDir, m[1] as string).slice(repoRoot.length + 1)),
  ];
}

function namesToken(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(text);
}

/** What S19, S20 and the settings row rely on in the code, by name: the doc names it, the file holds it. */
const NAMED_FACTS = [
  { item: "S19", token: "queue-scenario", file: "verification/v02-site-flow/run.py", holds: 'add_parser("queue-scenario")' },
  { item: "S19", token: "sleep-confirmation.json", file: "verification/v02-site-flow/queue_scenario.py", holds: 'SLEEP_RECORD_FILE = "sleep-confirmation.json"' },
  { item: "S19", token: "powerMonitor", file: "docs/specs/2026-11-21-I03-persistent-queue.md", holds: "powerMonitor" },
  { item: "S20", token: "/api/jobs", file: "packages/contracts/src/index.ts", holds: 'path: "/api/jobs"' },
  { item: "S20", token: "DEFAULT_MAX_ATTEMPTS", file: "storage/src/jobs.ts", holds: "export const DEFAULT_MAX_ATTEMPTS = " },
  { item: "S20", token: "jobs.maxConcurrent", file: "backend/src/job-runner.ts", holds: 'JOBS_MAX_CONCURRENT_SETTING = "jobs.maxConcurrent"' },
  { item: "S20", token: "OPEN_JOB_CAP", file: "backend/src/scheduler.ts", holds: "export const OPEN_JOB_CAP = 1000;" },
  { item: "S20", token: "DEFAULT_MAX_REQUESTS", file: "backend/src/job-broker.ts", holds: "export const DEFAULT_MAX_REQUESTS = 2;" },
  { item: "S20", token: "DEFAULT_LIMITS", file: "providers/src/broker.ts", holds: "callBudget: Object.freeze({ maxCalls: 60, windowMs: 3_600_000 })" },
  { item: "S20", token: "/api/schedules/change", file: "packages/contracts/src/index.ts", holds: 'path: "/api/schedules/change"' },
] as const;

describe("docs.site-setup (I03)", () => {
  it("each I03 site follow-up item has a same-numbered checklist item", () => {
    expect(specItems(specText).numbers).toEqual(["S19", "S20"]);
    expect(correspondenceProblems(specText, siteText)).toEqual([]);
  });

  it("fails when a checklist item is missing", () => {
    for (const n of ["S19", "S20"]) {
      const mutated = siteText.replace(new RegExp(`^- \\[ \\] \\*\\*${n} .*$`, "m"), "");
      expect(correspondenceProblems(specText, mutated)).toContain(
        `site-setup: ${n} appears 0 times, expected 1`,
      );
    }
  });

  it("fails when a checklist number is duplicated", () => {
    const mutated = siteText.replace("**S20 ", "**S19 ");
    const problems = correspondenceProblems(specText, mutated);
    expect(problems).toContain("site-setup: S19 appears 2 times, expected 1");
    expect(problems).toContain("site-setup: S20 appears 0 times, expected 1");
  });

  it("fails when the spec table and its declared count disagree", () => {
    const mutated = specText.replace(/^\| S20 \|.*\n/m, "");
    expect(correspondenceProblems(mutated, siteText)).toContain(
      "spec: declares 2 items but the table has 1",
    );
  });

  it("fails when the checklist's I03 range holds a different number of items", () => {
    const mutated = siteText.replace("S19~S20", "S19~S21");
    expect(correspondenceProblems(specText, mutated)).toContain(
      "count mismatch: spec has 2, checklist I03 range has 3",
    );
  });

  it("fails when the I03 range statement is dropped", () => {
    const mutated = siteText.replace("S19~S20", "");
    expect(correspondenceProblems(specText, mutated)).toContain(
      "site-setup: checklist does not declare the I03 number range",
    );
  });

  it("fails when the checklist heading is renamed", () => {
    const mutated = siteText.replace(CHECKLIST_HEADING, "## 체크리스트");
    expect(correspondenceProblems(specText, mutated).length).toBeGreaterThan(0);
  });
});

describe("docs.site-setup (I03): the runtime setting and what the items name exist", () => {
  const s19 = itemText(siteText, "S19");
  const s20 = itemText(siteText, "S20");

  it("the `jobs.maxConcurrent` row names the range and the default the code has", () => {
    const row = settingsRow(siteText, "jobs.maxConcurrent");
    expect(row).not.toBe("");
    const cells = row.split(" | ").map((c) => c.replace(/^\||\|$/g, "").trim());
    const store = readFileSync(resolve(repoRoot, "storage/src/job-concurrency.ts"), "utf8");
    const codeDefault = /export const DEFAULT_MAX_CONCURRENT = (\d+);/.exec(store)?.[1];
    expect(codeDefault).toBeDefined();
    // the last cell is the whole default, not a row that happens to contain the digit
    expect(cells[cells.length - 1]).toBe(codeDefault);
    const code = readFileSync(resolve(repoRoot, "backend/src/job-runner.ts"), "utf8");
    const range = /const MAX_CONCURRENT_VALUES = \/\^\[(\d)-(\d)\]\$\/;/.exec(code);
    expect(range).not.toBeNull();
    expect(row).toContain(`**${range?.[1]}에서 ${range?.[2]}까지의 정수**`);
  });

  it("fails when the documented default differs from the code's", () => {
    const mutated = settingsRow(siteText, "jobs.maxConcurrent").replace(/\| 2 \|$/, "| 3 |");
    const cells = mutated.split(" | ").map((c) => c.replace(/^\||\|$/g, "").trim());
    expect(cells[cells.length - 1]).toBe("3");
    expect(cells[cells.length - 1]).not.toBe("2");
  });

  it("fails when the settings row is removed", () => {
    const mutated = siteText.replace(/^\| `jobs\.maxConcurrent`.*\n/m, "");
    expect(settingsRow(mutated, "jobs.maxConcurrent")).toBe("");
  });

  it("the setting's range in the doc is the one the code reads", () => {
    const code = readFileSync(resolve(repoRoot, "backend/src/job-runner.ts"), "utf8");
    expect(code).toContain("const MAX_CONCURRENT_VALUES = /^[1-4]$/;");
    expect(code).toContain('"jobs.maxConcurrent"');
    const store = readFileSync(resolve(repoRoot, "storage/src/job-concurrency.ts"), "utf8");
    expect(store).toContain("DEFAULT_MAX_CONCURRENT = 2;");
  });

  it("finds the two items", () => {
    expect(s19.length).toBeGreaterThan(200);
    expect(s20.length).toBeGreaterThan(200);
  });

  it("every file path S19 and S20 name exists in the repository", () => {
    const paths = [...namedPaths(s19), ...namedPaths(s20)];
    expect(paths.length).toBeGreaterThanOrEqual(2);
    const missing = paths.filter((p) => !existsSync(resolve(repoRoot, p)));
    expect(missing).toEqual([]);
  });

  it.each(NAMED_FACTS)("$item names $token and $file holds it", (fact) => {
    expect(namesToken(fact.item === "S19" ? s19 : s20, fact.token)).toBe(true);
    expect(readFileSync(resolve(repoRoot, fact.file), "utf8")).toContain(fact.holds);
  });

  it("fails when a file the doc names does not exist", () => {
    const mutated = s19.replace(
      "](../verification/v02-site-flow/RUNBOOK.md)",
      "](../verification/v02-site-flow/NO-SUCH.md)",
    );
    const missing = namedPaths(mutated).filter((p) => !existsSync(resolve(repoRoot, p)));
    expect(missing).toEqual(["verification/v02-site-flow/NO-SUCH.md"]);
  });
});
