// H03-C3: the evidence table of the 14 final scenarios (original design section 20, issue #1 "최종 시나리오 추적"),
// its checker and the document made from it. The checker reads the table and a "read file" function: it runs no
// test and uses no network (R4). A passing mock is never recorded as a real-Provider or installer result (R2, R3).

// `needsProvider` (does a step of the scenario itself call a Provider) is fixed here like the title: the table
// cannot lower it, so a Provider-calling scenario is never `verified` without a real-Provider installer result.
export const FINAL_SCENARIOS = [
  { id: "FS01", title: "설치 파일 설치", needsProvider: false },
  { id: "FS02", title: "기존 CLI 탐색", needsProvider: true },
  { id: "FS03", title: "메일/메신저/Wiki형 데이터 import", needsProvider: false },
  { id: "FS04", title: "의미 지식 추출", needsProvider: true },
  { id: "FS05", title: "출처 간 관계", needsProvider: true },
  { id: "FS06", title: "개인 Semantic 자동 구성", needsProvider: true },
  { id: "FS07", title: "Graph/Wiki 증분 갱신", needsProvider: true },
  { id: "FS08", title: "Reflection 새 관계", needsProvider: true },
  { id: "FS09", title: "다출처 Insight", needsProvider: true },
  { id: "FS10", title: "근거 있는 능동 전달", needsProvider: false },
  { id: "FS11", title: "피드백 개선", needsProvider: false },
  { id: "FS12", title: "근거 기반 자연어 답변", needsProvider: true },
  { id: "FS13", title: "원본 삭제 파생물 갱신", needsProvider: false },
  { id: "FS14", title: "재시작 작업 재개", needsProvider: false },
] as const;
const needsProviderOf = (id: string): boolean =>
  FINAL_SCENARIOS.find((f) => f.id === id)?.needsProvider ?? false;

const STATUSES = ["verified", "mock-only", "unverified"] as const;
const PROVIDERS = ["mock", "real", "none"] as const;
const ENVIRONMENTS = ["dev", "windows-installer"] as const;
const BLOCKER_KINDS = ["windows-installer", "real-provider", "site", "threshold"] as const;
const IN_REPO = ["unit", "e2e", "measure"] as const;
const SITE_URL = /^https:\/\/github\.com\/nohdol97\/PKI\/issues\/\d+#issuecomment-\d+$/;

type Obj = Record<string, unknown>;
export type ReadFile = (path: string) => string | undefined;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (list as readonly string[]).includes(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const unknownKeys = (o: Obj, allowed: string[]) =>
  Object.keys(o).filter((k) => !allowed.includes(k));

/** The path is repository-relative; the reader resolves it against the root. */
const safePath = (p: unknown): p is string =>
  nonEmpty(p) &&
  !p.startsWith("/") &&
  !p.includes("\\") &&
  !/^[a-zA-Z]:/.test(p) &&
  !p.split("/").includes("..");

// Folders vitest.config.ts does not run (its `exclude`): a unit evidence there is never run by `pnpm test`.
const UNIT_NOT_RUN = /(^|\/)(node_modules|eval|verification)\//;

/** Reading a path that is a directory (or unreadable) throws; that is a fault of the table, not a crash. */
function readOrFault(read: ReadFile, path: string): { text?: string | undefined; fault?: string } {
  try {
    return { text: read(path) };
  } catch (error) {
    return { fault: `cannot be read (${(error as Error).message})` };
  }
}

function checkEvidence(id: string, e: unknown, read: ReadFile, out: string[]): Obj | undefined {
  if (!isObj(e)) {
    out.push(`${id}: evidence entry is not an object`);
    return undefined;
  }
  if (!oneOf([...IN_REPO, "site-result"] as const, e.kind)) {
    out.push(
      `${id}: evidence kind ${JSON.stringify(e.kind)} is not unit, e2e, measure or site-result`,
    );
    return undefined;
  }
  const kind = e.kind;
  const allowed = ["kind", "provider", "environment"].concat(
    kind === "site-result" ? ["url"] : kind === "measure" ? ["path"] : ["path", "title"],
  );
  for (const k of unknownKeys(e, allowed)) out.push(`${id}: ${kind} evidence has unknown key ${k}`);
  if (!oneOf(PROVIDERS, e.provider)) out.push(`${id}: ${kind} provider must be mock, real or none`);
  if (!oneOf(ENVIRONMENTS, e.environment)) {
    out.push(`${id}: ${kind} environment must be dev or windows-installer`);
  }
  if (kind === "site-result") {
    if (typeof e.url !== "string" || !SITE_URL.test(e.url)) {
      out.push(`${id}: site-result url must be an issue-comment address of this repository`);
    }
    return e;
  }
  if (e.provider === "real") out.push(`${id}: a ${kind} evidence cannot be a real-Provider result`);
  if (e.environment === "windows-installer") {
    out.push(`${id}: a ${kind} evidence cannot be a Windows-installer result`);
  }
  const path = e.path;
  if (!safePath(path)) {
    out.push(`${id}: ${kind} path must be a repository-relative path`);
    return e;
  }
  const { text, fault } = readOrFault(read, path);
  if (fault !== undefined) {
    out.push(`${id}: ${kind} path ${path} ${fault}`);
    return e;
  }
  if (text === undefined) {
    out.push(`${id}: ${kind} path ${path} does not exist`);
    return e;
  }
  if (kind === "unit" && UNIT_NOT_RUN.test(path)) {
    out.push(`${id}: unit path ${path} is in a folder vitest does not run`);
  }
  const suffix = { unit: /\.test\.tsx?$/, e2e: /\.e2e\.ts$/, measure: /^eval\/results\/.+\.json$/ }[
    kind
  ];
  if (!suffix.test(path)) out.push(`${id}: ${kind} path ${path} does not fit the kind`);
  if (kind !== "measure") {
    if (!nonEmpty(e.title)) out.push(`${id}: ${kind} evidence needs a title`);
    else if (!text.includes(e.title)) out.push(`${id}: title "${e.title}" is not in ${path}`);
  }
  return e;
}

function checkScenario(s: unknown, read: ReadFile, out: string[]): void {
  if (!isObj(s)) {
    out.push("map: a scenario entry is not an object");
    return;
  }
  const id = nonEmpty(s.id) ? s.id : "map";
  for (const k of unknownKeys(s, ["id", "title", "owners", "status", "evidence", "blockers"])) {
    out.push(`${id}: unknown key ${k}`);
  }
  if (!Array.isArray(s.owners) || !s.owners.every(nonEmpty) || s.owners.length === 0) {
    out.push(`${id}: owners must be a list of task names`);
  }
  if (!oneOf(STATUSES, s.status))
    out.push(`${id}: status must be verified, mock-only or unverified`);
  const evidence: Obj[] = [];
  if (!Array.isArray(s.evidence)) out.push(`${id}: evidence must be a list`);
  else {
    for (const e of s.evidence) {
      const checked = checkEvidence(id, e, read, out);
      if (checked) evidence.push(checked);
    }
  }
  const blockers = Array.isArray(s.blockers) ? s.blockers : undefined;
  if (!blockers) out.push(`${id}: blockers must be a list`);
  else {
    for (const b of blockers) {
      if (!isObj(b)) {
        out.push(`${id}: blocker entry is not an object`);
        continue;
      }
      for (const k of unknownKeys(b, ["kind", "note", "procedure"]))
        out.push(`${id}: blocker has unknown key ${k}`);
      if (!oneOf(BLOCKER_KINDS, b.kind))
        out.push(`${id}: blocker kind must be windows-installer, real-provider, site or threshold`);
      if (!nonEmpty(b.note)) out.push(`${id}: blocker needs a note`);
      if (b.procedure !== undefined) {
        if (!safePath(b.procedure))
          out.push(`${id}: blocker procedure must be a repository-relative path`);
        else {
          const { text, fault } = readOrFault(read, b.procedure);
          if (fault !== undefined) out.push(`${id}: blocker procedure ${b.procedure} ${fault}`);
          else if (text === undefined)
            out.push(`${id}: blocker procedure ${b.procedure} does not exist`);
        }
      }
    }
  }
  const installer = evidence.filter(
    (e) => e.kind === "site-result" && e.environment === "windows-installer",
  );
  const meetsVerified =
    installer.length > 0 &&
    (!needsProviderOf(id) || installer.some((e) => e.provider === "real")) &&
    blockers?.length === 0;
  const inRepo = evidence.filter((e) => oneOf(IN_REPO, e.kind)).length;
  if (s.status === "verified" && !meetsVerified) {
    out.push(
      `${id}: verified needs a Windows-installer site-result (a real-Provider one when the scenario calls a Provider) and no blockers`,
    );
  }
  if (s.status === "mock-only") {
    if (inRepo === 0) out.push(`${id}: mock-only needs at least one repository evidence`);
    if (meetsVerified) out.push(`${id}: meets the verified conditions, so its status is verified`);
  }
  if (s.status === "unverified" && evidence.length > 0)
    out.push(`${id}: unverified has evidence, so it is not unverified`);
  if (s.status !== "verified" && blockers?.length === 0)
    out.push(`${id}: a scenario that is not verified needs at least one blocker`);
}

/** The faults of the table, one line each starting with the scenario id (or `map:` for the whole table). */
export function checkScenarioMap(map: unknown, read: ReadFile): string[] {
  const out: string[] = [];
  if (!isObj(map)) return ["map: the table is not an object"];
  for (const k of unknownKeys(map, ["schemaVersion", "scenarios"]))
    out.push(`map: unknown key ${k}`);
  if (map.schemaVersion !== 1) out.push("map: schemaVersion must be 1");
  if (!Array.isArray(map.scenarios)) return [...out, "map: scenarios must be a list"];
  const seen = new Map<string, number>();
  for (const s of map.scenarios) {
    if (isObj(s) && typeof s.id === "string") seen.set(s.id, (seen.get(s.id) ?? 0) + 1);
    checkScenario(s, read, out);
  }
  for (const { id, title } of FINAL_SCENARIOS) {
    const n = seen.get(id) ?? 0;
    if (n !== 1) out.push(`${id}: must appear exactly once, found ${n}`);
    const mine = map.scenarios.find((s) => isObj(s) && s.id === id);
    if (isObj(mine) && mine.title !== title) out.push(`${id}: title must be "${title}"`);
  }
  for (const id of seen.keys()) {
    if (!FINAL_SCENARIOS.some((f) => f.id === id)) out.push(`${id}: is not one of FS01-FS14`);
  }
  return out;
}

interface Scenario {
  id: string;
  title: string;
  owners: string[];
  status: string;
  evidence: Obj[];
  blockers: Obj[];
}
const scenariosOf = (map: unknown): Scenario[] => (map as { scenarios: Scenario[] }).scenarios;

/** Every open blocker as `ID kind: note`. */
export function blockerLines(map: unknown): string[] {
  return scenariosOf(map).flatMap((s) =>
    s.blockers.map((b) => `${s.id} ${String(b.kind)}: ${String(b.note)}`),
  );
}

const evidenceLine = (e: Obj) =>
  e.kind === "site-result"
    ? `${String(e.url)} (${String(e.provider)}, ${String(e.environment)})`
    : `\`${String(e.path)}\`${e.title ? ` — "${String(e.title)}"` : ""} (${String(e.kind)}, ${String(e.provider)}, ${String(e.environment)})`;

/** `docs/FINAL_SCENARIOS.md`, made from the table (R6). Never edited by hand. */
export function renderScenarioDoc(map: unknown): string {
  const list = scenariosOf(map);
  const count = (status: string) => list.filter((s) => s.status === status).length;
  const lines = [
    "# 최종 시나리오 증거 표",
    "",
    "> 이 문서는 `eval/final-scenarios.json`에서 `pnpm check:scenarios --write`로 만든다. 손으로 고치지 않는다.",
    '> **대역 통과는 실제 동작의 증거가 아니다.** 아래 "대역·개발 장비 증거"는 개발 장비에서 대역(mock)이나 Provider 없이 돈 시험이고, 설치본과 실제 Provider에서 확인된 것은 "설치본·실제 Provider 증거"뿐이다.',
    "> `provider: none`은 그 시험 자체가 Provider도 대역도 부르지 않는다는 뜻이다. 시험이 읽는 미리 채운 자료는 이전에 대역이 만들었을 수 있다.",
    "",
    `상태: 확인됨 ${count("verified")}, 대역만 ${count("mock-only")}, 증거 없음 ${count("unverified")}. 명세: [H03-C3](specs/2026-11-24-H03-C3-final-scenarios.md)`,
  ];
  for (const s of list) {
    const dev = s.evidence.filter((e) => e.kind !== "site-result");
    const site = s.evidence.filter((e) => e.kind === "site-result");
    lines.push(
      "",
      `## ${s.id} ${s.title}`,
      "",
      `- 상태: ${s.status}`,
      `- 책임 작업: ${s.owners.join(", ")}`,
      `- Provider 호출: ${needsProviderOf(s.id) ? "함" : "안 함"}`,
    );
    lines.push(
      "- 대역·개발 장비 증거:",
      ...(dev.length ? dev.map((e) => `  - ${evidenceLine(e)}`) : ["  - 없음"]),
    );
    lines.push(
      "- 설치본·실제 Provider 증거:",
      ...(site.length ? site.map((e) => `  - ${evidenceLine(e)}`) : ["  - 없음"]),
    );
    lines.push(
      "- 차단 항목:",
      ...(s.blockers.length
        ? s.blockers.map(
            (b) =>
              `  - ${String(b.kind)}: ${String(b.note)}${b.procedure ? ` ([절차](../${String(b.procedure)}))` : ""}`,
          )
        : ["  - 없음"]),
    );
  }
  return `${lines.join("\n")}\n`;
}

export interface CheckIo {
  loadMap: () => unknown;
  read: ReadFile;
  out: (line: string) => void;
  writeDoc: (text: string) => void;
}

/** `pnpm check:scenarios [--release] [--write]` (R5): 1 for a broken table, 2 for `--release` with blockers left, else 0. */
export function runScenarioCheck(args: string[], io: CheckIo): number {
  let map: unknown;
  try {
    map = io.loadMap();
  } catch (error) {
    io.out(`map: the table cannot be read: ${(error as Error).message}`);
    return 1;
  }
  const faults = checkScenarioMap(map, io.read);
  if (faults.length > 0) {
    for (const f of faults) io.out(f);
    return 1;
  }
  if (args.includes("--write")) io.writeDoc(renderScenarioDoc(map));
  const list = scenariosOf(map);
  const count = (status: string) => list.filter((s) => s.status === status).length;
  const blockers = blockerLines(map);
  io.out(
    `verified ${count("verified")}, mock-only ${count("mock-only")}, unverified ${count("unverified")}`,
  );
  io.out(`차단 항목 ${blockers.length}`);
  for (const b of blockers) io.out(`  ${b}`);
  return args.includes("--release") && blockers.length > 0 ? 2 : 0;
}
