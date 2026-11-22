// I06-H1 and I06-C19 `docs.site-setup` (I06): every site follow-up item of the I06 spec has a same-numbered item
// under `## 배포처 설정 체크리스트`, and the checklist's declared I06 range (S28~S29) holds exactly that many items.
// The items' own sentences are held (S28, S29), so are the "실행 중 설정" row about a Connector's credential, the
// pointer S04 carries, and the range note's order (I05, I06, I07); what the items name in the code still exists.
// A separate file from the other site-setup tests so the specs' tests do not touch the same file.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const docsDir = resolve(repoRoot, "docs");
const specText = readFileSync(resolve(docsDir, "specs/2026-11-22-I06-connector-credentials.md"), "utf8");
const siteText = readFileSync(resolve(docsDir, "site-setup.md"), "utf8");
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");

const CHECKLIST_HEADING = "## 배포처 설정 체크리스트";

/** The spec's table numbers its items `S28(잠정)`: the provisional mark may follow the number. */
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
  const numbers = table.flatMap((l) => /^\|\s*(S\d{2})(?:\(잠정\))?\s*\|/.exec(l)?.[1] ?? []);
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
  const range = /\[I06\]\([^)]*\) S(\d{2})~S(\d{2})/.exec(section);
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
    problems.push("site-setup: checklist does not declare the I06 number range");
  } else {
    const [from, to] = c.range as [number, number];
    const owned = c.numbers.filter((x) => Number(x.slice(1)) >= from && Number(x.slice(1)) <= to);
    if (owned.length !== s.numbers.length) {
      problems.push(
        `count mismatch: spec has ${s.numbers.length}, checklist I06 range has ${owned.length}`,
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

/** The runtime-settings table row whose first cell starts with `first`. */
function settingsRow(site: string, first: string): string {
  const from = site.indexOf("### 실행 중 설정");
  const to = site.indexOf("## 배포처 설정 체크리스트");
  return (
    site
      .slice(from, to)
      .split("\n")
      .find((l) => l.startsWith(`| ${first}`)) ?? ""
  );
}

describe("docs.site-setup (I06): the checklist and the spec correspond", () => {
  it("each I06 site follow-up item has a same-numbered checklist item, S28 and S29 once each, two in the range", () => {
    expect(specItems(specText)).toEqual({ declared: 2, numbers: ["S28", "S29"] });
    expect(correspondenceProblems(specText, siteText)).toEqual([]);
    expect(checklist(siteText).range).toEqual([28, 29]);
  });

  it("fails when a checklist item is missing", () => {
    const mutated = siteText.replace(/^- \[ \] \*\*S29 .*$/m, "");
    expect(correspondenceProblems(specText, mutated)).toContain("site-setup: S29 appears 0 times, expected 1");
  });

  it("fails when a checklist number is duplicated", () => {
    const mutated = siteText.replace("**S29 ", "**S28 ");
    const problems = correspondenceProblems(specText, mutated);
    expect(problems).toContain("site-setup: S28 appears 2 times, expected 1");
    expect(problems).toContain("site-setup: S29 appears 0 times, expected 1");
  });

  it("fails when the spec table and its declared count disagree", () => {
    const mutated = specText.replace(/^\| S29\(잠정\) \|.*\n/m, "");
    expect(correspondenceProblems(mutated, siteText)).toContain("spec: declares 2 items but the table has 1");
  });

  it("fails when the checklist's I06 range holds a different number of items", () => {
    // S27 is an item of the checklist, so widening the range to it counts one more (and more if S26 is there)
    const mutated = siteText.replace("S28~S29", "S27~S29");
    expect(correspondenceProblems(specText, mutated)).toEqual([
      expect.stringMatching(/^count mismatch: spec has 2, checklist I06 range has [3-9]$/),
    ]);
  });

  it("fails when the I06 range statement is dropped", () => {
    const mutated = siteText.replace("S28~S29", "");
    expect(correspondenceProblems(specText, mutated)).toContain("site-setup: checklist does not declare the I06 number range");
  });

  it("fails when the checklist heading is renamed", () => {
    const mutated = siteText.replace(CHECKLIST_HEADING, "## 체크리스트");
    expect(correspondenceProblems(specText, mutated).length).toBeGreaterThan(0);
  });
});

describe("docs.site-setup (I06): S28 and S29 say what the fork runs, records and what stays unverified", () => {
  it("S28 says what the public repository could not show, what the fork declares and runs, and the five checks", () => {
    const s28 = item(siteText, "S28");
    for (const sentence of [
      "**S28 실제 수집기의 자격 증명 칸을 선언하고 Windows 11 설치본에서 값을 넣어 동기화, 거부, 누출 없음, 저장소 불가를 실행하고 기록.**",
      "**Windows의 OS 보호(DPAPI)가 설치본에서 실제로 어떻게 동작하는지와 실제 원 시스템에서의 동작은 증명하지 못했다.** 그것을 확인하는 것이 이 항목이다.",
      "그 시스템의 시험 계정이 낸 자격 증명(실제 업무 자료로 하지 않는다)",
      "수집기가 필요한 자격 증명마다 칸 이름을 정해 포크 등록의 인스턴스 정의에 `credentials`로 선언하고, 수집기가 `initialize`의 접근자로 읽게 하며, 수집기의 계약 시험 시나리오에 `credentials`(지어낸 값)와 `rejected`(거부하는 지어낸 원 시스템)를 더해 위반 없이 통과시킨다(8장).",
      "`pnpm lint && pnpm typecheck && pnpm test`와 `pnpm --filter @pki-site/composition site-check <종류>`를 실행한다.",
      "`site-check`는 빈 설정으로 초기화하므로 칸을 읽기 전에 설정을 검사하는 수집기는 자기 설정 오류의 문구로 1로 끝나고, 읽는 것이 먼저인 수집기는 `<종류>: ok (credential-required)`와 0으로 끝난다.",
      "(가) 값을 넣으면 그 인스턴스가 `ready`가 되고 동기화된다.",
      "(나) 틀린 값을 넣으면 사유 `credential-rejected`(\"자격 증명이 거부됨\")로 멈추고 값을 고쳐 넣으면 풀린다.",
      "(다) 데이터 폴더 `%LOCALAPPDATA%\\PKI`의 모든 파일(`secrets.json`, 정본 DB와 `-wal`·`-shm`, 삭제 장부)과 설치본의 로그에 그 값이 원래 글, base64, 주소용 글(percent-encoding) 어느 모양으로도 없다.",
      "설치본에서 로그가 어디에 남는지는 확인된 적이 없으므로 로그의 위치를 먼저 확인해 기록한다.",
      "(라) Windows의 OS 보호를 쓸 수 없는 계정에서는 값이 저장되지 않고 인스턴스가 \"저장소를 쓸 수 없음\"(`credential-store-unavailable`)으로 보인다.",
      "(마) 인스턴스가 가리키는 원 시스템의 주소를 바꿀 때는 인스턴스 ID도 바꾼다는 규칙을 포크의 등록이 지키는지 본다. 주소와 ID를 함께 바꾸면 그 인스턴스는 `credential-missing`이 되고 값을 다시 넣게 된다.",
      "이 화면에서 넣는 값은 한 줄, 8192자 이하이고 여러 줄 값(PEM, JSON 키)은 받지 않는다.",
      "이 화면의 알려진 틈은 공용 저장소의 #162가 추적한다.",
      "값과 계정 정보는 기록하지 않는다.",
    ]) {
      expect(s28, sentence).toContain(sentence);
    }
  });

  it("S29 says what the contract suite cannot see, what to look for, the rejection signal, the lockout figures and the rotating token", () => {
    const s29 = item(siteText, "S29");
    for (const sentence of [
      "**S29 실제 수집기와 그 의존성이 실제 원 시스템의 응답에서도 자격 증명을 레코드, 오류 문구, 자기 로그에 남기지 않는지 확인하고, 원 시스템의 만료와 잠금 정책을 기록.**",
      "수집기가 파일이나 다른 통로로 쓴 것, 둘로 나눠 쓴 글, 16진수, `Basic` 머리말의 base64, 한 바퀴보다 늦게 도는 타이머가 쓴 글은 보지 못하고, 수집기의 의존성(HTTP 클라이언트 등)이 실제 응답에서 값을 남기는지는 알 수 없다.",
      "제품은 값을 들고 있지 않아 수집기가 돌려준 레코드를 값과 견줄 수도 없다.",
      "원 시스템이 자격 증명을 거부할 때 수집기가 `ConnectorCredentialError`를 던지는지(그 밖의 오류나 `healthCheck`의 다른 사유로 알리면 제품은 거부인지 알 수 없고 같은 값으로 한 시간마다 다시 시도한다), 일시 장애는 `ConnectorError`(`retryable: true`)로 알리는지 본다.",
      "원 시스템의 만료 주기와 계정 잠금 정책, 만료되었을 때 사용자가 값을 다시 넣는 절차를 적는다.",
      "제품은 거부된 값을 한 시간마다 다시 시도하지 않고 변경 알림에는 30초에 한 번, 앱을 켤 때 한 번 시도하므로 그 횟수가 잠금 정책 안에 드는지 본다.",
      "(회전하는 토큰)이면 수집기가 값을 되쓸 길이 없다. 그 사실을 [ownership.md 5절](ownership.md)의 방법으로 공용 저장소에 알린다.",
      "기록할 것: 결과와 원 시스템의 정책의 일반 요약(주소, 계정, 값은 적지 않는다).",
    ]) {
      expect(s29, sentence).toContain(sentence);
    }
  });

  it("what the items name in the code still exists", () => {
    const contracts = read("packages/contracts/src/index.ts");
    for (const reason of ["credential-store-unavailable", "credential-missing", "credential-rejected"]) {
      expect(contracts, reason).toContain(`"${reason}",`);
    }
    expect(read("backend/src/connectors.ts")).toContain("`${kind}: ok (credential-required)`");
    expect(read("packages/contracts/src/secrets.ts")).toContain("export const CREDENTIAL_RETRY_MIN_MS = 30_000;");
    expect(read("packages/contracts/src/secrets.ts")).toContain("z.string().min(1).max(8192)");
    expect(read("packages/contracts/src/connector.ts")).toContain("export class ConnectorCredentialError extends Error");
    // the paths and the file S22 searches are the ones S28 (다) names
    expect(item(siteText, "S22")).toContain("`%LOCALAPPDATA%\\PKI`");
  });
});

describe("docs.site-setup (I06): the settings row, S04's pointer and the range note", () => {
  it("the runtime-settings table has a row for a Connector's credential that says it is not kept in a settings file, and what happens without OS protection", () => {
    const row = settingsRow(siteText, "수집기 자격 증명(");
    expect(row).not.toBe("");
    for (const sentence of [
      "설정 파일에 두지 않으며 등록의 `config`에도 적지 않는다.",
      "앱의 출처 화면에서 입력하면 OS가 보호하는 키로 암호화되어 데이터 디렉터리의 `secrets.json`에 암호문으로만 남는다([ADR 0010](adr/0010-encryption-at-rest.md), [ADR 0019](adr/0019-connector-credentials.md)).",
      "OS 보호를 쓸 수 없으면 저장되지 않고 그 인스턴스는 `unavailable`(사유 `credential-store-unavailable`)이다.",
      "인스턴스가 가리키는 원 시스템을 바꿀 때는 인스턴스 ID도 바꾸고 값을 다시 입력한다(S28).",
      "여러 줄 값은 이 화면이 받지 않는다",
    ]) {
      expect(row, sentence).toContain(sentence);
    }
    // the row sits under the runtime settings, not under the build-time ones
    expect(siteText.indexOf(row)).toBeGreaterThan(siteText.indexOf("### 실행 중 설정"));
    expect(siteText.indexOf(row)).toBeLessThan(siteText.indexOf("## 배포처 설정 체크리스트"));
    expect(settingsRow(siteText.replace("설정 파일에 두지 않으며 등록의 `config`에도 적지 않는다.", "설정 파일에 둔다."), "수집기 자격 증명(")).not.toContain(
      "설정 파일에 두지 않으며",
    );
  });

  it("S04 points to the declaration of a slot", () => {
    expect(item(siteText, "S04")).toContain(
      "인증 방식(비밀 값이 필요하면 인스턴스 정의의 `credentials`에 칸을 선언한다. S28, [connector-sdk.md](connector-sdk.md) 8장)",
    );
  });

  it("the section names the spec, the ADR and the chapter it follows, and the range note lists I05, I06, I07 in that order", () => {
    const section = checklist(siteText).section;
    expect(section).toContain("### 수집기 자격 증명");
    expect(section).toContain("(specs/2026-11-22-I06-connector-credentials.md)");
    expect(section).toContain("[ADR 0019](adr/0019-connector-credentials.md)");
    expect(section).toContain("[connector-sdk.md](connector-sdk.md) 8장");
    const note = "[I05](specs/2026-11-22-I05-site-connector-registration.md) S26~S27, [I06](specs/2026-11-22-I06-connector-credentials.md) S28~S29, [I07](specs/2026-11-22-I07-installed-scopes-file.md) S30~S31)";
    expect(section).toContain(note);
    // S28 and S29 sit between S27 and S30
    const at = (n: string) => section.indexOf(`- [ ] **${n} `);
    expect(at("S27")).toBeLessThan(at("S28"));
    expect(at("S29")).toBeLessThan(at("S30"));
  });
});
