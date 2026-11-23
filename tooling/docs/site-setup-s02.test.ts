// S02-H1 `docs.site-setup` (S02): the one site follow-up item of the S02 spec (S33) has a same-numbered item under
// `## 배포처 설정 체크리스트`, and the checklist's declared S02 range (S33~S33) holds exactly that many items. What S33
// names in the code exists, the `semantic.autoDispute` settings row and S33 name each other, and ARCHITECTURE states
// the three new kinds, that paths are not stored, and the number of canonical kinds the code registers (S01 follow-up
// #173's P5: a count written in prose goes stale, so it is read from the code). A separate file from the other
// site-setup tests so the specs' tests do not touch the same file.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const docsDir = resolve(repoRoot, "docs");
const specText = readFileSync(
  resolve(docsDir, "specs/2026-11-22-S02-entity-resolution-temporal-graph.md"),
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
  const range = /\[S02\]\([^)]*\) S(\d{2})(?:~S(\d{2}))?/.exec(section);
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
    problems.push("site-setup: checklist does not declare the S02 number range");
  } else {
    const [from, to] = c.range as [number, number];
    const owned = c.numbers.filter((x) => Number(x.slice(1)) >= from && Number(x.slice(1)) <= to);
    if (owned.length !== s.numbers.length) {
      problems.push(
        `count mismatch: spec has ${s.numbers.length}, checklist S02 range has ${owned.length}`,
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

/** The kinds `canonicalKinds()` registers, counted from its list in the code. */
function canonicalKindCount(): number {
  const code = read("knowledge-engine/src/canonical-kinds.ts");
  const at = code.indexOf("export const canonicalKinds");
  const list = /Object\.freeze\(\[([\s\S]*?)\]\);/.exec(code.slice(at))?.[1] ?? "";
  return list.split("\n").filter((l) => l.trim().endsWith(",")).length;
}

describe("docs.site-setup (S02): the checklist and the spec correspond", () => {
  it("the one S02 site follow-up item has a same-numbered checklist item, S33 once, one in the range", () => {
    expect(specItems(specText)).toEqual({ declared: 1, numbers: ["S33"] });
    expect(correspondenceProblems(specText, siteText)).toEqual([]);
    expect(checklist(siteText).range).toEqual([33, 33]);
  });

  it("fails when the S33 line is removed from the site text", () => {
    const mutated = siteText.replace(/^- \[ \] \*\*S33 .*$/m, "");
    expect(correspondenceProblems(specText, mutated)).toContain(
      "site-setup: S33 appears 0 times, expected 1",
    );
  });
});

describe("docs.site-setup (S02): S33 and ARCHITECTURE name what exists", () => {
  it("S33 names the runner subcommand, the setting and its RUNBOOK section, all present; the settings row names S33", () => {
    const s33 = item(siteText, "S33");
    expect(s33.length).toBeGreaterThan(300);
    for (const word of [
      "entity-scenario preflight|record",
      "semantic.autoDispute",
      "배포처 후속",
      "RUNBOOK",
      "이슈 #23",
    ]) {
      expect(s33, word).toContain(word);
    }
    expect(read("verification/v02-site-flow/run.py")).toContain('sub.add_parser("entity-scenario")');
    expect(read("knowledge-engine/src/conflicts.ts")).toContain(
      'export const AUTO_DISPUTE_SETTING = "semantic.autoDispute";',
    );
    expect(read("verification/v02-site-flow/RUNBOOK.md")).toContain("## 11. 개체 해소 실측 (S33");
    const row = siteText.split("\n").find((l) => l.startsWith("| `semantic.autoDispute`"));
    expect(row).toContain("S33");
  });

  it("ARCHITECTURE names the three kinds, that paths are not stored, and the kind count the code registers", () => {
    for (const kind of ["`entity-merge`", "`merge-candidate`", "`assertion-link`"]) {
      expect(archText, kind).toContain(kind);
    }
    expect(archText).toContain("경로와 사슬은 읽을 때 계산하고 저장하지 않는다");
    expect(canonicalKindCount()).toBeGreaterThan(8);
    expect(archText).toContain(`정본 종류는 ${canonicalKindCount()}개`);
  });
});
