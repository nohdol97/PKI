// I02B-H1 `docs.site-setup` and I02B-C36 (I02B-R43, R45): every site follow-up item of the I02-B spec has a
// same-numbered item under `## 배포처 설정 체크리스트` and the checklist's declared range holds exactly that many;
// and the documents the spec says it changes say what the spec says (ADR 0017, ARCHITECTURE, connector-sdk.md,
// the I01, I02-A and I04 specs, site-setup S23 to S25, the README). A separate file from the other
// site-setup tests so the specs' tests do not touch the same file.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const specText = read("docs/specs/2026-11-22-I02-local-file-import.md");
const siteText = read("docs/site-setup.md");

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

function checklistSection(site: string): string | undefined {
  const all = site.split("\n");
  const start = all.indexOf(CHECKLIST_HEADING);
  if (start < 0) return undefined;
  const rest = all.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

function correspondenceProblems(spec: string, site: string): string[] {
  const problems: string[] = [];
  const s = specItems(spec);
  const section = checklistSection(site);
  if (s.numbers.length === 0) problems.push("spec: site follow-up table not found");
  if (s.declared !== s.numbers.length) {
    problems.push(`spec: declares ${s.declared} items but the table has ${s.numbers.length}`);
  }
  if (section === undefined) return [...problems, `site-setup: no ${CHECKLIST_HEADING}`];
  const numbers = [...section.matchAll(/^- \[[ x]\] \*\*(S\d{2}) /gm)].flatMap((m) => m[1] ?? []);
  for (const n of s.numbers) {
    const hits = numbers.filter((x) => x === n).length;
    if (hits !== 1) problems.push(`site-setup: ${n} appears ${hits} times, expected 1`);
  }
  const range = /\[I02-B\]\([^)]*\) S(\d{2})~S(\d{2})/.exec(section);
  if (!range) {
    problems.push("site-setup: checklist does not declare the I02-B number range");
  } else {
    const [from, to] = [Number(range[1]), Number(range[2])];
    const owned = numbers.filter((x) => Number(x.slice(1)) >= from && Number(x.slice(1)) <= to);
    if (owned.length !== s.numbers.length) {
      problems.push(
        `count mismatch: spec has ${s.numbers.length}, checklist I02-B range has ${owned.length}`,
      );
    }
  }
  return problems;
}

describe("docs.site-setup (I02B-H1)", () => {
  it("each I02-B site follow-up item has a same-numbered checklist item and the declared range holds three", () => {
    expect(specItems(specText).numbers).toEqual(["S23", "S24", "S25"]);
    expect(correspondenceProblems(specText, siteText)).toEqual([]);
  });

  it("fails when a checklist item is missing or the range statement is dropped", () => {
    expect(correspondenceProblems(specText, siteText.replace(/^- \[ \] \*\*S25 .*$/m, ""))).toContain(
      "site-setup: S25 appears 0 times, expected 1",
    );
    expect(correspondenceProblems(specText, siteText.replace("S23~S25", ""))).toContain(
      "site-setup: checklist does not declare the I02-B number range",
    );
  });
});

/** Sentences of a text: a table row is one unit, any other line is split after a full stop. */
function units(text: string): string[] {
  return text.split("\n").flatMap((line) => (line.startsWith("|") ? [line] : line.split(/(?<=[.。])\s+/)));
}

describe("docs (I02B-C36, I02B-R43, R45)", () => {
  const sdk = read("docs/connector-sdk.md");

  it("connector-sdk.md no longer says the product has no way to make a file instance, and links this spec from chapter 9", () => {
    expect(sdk.split("\n").some((l) => l.startsWith("### 열린 항목: 파일 인스턴스의 설정과 경로의 제한"))).toBe(false);
    expect(units(sdk).filter((u) => u.includes("파일 인스턴스") && u.includes("없다"))).toEqual([]);
    const nine = sdk.slice(sdk.indexOf("## 9. "), sdk.indexOf("## 10. "));
    expect(nine).toContain("](specs/2026-11-22-I02-local-file-import.md)");
  });

  it("the sentence check is not vacuous: it would find the old sentence", () => {
    expect(units("제품에는 파일 인스턴스를 만들 길이 없다. 다른 문장이다.").filter((u) => u.includes("파일 인스턴스") && u.includes("없다"))).toHaveLength(1);
  });

  it("ARCHITECTURE's source-file row says no copy is kept and links ADR 0017; the index lists the ADR, which has its four decisions", () => {
    const row = read("docs/ARCHITECTURE.md").split("\n").find((l) => l.startsWith("| 원본 파일과 첨부")) as string;
    expect(row).toContain("사본을 두지 않는다");
    expect(row).toContain("adr/0017-");
    expect(read("docs/README.md")).toContain("adr/0017-");
    expect(read("docs/adr/README.md")).toContain("(0017-");
    const adr = read("docs/adr/0017-local-files-in-place.md");
    const decisions = adr.slice(adr.indexOf("## 결정"), adr.indexOf("## 기각한 대안"));
    expect([...decisions.matchAll(/^\d\. \*\*/gm)]).toHaveLength(4);
    for (const word of ["사본을 두지 않는다", "원본 정체", "호스트 프로세스", "닫는 쪽"]) expect(decisions).toContain(word);
  });

  it("site-setup: S23 names each of W1 to W12 once, S01 carries the attachment sentence, the local-files settings table is there", () => {
    const s23 = siteText.split("\n").find((l) => l.startsWith("- [ ] **S23 ")) as string;
    for (let n = 1; n <= 12; n++) expect(s23.match(new RegExp(`\\bW${n}\\b`, "g")), `W${n}`).toHaveLength(1);
    const s01 = siteText.split("\n").find((l) => l.startsWith("- [ ] **S01 ")) as string;
    expect(s01).toContain("첨부");
    expect(siteText).toContain("#### 로컬 자료 한도(`localFiles.*`)");
  });

  it("R45: no document states Windows behaviour as verified: S23 says so and the ADR names it unconfirmed", () => {
    const s23 = siteText.split("\n").find((l) => l.startsWith("- [ ] **S23 ")) as string;
    expect(s23).toContain("확인된 것으로 적지 않는다");
    expect(read("docs/adr/0017-local-files-in-place.md")).toContain("확인하지 못했다");
  });

  it("the I04 spec names the three tables, the I02-A spec points at the I02-B numbers, and the I01 table has five results", () => {
    const i04 = read("docs/specs/2026-11-21-I04-invalidation.md");
    const r3 = i04.split("\n").find((l) => l.startsWith("- **I04-R3 ")) as string;
    const body = i04.slice(i04.indexOf(r3), i04.indexOf("- **I04-R4"));
    for (const name of ["local_file_entries", "local_locations", "local_index_seq"]) expect(body).toContain(name);
    const i02a = read("docs/specs/2026-11-21-I02-document-normalization.md");
    for (const ref of ["I02B-R26~R28", "I02B-R13, R14", "I02B-R31", "I02B-R22~R25, R50", "I02B-R32~R34, R49", "I02B-R30"]) {
      expect(i02a, ref).toContain(ref);
    }
    expect(read("docs/specs/2026-11-21-I01-connector-sdk.md")).toContain("`done`, `yield` 다섯 가운데 하나");
  });

  it("the README links the I02-B spec on exactly one line", () => {
    const readme = read("README.md");
    expect(readme.split("\n").filter((l) => l.includes("docs/specs/2026-11-22-I02-local-file-import.md"))).toHaveLength(1);
  });
});
