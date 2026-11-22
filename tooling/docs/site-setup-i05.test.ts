// I05-H1 `docs.site-setup`: every site follow-up item in the I05 spec has a same-numbered item under
// `## 배포처 설정 체크리스트`, and the checklist's declared I05 range (S26~S27) holds exactly that many items.
// The two items' own sentences are held too (I05-C19): a fork reader's checklist says what to run and what stays
// unverified. A separate file from the other site-setup tests so the specs' tests do not touch the same file.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const docsDir = resolve(import.meta.dirname, "../../docs");
const specText = readFileSync(
  resolve(docsDir, "specs/2026-11-22-I05-site-connector-registration.md"),
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

function checklist(site: string) {
  const all = site.split("\n");
  const start = all.indexOf(CHECKLIST_HEADING);
  if (start < 0) return { section: "", numbers: [] as string[], range: undefined };
  const rest = all.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  const section = (end < 0 ? rest : rest.slice(0, end)).join("\n");
  const numbers = [...section.matchAll(/^- \[[ x]\] \*\*(S\d{2}) /gm)].flatMap((m) => m[1] ?? []);
  const range = /\[I05\]\([^)]*\) S(\d{2})~S(\d{2})/.exec(section);
  return { section, numbers, range: range ? [Number(range[1]), Number(range[2])] : undefined };
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
    problems.push("site-setup: checklist does not declare the I05 number range");
  } else {
    const [from, to] = c.range as [number, number];
    const owned = c.numbers.filter((x) => Number(x.slice(1)) >= from && Number(x.slice(1)) <= to);
    if (owned.length !== s.numbers.length) {
      problems.push(
        `count mismatch: spec has ${s.numbers.length}, checklist I05 range has ${owned.length}`,
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

describe("docs.site-setup (I05)", () => {
  it("each I05 site follow-up item has a same-numbered checklist item, S26 and S27 once each, two in the range", () => {
    expect(specItems(specText).numbers).toEqual(["S26", "S27"]);
    expect(correspondenceProblems(specText, siteText)).toEqual([]);
    expect(checklist(siteText).range).toEqual([26, 27]);
  });

  it("fails when a checklist item is missing", () => {
    const mutated = siteText.replace(/^- \[ \] \*\*S27 .*$/m, "");
    expect(correspondenceProblems(specText, mutated)).toContain(
      "site-setup: S27 appears 0 times, expected 1",
    );
  });

  it("fails when a checklist number is duplicated", () => {
    const mutated = siteText.replace("**S27 ", "**S26 ");
    const problems = correspondenceProblems(specText, mutated);
    expect(problems).toContain("site-setup: S26 appears 2 times, expected 1");
    expect(problems).toContain("site-setup: S27 appears 0 times, expected 1");
  });

  it("fails when the spec table and its declared count disagree", () => {
    const mutated = specText.replace(/^\| S27 \|.*\n/m, "");
    expect(correspondenceProblems(mutated, siteText)).toContain(
      "spec: declares 2 items but the table has 1",
    );
  });

  it("fails when the checklist's I05 range holds a different number of items", () => {
    // S22 is an item of the checklist, so widening the range to it counts one more (and more if S23~S25 are there)
    const mutated = siteText.replace("S26~S27", "S22~S27");
    expect(correspondenceProblems(specText, mutated)).toEqual([
      expect.stringMatching(/^count mismatch: spec has 2, checklist I05 range has [3-9]$/),
    ]);
  });

  it("fails when the I05 range statement is dropped", () => {
    const mutated = siteText.replace("S26~S27", "");
    expect(correspondenceProblems(specText, mutated)).toContain(
      "site-setup: checklist does not declare the I05 number range",
    );
  });

  it("fails when the checklist heading is renamed", () => {
    const mutated = siteText.replace(CHECKLIST_HEADING, "## 체크리스트");
    expect(correspondenceProblems(specText, mutated).length).toBeGreaterThan(0);
  });

  it("S26 says what the fork builds, runs and records, and what the public repository could not show", () => {
    const s26 = item(siteText, "S26");
    for (const sentence of [
      "**S26 포크의 조립 패키지(`site/composition/`)를 만들고 수집기, 인스턴스, 등급 매핑, 접근 범위 정책을 등록하고 기록.**",
      "실제 수집기와 실제 의존성으로 포크가 `site/`만 더해 제품에 끼워지는지는 포크에서만 확인할 수 있다.",
      "(`connectorContract`. 문서의 절차이고 빌드가 강제하지 않는다)",
      "`pnpm install`, `pnpm lint && pnpm typecheck && pnpm test`, `pnpm --filter @pki-site/composition site-check <종류>`를 실행한다.",
      "`tsconfig.json`은 예시를 그대로 복사하지 않는다",
      "공용 변경을 한 번 받아 오고 `git status --porcelain`으로 `site/` 밖에서 달라지거나 충돌한 추적 파일을 센다.",
      "공용 테스트 파일을 고치지 않은 채 통과하고, 공용 변경을 받아 온 뒤 `site/` 밖의 충돌이 `pnpm-lock.yaml` 하나뿐이다",
      "`pnpm-workspace.yaml`의 `allowBuilds`에 더한 `false` 줄도 함께 기록한다",
      "`pnpm-lock.yaml`이 충돌하면 공용 쪽 내용을 취하고 `pnpm install`을 다시 실행한다.",
      "네이티브 모듈이나 설치 스크립트가 정말 필요한 의존성을 지원하지 않는다.",
    ]) {
      expect(s26, sentence).toContain(sentence);
    }
  });

  it("S27 says what the Windows 11 build is asked, that a hanging collector must not stop the start, and what a pass of the native check is not", () => {
    const s27 = item(siteText, "S27");
    for (const sentence of [
      "**S27 포크의 빌드를 Windows 11 설치본으로 만들어 등록한 수집기가 목록에 나오고 동기화되는지, 멈추는 수집기를 넣었을 때 앱이 제한 시간 안에 켜지는지 실행하고 기록.**",
      "빌드의 네이티브 모듈 검사는 빌드한 컴퓨터에 설치된 패키지만 보므로 그 통과는 Windows 동작의 증거가 아니다.",
      "`pnpm --filter @pki/desktop build`로 만든 설치본을 Windows 11에 설치해 켠다.",
      "수집기 목록에 `ready`로 나오고 동기화하면 합성 자료가 원본으로 저장되는지 본다.",
      "`initialize`가 비동기로 끝나지 않는 인스턴스를 하나 더 등록한 빌드로 켜서 앱이 제한 시간(`INITIALIZE_TIMEOUT_MS`, 잠정 10초) 안에 시작하고 그 인스턴스만 `unavailable`인지 본다.",
      "동기 코드로 멈추는 수집기는 이 제한이 끊지 못하므로 일부러 넣지 않고, 수집기 코드 검토로 확인한다.",
      "배포처에서 10초가 알맞은지 재서 값을 기록한다",
    ]) {
      expect(s27, sentence).toContain(sentence);
    }
  });

  it("the section names the spec and the ADR it follows, and the range note names the I05 spec", () => {
    const section = checklist(siteText).section;
    expect(section).toContain("### 포크의 조립과 설치본");
    expect(section).toContain("(specs/2026-11-22-I05-site-connector-registration.md)");
    expect(section).toContain("[ADR 0018](adr/0018-fork-registration-at-build-time.md)");
    expect(section).toContain(
      "[I05](specs/2026-11-22-I05-site-connector-registration.md) S26~S27)",
    );
  });
});
