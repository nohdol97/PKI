// S03-H1 `docs.site-setup` (S03): the one site follow-up item of the S03 spec (S34) has a same-numbered item under
// `## 배포처 설정 체크리스트`, and the checklist's declared S03 range (S34~S34) holds exactly that many items. What S34
// names exists: the runner subcommand, both setting keys, the RUNBOOK section, the two settings rows that name S34, and
// ADR 0023 which ARCHITECTURE links. A separate file from the other site-setup tests so the specs' tests do not touch
// the same file.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const docsDir = resolve(repoRoot, "docs");
const specText = readFileSync(
  resolve(docsDir, "specs/2026-11-22-S03-analytical-semantic.md"),
  "utf8",
);
const siteText = readFileSync(resolve(docsDir, "site-setup.md"), "utf8");
const archText = readFileSync(resolve(docsDir, "ARCHITECTURE.md"), "utf8");
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");

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

function checklist(site: string) {
  const all = site.split("\n");
  const start = all.indexOf(CHECKLIST_HEADING);
  if (start < 0) return { section: "", numbers: [] as string[], range: undefined };
  const rest = all.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  const section = (end < 0 ? rest : rest.slice(0, end)).join("\n");
  const numbers = [...section.matchAll(/^- \[[ x]\] \*\*(S\d{2}) /gm)].flatMap((m) => m[1] ?? []);
  const range = /\[S03\]\([^)]*\) S(\d{2})(?:~S(\d{2}))?/.exec(section);
  return {
    section,
    numbers,
    range: range ? [Number(range[1]), Number(range[2] ?? range[1])] : undefined,
  };
}

function correspondenceProblems(spec: string, site: string): string[] {
  const problems: string[] = [];
  const s = specItems(spec);
  const c = checklist(site);
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
    problems.push("site-setup: checklist does not declare the S03 number range");
  } else {
    const [from, to] = c.range as [number, number];
    const owned = c.numbers.filter((x) => Number(x.slice(1)) >= from && Number(x.slice(1)) <= to);
    if (owned.length !== s.numbers.length) {
      problems.push(
        `count mismatch: spec has ${s.numbers.length}, checklist S03 range has ${owned.length}`,
      );
    }
  }
  return problems;
}

/** The text of the checklist item numbered `n`: its line, up to the next item or heading. */
function item(site: string, n: string): string {
  const lines = site.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`- [ ] **${n} `));
  if (at < 0) return "";
  const end = lines.findIndex((l, i) => i > at && (l.startsWith("- [") || l.startsWith("#")));
  return lines.slice(at, end < 0 ? undefined : end).join("\n");
}

describe("docs.site-setup (S03): the checklist and the spec correspond", () => {
  it("the one S03 site follow-up item has a same-numbered checklist item, S34 once, one in the range", () => {
    expect(specItems(specText)).toEqual({ declared: 1, numbers: ["S34"] });
    expect(correspondenceProblems(specText, siteText)).toEqual([]);
    expect(checklist(siteText).range).toEqual([34, 34]);
    const mutated = siteText.replace(/^- \[ \] \*\*S34 .*$/m, "");
    expect(correspondenceProblems(specText, mutated)).toContain(
      "site-setup: S34 appears 0 times, expected 1",
    );
  });
});

describe("docs.site-setup (S03): S34 names what exists", () => {
  it("S34 names the runner subcommand, both settings and the RUNBOOK section, all present; the two settings rows sit in the S34 section; ADR 0023 is linked", () => {
    const s34 = item(siteText, "S34");
    expect(s34.length).toBeGreaterThan(300);
    for (const word of [
      "analytical-scenario preflight|record",
      "analytical.profile",
      "analytical.maxCells",
      "배포처 후속",
      "RUNBOOK",
      "이슈 #24",
    ]) {
      expect(s34, word).toContain(word);
    }
    expect(read("verification/v02-site-flow/run.py")).toContain(
      'sub.add_parser("analytical-scenario")',
    );
    const settings = read("storage/src/analytical.ts");
    expect(settings).toContain('export const ANALYTICAL_PROFILE_SETTING = "analytical.profile";');
    expect(settings).toContain('export const ANALYTICAL_MAX_CELLS_SETTING = "analytical.maxCells";');
    expect(read("verification/v02-site-flow/RUNBOOK.md")).toContain("## 12. 분석 의미 실측 (S34");
    for (const key of ["analytical.profile", "analytical.maxCells"]) {
      const row = siteText.split("\n").find((l) => l.startsWith(`| \`${key}\``));
      expect(row, key).toBeDefined();
      expect(siteText.indexOf(row ?? "")).toBeGreaterThan(siteText.indexOf("### 분석 의미의 실측과 프로파일"));
    }
    expect(readdirSync(resolve(docsDir, "adr")).filter((f) => f.startsWith("0023-"))).toHaveLength(1);
    expect(archText).toContain("adr/0023-analytical-semantic-rows-and-data-checks.md");
  });
});
