// I01-H1 `docs.site-setup` (I01-R30): the S18 item of the I01 spec has a same-numbered item
// under `## 배포처 설정 체크리스트` exactly once, the checklist's declared I01 range (S18) holds
// exactly that many items, and what S08 and S18 name (files, constants, log codes, the config
// file, the SQL column) still exists in the repository: a renamed constant or a removed path
// turns this red. A separate file from the other specs' site-setup tests so they do not touch
// the same file. Whole identifiers only: `SCOPE_CLASSES` is not found inside `SCOPE_CLASSES_X`.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const docsDir = resolve(repoRoot, "docs");
const specText = readFileSync(resolve(docsDir, "specs/2026-11-21-I01-connector-sdk.md"), "utf8");
const siteText = readFileSync(resolve(docsDir, "site-setup.md"), "utf8");

/** Files the items name that belong to the deployment fork: the public repository has none of them. */
const FORK_FILES = new Set(["site/config/connector-scopes.json"]);

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
  // `[I01](spec) S18` for one item, `S18~S19` for a range
  const range = /\[I01\]\([^)]*\) S(\d{2})(?:~S(\d{2}))?/.exec(section);
  const first = range ? Number(range[1]) : undefined;
  const last = range ? Number(range[2] ?? range[1]) : undefined;
  return { numbers, range: first === undefined ? undefined : [first, last as number] };
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
    problems.push("site-setup: checklist does not declare the I01 number range");
  } else {
    const [from, to] = c.range as [number, number];
    const owned = c.numbers.filter((x) => Number(x.slice(1)) >= from && Number(x.slice(1)) <= to);
    if (owned.length !== s.numbers.length) {
      problems.push(
        `count mismatch: spec has ${s.numbers.length}, checklist I01 range has ${owned.length}`,
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

/** File paths a text names in backticks (`dir/file.ext`) or in a relative link target. */
function namedPaths(text: string): string[] {
  const ext = "(?:ts|tsx|py|md|json)";
  const ticked = [
    ...text.matchAll(new RegExp("`([A-Za-z0-9_./-]+/[A-Za-z0-9_.-]+\\." + ext + ")`", "g")),
  ];
  const linked = [
    ...text.matchAll(new RegExp("\\]\\((?!https?:)([^)#]+\\." + ext + ")(?:#[^)]*)?\\)", "g")),
  ];
  return [
    ...ticked.map((m) => m[1] as string),
    // a link target is relative to docs/
    ...linked.map((m) => resolve(docsDir, m[1] as string).slice(repoRoot.length + 1)),
  ];
}

/** True when `text` holds `token` as a whole identifier, not inside a longer one. */
function namesToken(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`).test(text);
}

/** What S08 and S18 rely on in the code, by name: the item must name it and the file must hold it. */
const NAMED_FACTS = [
  { item: "S08", token: "ScopeGrading", file: "providers/src/scope-grading.ts", holds: "export interface ScopeGrading {" },
  { item: "S08", token: "grade", file: "providers/src/scope-grading.ts", holds: "grade(scope: AccessScope): ScopeClass;" },
  { item: "S08", token: "strictest", file: "providers/src/scope-grading.ts", holds: "strictest(classes: readonly ScopeClass[]): ScopeClass;" },
  { item: "S08", token: "SCOPE_CLASSES", file: "providers/src/scope-grading.ts", holds: 'export const SCOPE_CLASSES = ["general"]' },
  { item: "S08", token: "DATA_CLASSES", file: "packages/contracts/src/provider.ts", holds: "export const DATA_CLASSES = " },
  { item: "S08", token: "asScopeClass", file: "providers/src/broker.ts", holds: "function asScopeClass(" },
  { item: "S08", token: "scope-unjudged", file: "providers/src/broker.ts", holds: '| "scope-unjudged"' },
  { item: "S08", token: "publicScopeGrading", file: "providers/src/scope-grading.ts", holds: "export const publicScopeGrading" },
  { item: "S08", token: "productCalls", file: "backend/src/composition.ts", holds: "export function productCalls(" },
  { item: "S08", token: "productCalls", file: "backend/src/composition.ts", holds: "options.siteScopeGrading ??" },
  { item: "S08", token: "SiteRegistration", file: "backend/src/site-registration.ts", holds: "export interface SiteRegistration {" },
  { item: "S08", token: "scopeGrading", file: "backend/src/site-registration.ts", holds: "readonly scopeGrading?: ScopeGrading;" },
  { item: "S08", token: "checkSiteRegistration", file: "backend/src/site-registration.ts", holds: "export function checkSiteRegistration(" },
  { item: "S08", token: "scope-grading-invalid", file: "backend/src/site-registration.ts", holds: '| "scope-grading-invalid"' },
  { item: "S18", token: "configured_scope", file: "storage/src/migrations.ts", holds: "ADD COLUMN configured_scope TEXT" },
  { item: "S18", token: "connector_instances", file: "storage/src/migrations.ts", holds: "CREATE TABLE connector_instances (" },
  { item: "S18", token: "connector-scopes-absent", file: "backend/src/connector-scopes.ts", holds: '"absent"' },
  { item: "S18", token: "connector-scopes-invalid", file: "backend/src/connector-scopes.ts", holds: '"invalid"' },
  { item: "S18", token: "connector-scopes-empty", file: "backend/src/connector-scopes.ts", holds: '"empty"' },
  { item: "S18", token: "connector-scopes-bound", file: "backend/src/connector-scopes.ts", holds: '"bound"' },
  { item: "S18", token: "connector-scopes-rejected", file: "backend/src/boot.ts", holds: 'log("connector-scopes-rejected"' },
  { item: "S18", token: "connectorContract", file: "packages/testkit/src/connector.contract.ts", holds: "export function connectorContract(" },
  { item: "S18", token: "ConnectorRateLimitError", file: "packages/contracts/src/connector.ts", holds: "export class ConnectorRateLimitError" },
  { item: "S18", token: "retryAfterMs", file: "packages/contracts/src/index.ts", holds: "retryAfterMs: z.number().nonnegative().optional()" },
  { item: "S18", token: "cursorExpired", file: "packages/contracts/src/connector.ts", holds: "cursorExpired: z.boolean().optional()" },
  { item: "S18", token: "rescanned", file: "packages/contracts/src/index.ts", holds: "rescanned: z.boolean()," },
  { item: "S18", token: "deletionsMayBeMissed", file: "packages/contracts/src/index.ts", holds: "deletionsMayBeMissed: z.boolean()," },
  { item: "S18", token: "deletionsOnRescan", file: "packages/contracts/src/connector.ts", holds: "deletionsOnRescan: boolean;" },
  { item: "S18", token: "accessScope", file: "packages/contracts/src/connector.ts", holds: "const accessScope = z.array(" },
  { item: "S18", token: "revision", file: "packages/contracts/src/connector.ts", holds: "const revision = z.int().min(1);" },
  { item: "S18", token: "maxPages", file: "packages/testkit/src/connector.contract.ts", holds: "maxPages?: number;" },
  { item: "S18", token: "DEFAULT_RUN_TIMEOUT_MS", file: "backend/src/job-outcomes.ts", holds: "export const DEFAULT_RUN_TIMEOUT_MS = 10 * 60_000;" },
  { item: "S18", token: "scope_claimed", file: "storage/src/sources.ts", holds: "s.scope_claimed" },
] as const;

describe("docs.site-setup (I01)", () => {
  it("each I01 site follow-up item has a same-numbered checklist item", () => {
    expect(specItems(specText).numbers).toEqual(["S18"]);
    expect(correspondenceProblems(specText, siteText)).toEqual([]);
  });

  it("S18 appears under the checklist heading exactly once", () => {
    const numbers = checklistItems(siteText).numbers.filter((n) => n === "S18");
    expect(numbers).toEqual(["S18"]);
  });

  it("fails when the checklist item is missing", () => {
    const mutated = siteText.replace(/^- \[ \] \*\*S18 .*$/m, "");
    expect(correspondenceProblems(specText, mutated)).toContain(
      "site-setup: S18 appears 0 times, expected 1",
    );
  });

  it("fails when S18 is written twice", () => {
    const mutated = siteText.replace("**S21 ", "**S18 ");
    expect(correspondenceProblems(specText, mutated)).toContain(
      "site-setup: S18 appears 2 times, expected 1",
    );
  });

  it("fails when the spec table and its declared count disagree", () => {
    const mutated = specText.replace(/^\| S18 \|.*\n/m, "");
    expect(correspondenceProblems(mutated, siteText)).toContain(
      "spec: declares 1 items but the table has 0",
    );
  });

  it("fails when the checklist's I01 range holds a different number of items", () => {
    const mutated = siteText.replace(/(\[I01\]\([^)]*\) )S18/, "$1S17~S18");
    expect(correspondenceProblems(specText, mutated)).toContain(
      "count mismatch: spec has 1, checklist I01 range has 2",
    );
  });

  it("fails when the I01 range statement is dropped", () => {
    const mutated = siteText.replace(/\[I01\]\([^)]*\) S18/, "I01");
    expect(correspondenceProblems(specText, mutated)).toContain(
      "site-setup: checklist does not declare the I01 number range",
    );
  });

  it("fails when the checklist heading is renamed", () => {
    const mutated = siteText.replace(CHECKLIST_HEADING, "## 체크리스트");
    expect(correspondenceProblems(specText, mutated).length).toBeGreaterThan(0);
  });
});

describe("docs.site-setup (I01): what S08 and S18 name exists", () => {
  const s08 = itemText(siteText, "S08");
  const s18 = itemText(siteText, "S18");

  it("finds both items", () => {
    expect(s08.length).toBeGreaterThan(200);
    expect(s18.length).toBeGreaterThan(200);
  });

  it("S08 states the scope-grading rule in its words, not only by name", () => {
    expect(s08).toContain("`strictest([])`");
    expect(s08).toContain("`grade(null)`");
    expect(s08).toContain("`synthetic`");
    expect(s08).toContain("`scope-unjudged`");
  });

  it("S18 states the file's format and that the registration binds it at build time (I07-R14: the installed-build gap sentence is gone)", () => {
    expect(s18).toContain('{ "<인스턴스 ID>": ["범위", ...] | null }');
    expect(s18).toContain("설치본");
    expect(s18).toContain("포크의 등록이 빌드할 때 묶는다");
    expect(s18).not.toContain("설치본에서 이 파일을 읽는 길은 만들지 않았다");
  });

  it("every file path S08 and S18 name exists in the repository", () => {
    const paths = [...namedPaths(s08), ...namedPaths(s18)];
    expect(paths.length).toBeGreaterThanOrEqual(5);
    const missing = paths.filter((p) => !FORK_FILES.has(p) && !existsSync(resolve(repoRoot, p)));
    expect(missing).toEqual([]);
  });

  it.each(NAMED_FACTS)("$item names $token and $file holds it", (fact) => {
    expect(namesToken(fact.item === "S08" ? s08 : s18, fact.token)).toBe(true);
    expect(readFileSync(resolve(repoRoot, fact.file), "utf8")).toContain(fact.holds);
  });

  it("S08's list of places to change names each one the code names", () => {
    for (const path of [
      "packages/contracts/src/provider.ts",
      "providers/src/scope-grading.ts",
      "providers/src/broker.ts",
      "providers/src/egress-policy.ts",
      "providers/src/execution-gate.ts",
      "backend/src/composition.ts",
      "backend/src/site-registration.ts",
    ]) {
      expect(s08).toContain(`\`${path}\``);
      expect(existsSync(resolve(repoRoot, path))).toBe(true);
    }
  });

  it("a token is matched as a whole identifier, never inside a longer one", () => {
    expect(namesToken("`SCOPE_CLASSES_X` only", "SCOPE_CLASSES")).toBe(false);
    expect(namesToken("`SCOPE_CLASSES`", "SCOPE_CLASSES")).toBe(true);
    expect(namesToken("`connector-scopes-absent`", "connector-scopes")).toBe(false);
    expect(namesToken("`grade(null)`", "grade")).toBe(true);
    expect(namesToken("`upgrade`", "grade")).toBe(false);
  });

  it("fails when a named constant is renamed in every place S08 writes it", () => {
    const mutated = s08.replaceAll(/(?<![A-Za-z0-9_])SCOPE_CLASSES(?![A-Za-z0-9_])/g, "SCOPE_SET");
    expect(s08).toContain("SCOPE_CLASSES");
    expect(namesToken(mutated, "SCOPE_CLASSES")).toBe(false);
  });

  it("fails when a log code S18 names is renamed in every place", () => {
    const mutated = s18.replaceAll("connector-scopes-absent", "connector-scopes-missing");
    expect(namesToken(mutated, "connector-scopes-absent")).toBe(false);
  });

  it("fails when a file the items name does not exist", () => {
    expect(s18).toContain("`providers/src/log.ts`");
    const mutated = s18.replace("providers/src/log.ts", "providers/src/no-such-log.ts");
    const missing = namedPaths(mutated).filter(
      (p) => !FORK_FILES.has(p) && !existsSync(resolve(repoRoot, p)),
    );
    expect(missing).toEqual(["providers/src/no-such-log.ts"]);
  });
});

describe("docs.site-setup (I01): what S18 says is not built stays true", () => {
  it("the log codes S18 names are the ones the code writes, and the retired one is gone (I07-R4)", () => {
    const s18 = itemText(siteText, "S18");
    expect(s18).not.toContain("connector-scopes-unreadable");
    const boot = readFileSync(resolve(repoRoot, "backend/src/boot.ts"), "utf8");
    expect(boot).toContain("`connector-scopes-${state}`");
    expect(readFileSync(resolve(repoRoot, "backend/src/connector-scopes.ts"), "utf8")).not.toContain(
      "unreadable",
    );
  });

  it("S18's page-cap figure is the contract suite's constant", () => {
    expect(itemText(siteText, "S18")).toContain("`maxPages`(기본 10,000쪽)");
    expect(readFileSync(resolve(repoRoot, "packages/testkit/src/connector.contract.ts"), "utf8")).toContain(
      "const PAGE_CAP = 10_000;",
    );
  });

  it("S18 no longer names the tracked gap (#115) and points to S31; the check's caveats moved to S31 (I07-R14)", () => {
    const s18 = itemText(siteText, "S18");
    expect(s18).not.toContain("#115");
    expect(s18).toContain("S31");
    // the check on an installed build reads the canonical database, not the log, so the old log caveat ("거짓 통과") is not carried over
    const s31 = itemText(siteText, "S31");
    expect(s31).toContain("모두 `null`");
    expect(s31).toContain("정렬");
  });

  it("S08 separates collector sources (grade(null)) from claimed ones (strictest([]))", () => {
    const s08 = itemText(siteText, "S08");
    expect(s08).toContain("`grade(null)`로 등급을 매긴다");
    expect(s08).toContain("가져온(청구한) 원본");
  });

  it("the desktop build judges the scopes file and copies none (I07-R7, R9): the place is named in the judgment, never as a file the build writes", () => {
    const build = readFileSync(resolve(repoRoot, "apps/desktop/build/build.ts"), "utf8");
    const judgment = readFileSync(resolve(repoRoot, "apps/desktop/build/scopes-check.ts"), "utf8");
    // the build calls the judgment and stops on its failure; the paths live in the judgment alone
    expect(build).toContain("requireConnectorScopes(");
    expect(build).not.toContain("connector-scopes");
    expect(build).not.toContain("site/config");
    expect(judgment).toContain("site/config/${FILE_NAME}");
    // no step of the build copies the file into the app folder
    expect(build).not.toMatch(/cpSync\([^)]*scopes/);
  });
});
