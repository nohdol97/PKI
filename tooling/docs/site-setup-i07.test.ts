// I07-H1 and I07-C16 `docs.site-setup` (I07): every site follow-up item of the I07 spec has a same-numbered item
// under `## 배포처 설정 체크리스트`, and the checklist's declared I07 range (S30~S31) holds exactly that many items.
// The items' own sentences are held (S30, S31), so are the sentences S18 and the "built at build time" table carry
// about the scopes file, and what they name in the code still exists. A separate file from the other site-setup
// tests so the specs' tests do not touch the same file.
// I07-T05 owns the flip of one guard here: S31 says `scopes-check` is not in the repository yet, and the test
// "S31 says the runner's command is not written yet" reads the verification folder. When I07-T05 lands the
// runner, that sentence is stale and the test turns red: replace the sentence and the guard together.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const docsDir = resolve(repoRoot, "docs");
const specText = readFileSync(resolve(docsDir, "specs/2026-11-22-I07-installed-scopes-file.md"), "utf8");
const siteText = readFileSync(resolve(docsDir, "site-setup.md"), "utf8");
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
  const range = /\[I07\]\([^)]*\) S(\d{2})~S(\d{2})/.exec(section);
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
    problems.push("site-setup: checklist does not declare the I07 number range");
  } else {
    const [from, to] = c.range as [number, number];
    const owned = c.numbers.filter((x) => Number(x.slice(1)) >= from && Number(x.slice(1)) <= to);
    if (owned.length !== s.numbers.length) {
      problems.push(
        `count mismatch: spec has ${s.numbers.length}, checklist I07 range has ${owned.length}`,
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

/** Every file under `dir` (relative to the repository root) whose text holds `needle`. */
function filesHolding(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(resolve(repoRoot, rel), { withFileTypes: true })) {
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "__pycache__") walk(path);
      } else if (/\.(py|md|json|toml|txt)$/.test(entry.name) && read(path).includes(needle)) {
        hits.push(path);
      }
    }
  };
  walk(dir);
  return hits;
}

describe("docs.site-setup (I07): the checklist and the spec correspond", () => {
  it("each I07 site follow-up item has a same-numbered checklist item, S30 and S31 once each, two in the range", () => {
    expect(specItems(specText).numbers).toEqual(["S30", "S31"]);
    expect(correspondenceProblems(specText, siteText)).toEqual([]);
    expect(checklist(siteText).range).toEqual([30, 31]);
  });

  it("fails when a checklist item is missing", () => {
    const mutated = siteText.replace(/^- \[ \] \*\*S31 .*$/m, "");
    expect(correspondenceProblems(specText, mutated)).toContain(
      "site-setup: S31 appears 0 times, expected 1",
    );
  });

  it("fails when a checklist number is duplicated", () => {
    const mutated = siteText.replace("**S31 ", "**S30 ");
    const problems = correspondenceProblems(specText, mutated);
    expect(problems).toContain("site-setup: S30 appears 2 times, expected 1");
    expect(problems).toContain("site-setup: S31 appears 0 times, expected 1");
  });

  it("fails when the spec table and its declared count disagree", () => {
    const mutated = specText.replace(/^\| S31 \|.*\n/m, "");
    expect(correspondenceProblems(mutated, siteText)).toContain(
      "spec: declares 2 items but the table has 1",
    );
  });

  it("fails when the checklist's I07 range holds a different number of items", () => {
    // S27 is an item of the checklist, so widening the range to it counts one more (and more if S28~S29 are there)
    const mutated = siteText.replace("S30~S31", "S27~S31");
    expect(correspondenceProblems(specText, mutated)).toEqual([
      expect.stringMatching(/^count mismatch: spec has 2, checklist I07 range has [3-9]$/),
    ]);
  });

  it("fails when the I07 range statement is dropped", () => {
    const mutated = siteText.replace("S30~S31", "");
    expect(correspondenceProblems(specText, mutated)).toContain(
      "site-setup: checklist does not declare the I07 number range",
    );
  });

  it("fails when the checklist heading is renamed", () => {
    const mutated = siteText.replace(CHECKLIST_HEADING, "## 체크리스트");
    expect(correspondenceProblems(specText, mutated).length).toBeGreaterThan(0);
  });

  it("the section names the spec, the ADR and the chapter it follows, and the range note names the I07 spec", () => {
    const section = checklist(siteText).section;
    expect(section).toContain("### 인스턴스 범위의 묶음과 설치본 확인");
    expect(section).toContain("(specs/2026-11-22-I07-installed-scopes-file.md)");
    expect(section).toContain("[ADR 0020](adr/0020-installed-scopes-in-registration.md)");
    expect(section).toContain("[connector-sdk.md](connector-sdk.md) 7장의 \"인스턴스 범위 파일\"");
    expect(section).toContain(
      "[I07](specs/2026-11-22-I07-installed-scopes-file.md) S30~S31)",
    );
    expect(existsSync(resolve(docsDir, "adr/0020-installed-scopes-in-registration.md"))).toBe(true);
  });
});

describe("docs.site-setup (I07): S30", () => {
  const s30 = item(siteText, "S30");

  it("says what the fork fills, runs and records, and what the public repository could not show", () => {
    expect(s30.length).toBeGreaterThan(300);
    for (const sentence of [
      "**S30 포크가 인스턴스 범위 파일을 채우고 등록에 묶어 기록.**",
      "공용 저장소는 이 길을 예시 패키지와 포크 모양으로 꾸민 버리는 작업 트리에서 한 번 돌려 본 것으로만 증명했다(macOS).",
      "`site/config/connector-scopes.json`을 `{ \"<인스턴스 ID>\": [\"범위\", ...] }` 형식으로 채운다(예시의 값 `pki-example-scope`를 남기지 않는다).",
      "`import connectorScopes from \"../../config/connector-scopes.json\" with { type: \"json\" };`로 가져와 등록의 `connectorScopes`로 넘기게 한다.",
      "`pnpm --filter @pki-site/composition site-check --scopes`와 `pnpm --filter @pki/desktop build`를 실행한다.",
      "확인: `site-check --scopes`가 0으로 끝나고, 빌드가 통과하며, 빌드 보고서(`apps/desktop/dist` 폴더의 `build-report.json`)의 `connectorScopes`의 상태가 `bound`다.",
      "기록할 것: 이 세 결과(범위 값과 인스턴스 ID는 기록하지 않는다).",
    ]) {
      expect(s30, sentence).toContain(sentence);
    }
  });

  it("says a jsonl-file instance cannot be listed and what to record when no instance can be", () => {
    for (const sentence of [
      "실행 중에 만들어지는 가져오기 인스턴스(I02-B의 `jsonl-file:…`)는 ID를 미리 알 수 없어 범위 파일에 적을 수 없다.",
      "적을 수 있는 인스턴스가 하나도 없으면 범위 파일을 두지 않고 그 사실을 기록한다(이때 `site-check --scopes`는 0이 아니고 보고서는 `absent`다).",
    ]) {
      expect(s30, sentence).toContain(sentence);
    }
  });

  it("names the four codes a stopped build reports, each as the build's judgment spells it", () => {
    expect(s30).toContain(
      "빌드가 멈추면 오류의 문구가 이유를 알린다: `scopes-file-misplaced`(범위 파일이 `site/config/`가 아닌 자리에 있다), `scopes-file-unbound`(파일은 있는데 등록이 가져오지 않았다), `scopes-file-invalid`(형식이 틀렸다), `scopes-file-placeholder`(예시의 값이 그대로다).",
    );
    const judgment = read("apps/desktop/build/scopes-check.ts");
    for (const code of ["scopes-file-misplaced", "scopes-file-unbound", "scopes-file-invalid", "scopes-file-placeholder"]) {
      expect(judgment, code).toContain(`| "${code}"`);
    }
  });

  it("what it runs and reads exists: the --scopes argument, the report file and field, the `bound` state, the fork's script", () => {
    expect(read("backend/src/site-check-main.ts")).toContain('const SCOPES_ARG = "--scopes";');
    const paths = read("apps/desktop/build/paths.ts");
    expect(paths).toContain('export const REPORT_FILE = join(DIST_DIR, "build-report.json");');
    expect(paths).toContain('const DIST_DIR = resolve(import.meta.dirname, "../dist");');
    expect(paths).toContain("connectorScopes: ScopesReport;");
    expect(read("apps/desktop/build/scopes-check.ts")).toContain('state: "absent" | "empty" | "bound";');
    expect(read("backend/src/connector-scopes.ts")).toContain('"absent" | "invalid" | "empty" | "bound"');
    expect(JSON.parse(read("packages/site-example/package.json")).scripts["site-check"]).toBeDefined();
    expect(existsSync(resolve(repoRoot, "packages/site-example/config/connector-scopes.json"))).toBe(true);
  });
});

describe("docs.site-setup (I07): S31", () => {
  const s31 = item(siteText, "S31");

  it("says what the Windows 11 build is asked, that only the canonical database is read, and what stays unverified", () => {
    expect(s31.length).toBeGreaterThan(300);
    for (const sentence of [
      "**S31 포크의 빌드를 Windows 11 설치본으로 만들어 검증 실행기의 `scopes-check`를 실행하고, 정본에 복사된 인스턴스 범위가 범위 파일의 값과 같다는 판정을 기록.**",
      "공용 저장소는 값이 등록에서 정본까지 가는 것을 예시 등록과 지어낸 값으로 한 번 확인했다(macOS).",
      "설치본에서의 실행은 하지 않았고, 설치본에서 백엔드 로그가 어디에 남는지도 확인하지 못했다. 그래서 확인은 로그가 아니라 정본을 읽는다.",
      "필요한 것: S30이 끝나 보고서가 `bound`인 포크, 설치 파일을 만드는 절차(S10)와 깨끗한 Windows 11, 범위가 있는 인스턴스를 하나 이상 적은 범위 파일.",
      "범위 파일이 이름 댄 인스턴스를 한 번 동기화하거나 가져와 그 인스턴스가 정본에 생기게 하고, 앱을 닫는다.",
    ]) {
      expect(s31, sentence).toContain(sentence);
    }
  });

  it("says how to compare by hand until the runner exists, and the three ways a comparison proves nothing", () => {
    for (const sentence of [
      "그 전에는 정본 `pki.sqlite`를 읽기 전용으로 열어 `SELECT id, configured_scope FROM connector_instances`의 값을 범위 파일의 값과 손으로 견준다.",
      "확인: 범위가 있는 인스턴스마다 정본의 `configured_scope`가 범위 파일의 값과 같다.",
      "정본에는 정렬하고 중복을 없앤 값이 저장되므로 파일의 값도 정렬해서 견준다.",
      "정본의 값이 `null`이면 읽히지 않은 것이다.",
      "파일의 항목이 모두 `null`이면 읽혔어도 `null`이라 아무것도 증명하지 못하니 범위가 있는 항목을 하나 이상 두고 보고, 인스턴스가 정본에 아직 없으면 그것도 아무것도 증명하지 못한다.",
      "이 확인이 증명하는 것은 값이 정본까지 복사되었다는 데까지이고, Broker가 그 값을 쓰는지는 공용 저장소의 시험이 본다.",
      "기록할 것: 확인한 결과(통과·실패·판정 불가)와 견준 수. 범위 값과 인스턴스 ID는 공용 이슈에 올리지 않는다.",
    ]) {
      expect(s31, sentence).toContain(sentence);
    }
    // what the hand comparison reads: the column, the table, and the sorted, de-duplicated value the product stores
    expect(read("storage/src/migrations.ts")).toContain("ALTER TABLE connector_instances ADD COLUMN configured_scope TEXT");
    expect(read("storage/src/sources.ts")).toContain("return [...new Set(scope)].sort();");
    expect(read("backend/src/connector-scopes.ts")).toContain("normalizeScope(values as string[])");
  });

  it("S31 says the runner's command is not written yet, and `scopes-check` is in no file of the verification folder", () => {
    expect(s31).toContain(
      "③ 검증 실행기의 `scopes-check`를 실행한다. 이 명령은 I07-T05가 이 항목에 적는다(`scopes-check`는 아직 저장소에 없다).",
    );
    expect(s31).toContain("판정의 이름과 결과 파일의 모양은 I07-T05가 이 항목에 더한다.");
    expect(filesHolding("verification", "scopes-check")).toEqual([]);
  });
});

describe("docs.site-setup (I07): S18 and the build-time table say the value is bound by the registration", () => {
  const s18 = item(siteText, "S18");

  it("S18 says the registration binds the file at build time and where the check on an installed build is", () => {
    for (const sentence of [
      "이 파일은 포크의 등록이 빌드할 때 묶는다(`SiteRegistration.connectorScopes`, 방법은 S30).",
      "공용 저장소는 이 파일을 갖지 않으며, 등록에 값이 없거나 그 인스턴스가 없으면 알 수 없음이라 가장 엄격한 등급이다.",
      "**설치본에서의 확인은 S31이다.**",
    ]) {
      expect(s18, sentence).toContain(sentence);
    }
  });

  it("S18 says an instance made while running cannot be listed, naming `jsonl-file:`", () => {
    expect(s18).toContain(
      "실행 중에 만들어지는 가져오기 인스턴스(I02-B의 `jsonl-file:…`)에는 범위 파일로 범위를 적을 수 없고, 그런 인스턴스는 알 수 없음(닫힌 쪽)이다.",
    );
  });

  it("S18 names the five log codes of the start, and the code writes them", () => {
    expect(s18).toContain(
      "등록에 값이 없음은 `connector-scopes-absent`, 값이 객체가 아님은 `connector-scopes-invalid`, 객체이지만 범위가 있는 항목이 하나도 없음은 `connector-scopes-empty`, 범위가 있는 항목이 하나 이상임은 `connector-scopes-bound`(그 수만 적힌다)이고, 쓰지 않은 항목이 있으면 `connector-scopes-rejected`(그 수만 적힌다)가 한 줄 더 남는다.",
    );
    const boot = read("backend/src/boot.ts");
    expect(boot).toContain("log(`connector-scopes-${state}`, { configured });");
    expect(boot).toContain('log("connector-scopes-rejected", { count: rejected });');
  });

  it("S18 no longer says the installed build has no way to read the file, names the retired code, the issue or the build resource", () => {
    expect(s18).not.toContain("설치본에서 이 파일을 읽는 길은 만들지 않았다");
    expect(s18).not.toContain("connector-scopes-unreadable");
    expect(s18).not.toContain("#115");
    expect(s18).not.toContain("빌드 자원");
    // C16 asks this of S18 only: the results section may name an issue number (e.g. I07-T05's result location)
  });

  it("the build-time table has a row for the instance scopes: the field, the file, how it gets in and the public default", () => {
    const lines = siteText.split("\n");
    const from = lines.indexOf("### 빌드할 때 정해지는 것");
    const to = lines.indexOf("### 실행 중 설정");
    const row = lines.slice(from, to).find((l) => l.startsWith("| 인스턴스 범위("));
    expect(row).toBeDefined();
    for (const sentence of [
      "| 인스턴스 범위(포크 등록 `registration`의 `connectorScopes` 필드. 값은 `site/config/connector-scopes.json`) |",
      "포크의 등록이 그 파일을 정적으로 가져와 이 필드에 넘기고, 빌드가 백엔드 묶음에 넣는다.",
      "파일은 `site/config/`에만 둔다(S30). 다시 빌드해야 바뀐다",
      "| 없음. 등록에 값이 없으면 모든 인스턴스가 알 수 없음이고 가장 엄격한 등급이다 |",
    ]) {
      expect(row, sentence).toContain(sentence);
    }
  });

  it("the S18 and S31 statements rest on code that exists: the registration field and the check's two codes", () => {
    const registration = read("backend/src/site-registration.ts");
    expect(registration).toContain("readonly connectorScopes?: unknown;");
    expect(registration).toContain('| "connector-scopes-field-invalid"');
    expect(registration).toContain('| "connector-scopes-entry-invalid"');
  });
});
