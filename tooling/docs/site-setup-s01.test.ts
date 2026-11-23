// S01-H1 `docs.site-setup` (S01): the one site follow-up item of the S01 spec (S32) has a same-numbered item under
// `## 배포처 설정 체크리스트`, and the checklist's declared S01 range (S32~S32) holds exactly that many items.
// S32's own sentences are held (what is run, what is recorded, that no text is recorded, the final-state counting),
// what it names in the code still exists, and the `semantic.autoVerify` settings row and S32 name each other. The
// ARCHITECTURE guards (S01-R24) sit here too: no ARCHITECTURE doc test exists, and the T09 sentence about linking
// must not regress. A separate file from the other site-setup tests so the specs' tests do not touch the same file.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const docsDir = resolve(repoRoot, "docs");
const specText = readFileSync(resolve(docsDir, "specs/2026-11-22-S01-semantic-registry.md"), "utf8");
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
  const range = /\[S01\]\([^)]*\) S(\d{2})(?:~S(\d{2}))?/.exec(section);
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
    problems.push("site-setup: checklist does not declare the S01 number range");
  } else {
    const [from, to] = c.range as [number, number];
    const owned = c.numbers.filter((x) => Number(x.slice(1)) >= from && Number(x.slice(1)) <= to);
    if (owned.length !== s.numbers.length) {
      problems.push(
        `count mismatch: spec has ${s.numbers.length}, checklist S01 range has ${owned.length}`,
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

describe("docs.site-setup (S01): the checklist and the spec correspond", () => {
  it("the one S01 site follow-up item has a same-numbered checklist item, S32 once, one in the range", () => {
    expect(specItems(specText)).toEqual({ declared: 1, numbers: ["S32"] });
    expect(correspondenceProblems(specText, siteText)).toEqual([]);
    expect(checklist(siteText).range).toEqual([32, 32]);
  });

  it("fails when the checklist item is missing", () => {
    const mutated = siteText.replace(/^- \[ \] \*\*S32 .*$/m, "");
    expect(correspondenceProblems(specText, mutated)).toContain(
      "site-setup: S32 appears 0 times, expected 1",
    );
  });

  it("fails when the checklist number is not S32", () => {
    const mutated = siteText.replace("**S32 ", "**S31 ");
    const problems = correspondenceProblems(specText, mutated);
    expect(problems).toContain("site-setup: S32 appears 0 times, expected 1");
  });

  it("fails when the spec table and its declared count disagree", () => {
    const mutated = specText.replace(/^\| S32 \|.*\n/m, "");
    const problems = correspondenceProblems(mutated, siteText);
    expect(problems).toContain("spec: declares 1 items but the table has 0");
    expect(problems).toContain("spec: site follow-up table not found");
  });

  it("fails when the S01 range holds a different number of items", () => {
    // S31 is an item of the checklist, so widening the range to it counts one more
    const mutated = siteText.replace(/(\[S01\]\([^)]*\)) S32/, "$1 S31~S32");
    expect(correspondenceProblems(specText, mutated)).toEqual([
      "count mismatch: spec has 1, checklist S01 range has 2",
    ]);
  });

  it("fails when the S01 range statement is dropped", () => {
    const mutated = siteText.replace(/ 이어서 \[S01\]\([^)]*\) S32\./, "");
    expect(correspondenceProblems(specText, mutated)).toContain(
      "site-setup: checklist does not declare the S01 number range",
    );
  });

  it("fails when the checklist heading is renamed", () => {
    const mutated = siteText.replace(CHECKLIST_HEADING, "## 체크리스트");
    expect(correspondenceProblems(specText, mutated).length).toBeGreaterThan(0);
  });

  it("the section names the spec, ADR 0021 and the settings row, and the range note names the S01 spec", () => {
    const section = checklist(siteText).section;
    expect(section).toContain("### Semantic 등록부의 실측과 자동 승격");
    expect(section).toContain("(specs/2026-11-22-S01-semantic-registry.md)");
    expect(section).toContain("[ADR 0021](adr/0021-semantic-registry-on-existing-rows.md)");
    expect(section).toContain("이어서 [S01](specs/2026-11-22-S01-semantic-registry.md) S32.");
    expect(existsSync(resolve(docsDir, "adr/0021-semantic-registry-on-existing-rows.md"))).toBe(true);
  });

  it("the results section says where S32's result goes", () => {
    expect(siteText).toContain("S32의 결과는 이슈 #22(S01)에 남긴다.");
  });
});

describe("docs.site-setup (S01): S32", () => {
  const s32 = item(siteText, "S32");

  it("says what the public repository could not show, what the fork needs and what it runs", () => {
    expect(s32.length).toBeGreaterThan(300);
    for (const sentence of [
      "**S32 설치본과 실제 Provider로 표기·정의 추출을 실행하고, 자동 승격을 켤지 정해 기록.**",
      "공용 저장소는 표기·정의 추출과 자동 승격을 test double Provider와 합성 자료로만 시험했다(macOS).",
      "실제 Provider가 표기와 정의를 인용문 그대로 돌려주는지, 실제 자료에서 조건을 채운 승격이 얼마나 틀리는지는 확인하지 못했다.",
      "필요한 것: 설치 파일을 만드는 절차(S10)와 깨끗한 Windows 11, 실제 Provider(S05·S07), 추출할 실제 자료(S01~S04의 수집기나 문서 폴더), 저장 데이터 보호 확인(S11).",
      "① `semantic.autoVerify`를 한 번도 쓰지 않은 채로 실제 자료의 표기와 정의를 추출하고 앱을 닫은 뒤, 검증 실행기의 `semantic-scenario record --phase off`를 실행한다.",
      "② `POST /api/settings/semantic`으로 `{ \"autoVerify\": true }`를 보내 자동 승격을 켜고, 추출이나 원본 변경이 행에 닿게 한 뒤(켜도 이미 있는 행을 훑지 않는다) 정책이 올린 행을 API로 확인해 틀린 것에 이의나 기각을 낸다. 앱을 닫고 `semantic-scenario record --phase on`을 실행한다.",
      "③ 두 측정을 견주어 자동 승격을 켤지 정한다.",
    ]) {
      expect(s32, sentence).toContain(sentence);
    }
  });

  it("says the runner refuses outside a Windows installed build with a real Provider, and what it writes", () => {
    for (const sentence of [
      "이 실행기(`semantic-scenario preflight|record`, [RUNBOOK](../verification/v02-site-flow/RUNBOOK.md) 10절)를 Windows 설치본과 실제 Provider가 아닌 환경에서 실행하면 `배포처 후속`으로 시작하는 알림을 내고 0이 아닌 값(3)으로 끝난다.",
      "확인: 실행기가 0으로 끝나고 `--out`에 `semantic-counts.off.json`과 `semantic-counts.on.json`이 쓰인다. 이 파일은 측정이고 통과·실패 판정이 아니다.",
    ]) {
      expect(s32, sentence).toContain(sentence);
    }
  });

  it("says what is recorded and that no text is recorded", () => {
    for (const sentence of [
      "기록할 것: 표기(`alias.*` 종류별)와 정의의 상태별 수, 자동 승격을 켰을 때 조건을 채워 올라간 수와 그 가운데 사용자가 틀렸다고 본 수, 켤지 정한 결과.",
      "글·값·항목 이름은 기록하지 않는다.",
    ]) {
      expect(s32, sentence).toContain(sentence);
    }
  });

  it("says the counts are of the final state and what a near-identical pair means", () => {
    for (const sentence of [
      "수는 변경 이력의 줄이 아니라 지금 상태의 행을 센다(올렸다 되돌리고 다시 올린 행은 한 번이다).",
      "내용 해시가 다른 거의 같은 글 두 원본은 두 원본으로 세므로, 그 둘이 만든 승격이 틀렸는지가 이 측정이 보려는 것이다.",
    ]) {
      expect(s32, sentence).toContain(sentence);
    }
  });

  it("says turning it on is a release step", () => {
    expect(s32).toContain("켜는 것은 릴리스 단계이고 이 항목의 기록이 그 근거다([ADR 0021](adr/0021-semantic-registry-on-existing-rows.md) 결정 3).");
  });

  it("what it names exists: the subcommand, the setting key, the API path and the RUNBOOK section", () => {
    expect(read("verification/v02-site-flow/run.py")).toContain('sub.add_parser("semantic-scenario")');
    expect(read("knowledge-engine/src/auto-verify.ts")).toContain(
      'export const AUTO_VERIFY_SETTING = "semantic.autoVerify";',
    );
    expect(read("packages/contracts/src/index.ts")).toContain('path: "/api/settings/semantic"');
    expect(read("verification/v02-site-flow/RUNBOOK.md")).toContain("## 10. Semantic 실측 (S32, S01-R25)");
    expect(existsSync(resolve(repoRoot, "verification/v02-site-flow/semantic_scenario.py"))).toBe(true);
  });

  it("the settings row and S32 name each other", () => {
    const lines = siteText.split("\n");
    const row = lines.find((l) => l.startsWith("| `semantic.autoVerify` |"));
    expect(row).toBeDefined();
    expect(row).toContain("S32");
    expect(s32).toContain("`semantic.autoVerify`");
  });
});

describe("docs.architecture (S01): the sentences T10 corrected stay corrected", () => {
  it("3.2 no longer says an alias comes only from recorded names and user corrections, and names verified forms and ADR 0021", () => {
    expect(archText).not.toContain("사용자 교정에서만 온다");
    expect(archText).toContain("상태가 `verified`인 표기");
    expect(archText).toContain("(adr/0021-semantic-registry-on-existing-rows.md)");
  });

  it("4 no longer calls corrections a table that has no input screen, and names user_authored and the form kinds", () => {
    expect(archText).not.toContain("Phase 1에는 입력 화면이 없다");
    expect(archText).toContain("`user_authored`");
    expect(archText).toContain("`alias.synonym`·`alias.abbreviation`·`alias.translation`");
  });

  it("5.6 has the two paragraphs of the tasks that wrote surface forms and linked them", () => {
    expect(archText).toContain("- **표기와 정의의 추출(S01-T08, 잠정).**");
    expect(archText).toContain("- **연결 후보의 표기(S01-T09, 잠정).**");
  });
});
