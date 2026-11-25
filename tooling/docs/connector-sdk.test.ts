// I01-R30 `docs.connector-sdk`: docs/connector-sdk.md says what the code on main does and keeps
// saying it. Every code block is an excerpt of a tested file and appears there line for line;
// every identifier the text relies on is named as a whole identifier and still exists where the
// code defines it; every file and link it names exists; the things it says are NOT built stay
// unbuilt (the absence guards: when one is built the text is stale and this turns red); the
// chapters carry their recap; ownership.md sections 2 and 3, the README and the docs index point
// to it. The tables that must equal code constants are checked in backend/src/connector-sdk.docs.test.ts
// (the one package that may import @pki/testkit, @pki/contracts and @pki/connector-sdk by name).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const docsDir = resolve(repoRoot, "docs");
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");
/** Files the text names that belong to the deployment fork: the public repository has none of them. */
const FORK_FILES = new Set(["site/config/connector-scopes.json"]);
/** A fork's file: the one scopes file, or anything under `site/` (the fork's composition and collector packages). */
/** The fork's import specifier of the scopes file, relative to `site/composition/src/`: the fork's file, not the public tree's. */
const FORK_IMPORT_SPECIFIER = "../../config/connector-scopes.json";
/** The example's import specifier of its scopes file, relative to `packages/site-example/src/`: the I07 block checks it resolves there. */
const EXAMPLE_IMPORT_SPECIFIER = "../config/connector-scopes.json";
const isForkPath = (path: string) =>
  FORK_FILES.has(path) || path.startsWith("site/") || path === FORK_IMPORT_SPECIFIER;
/** A path the text names that is neither a fork's file nor the example's import specifier and is not in the repository. */
const isMissing = (path: string) =>
  !isForkPath(path) && path !== EXAMPLE_IMPORT_SPECIFIER && !existsSync(resolve(repoRoot, path));
const docText = read("docs/connector-sdk.md");
const ownership = read("docs/ownership.md");
const readme = read("README.md");
const docsIndex = read("docs/README.md");

/** A fenced block and the file its marker names. */
interface Excerpt {
  file: string;
  lines: string[];
}

function excerpts(text: string): { found: Excerpt[]; unmarked: string[] } {
  const lines = text.split("\n");
  const found: Excerpt[] = [];
  const unmarked: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const fence = /^```(\w*)$/.exec(lines[i] as string);
    if (!fence) continue;
    const end = lines.findIndex((l, j) => j > i && l === "```");
    const body = lines.slice(i + 1, end);
    const marker = /^<!-- excerpt: (\S+) -->$/.exec(lines[i - 1] ?? "");
    if (fence[1] === "ts") {
      if (marker) found.push({ file: marker[1] as string, lines: body });
      else unmarked.push(body.join("\n").slice(0, 60));
    }
    i = end;
  }
  return { found, unmarked };
}

/** True when `block` stands in `file` as consecutive lines (trailing spaces ignored). */
function appearsIn(block: string[], fileText: string): boolean {
  const have = fileText.split("\n").map((l) => l.trimEnd());
  const want = block.map((l) => l.trimEnd());
  for (let at = 0; at + want.length <= have.length; at++) {
    if (want.every((l, k) => have[at + k] === l)) return true;
  }
  return false;
}

/** Excerpts whose lines are not found in their files. */
function excerptProblems(text: string): string[] {
  const { found, unmarked } = excerpts(text);
  const problems = unmarked.map((u) => `unmarked ts block: ${u}`);
  for (const { file, lines } of found) {
    if (!existsSync(resolve(repoRoot, file))) {
      problems.push(`${file} does not exist`);
    } else if (!appearsIn(lines, read(file))) {
      problems.push(`${file}: excerpt not found: ${lines[0]?.trim()}`);
    }
  }
  return problems;
}

/** True when `text` holds `token` as a whole identifier, not inside a longer one. */
function namesToken(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`).test(text);
}

/** File paths a text names in backticks (`dir/file.ext`) or in a relative link target. */
function namedPaths(text: string, baseDir: string): string[] {
  const ext = "(?:ts|tsx|py|md|json|yaml)";
  const ticked = [
    ...text.matchAll(new RegExp("`([A-Za-z0-9_./-]+/[A-Za-z0-9_.-]+\\." + ext + ")`", "g")),
  ];
  const linked = [
    ...text.matchAll(new RegExp("\\]\\((?!https?:)([^)#]+\\." + ext + ")(?:#[^)]*)?\\)", "g")),
  ];
  return [
    ...ticked.map((m) => m[1] as string),
    ...linked.map((m) => resolve(baseDir, m[1] as string).slice(repoRoot.length + 1)),
  ];
}

/** The section of `## <n>. ...` up to the next `## `. */
function chapter(text: string, n: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${n}. `));
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join("\n");
}

/**
 * What the text relies on in the code, by name: the doc must name it (as a whole identifier) and
 * the file must hold the line that defines it.
 */
const NAMED_FACTS = [
  { token: "CONNECTOR_SDK_VERSION", file: "packages/contracts/src/connector.ts", holds: "export const CONNECTOR_SDK_VERSION = 2;" },
  { token: "ConnectorError", file: "packages/contracts/src/connector.ts", holds: "export class ConnectorError extends Error" },
  { token: "ConnectorRateLimitError", file: "packages/contracts/src/connector.ts", holds: "export class ConnectorRateLimitError extends Error" },
  { token: "ConnectorNotImplementedError", file: "packages/contracts/src/connector.ts", holds: "export class ConnectorNotImplementedError extends Error" },
  { token: "SourceRecordSchema", file: "packages/contracts/src/connector.ts", holds: "export const SourceRecordSchema = z.strictObject({" },
  { token: "ChangeSchema", file: "packages/contracts/src/connector.ts", holds: "export const ChangeSchema = z.discriminatedUnion(" },
  { token: "NativeLocatorSchema", file: "packages/contracts/src/connector.ts", holds: "export const NativeLocatorSchema = z.discriminatedUnion(" },
  { token: "blocksValid", file: "packages/contracts/src/connector.ts", holds: "export function blocksValid(" },
  { token: "rejectedPositionValid", file: "packages/contracts/src/connector.ts", holds: "export function rejectedPositionValid(" },
  { token: "REJECT_CODES", file: "packages/contracts/src/connector.ts", holds: "export const REJECT_CODES = [" },
  { token: "SYNC_STOP_CODES", file: "packages/contracts/src/index.ts", holds: "export const SYNC_STOP_CODES = [" },
  { token: "SyncResponse", file: "packages/contracts/src/index.ts", holds: "export type SyncResponse = " },
  { token: "SYNC_OUTCOMES", file: "packages/connector-sdk/src/sync-outcomes.ts", holds: "export const SYNC_OUTCOMES: readonly SyncOutcomeRow[] = [" },
  { token: "SYNC_BACKOFF", file: "backend/src/connectors.ts", holds: "export const SYNC_BACKOFF = { attempts: 3, maxWaitMs: 30_000, firstWaitMs: 1000 } as const;" },
  { token: "PAGE_LIMIT", file: "backend/src/connectors.ts", holds: "const PAGE_LIMIT = 100;" },
  { token: "REJECTED_LIST_LIMIT", file: "backend/src/page-store.ts", holds: "export const REJECTED_LIST_LIMIT = 100;" },
  { token: "tryLockInstance", file: "backend/src/instance-lock.ts", holds: "export function tryLockInstance(" },
  { token: "syncConnector", file: "backend/src/connectors.ts", holds: "export async function syncConnector(" },
  { token: "initializeConnector", file: "backend/src/connectors.ts", holds: "export async function initializeConnector(" },
  { token: "SYNC_PERIOD", file: "backend/src/connector-sync-job.ts", holds: 'export const SYNC_PERIOD: Period = { kind: "hourly" };' },
  { token: "identityKey", file: "storage/src/identity.ts", holds: "export function identityKey(" },
  { token: "checkConnector", file: "packages/testkit/src/connector.contract.ts", holds: "export async function checkConnector(" },
  { token: "connectorContract", file: "packages/testkit/src/connector.contract.ts", holds: "export function connectorContract(" },
  { token: "CONNECTOR_VIOLATION_CODES", file: "packages/testkit/src/connector.contract.ts", holds: "export const CONNECTOR_VIOLATION_CODES = [" },
  { token: "ConnectorScenario", file: "packages/testkit/src/connector.contract.ts", holds: "export interface ConnectorScenario {" },
  { token: "versionedSources", file: "packages/testkit/src/connector.contract.ts", holds: "versionedSources?: boolean;" },
  { token: "maxPages", file: "packages/testkit/src/connector.contract.ts", holds: "maxPages?: number;" },
  { token: "createExampleConnector", file: "packages/connector-example/src/adapters/example-connector.ts", holds: "export function createExampleConnector(): Connector {" },
  { token: "checkPublicOnly", file: "tooling/connectors/public-only.ts", holds: "export function checkPublicOnly(" },
  { token: "connectorKinds", file: "backend/src/composition.ts", holds: "export const connectorKinds = {" },
  { token: "connectorInstances", file: "backend/src/composition.ts", holds: "export function connectorInstances(): ConnectorInstanceConfig[] {" },
  { token: "productConnectors", file: "backend/src/composition.ts", holds: "export function productConnectors(): ConnectorSet {" },
  { token: "createSiteConnector", file: "backend/src/adapters/site-connectors.ts", holds: "export function createSiteConnector(" },
  { token: "site-check", file: "backend/package.json", holds: '"site-check": "node src/site-check.ts"' },
  { token: "parseJsonl", file: "packages/connector-sdk/src/jsonl.ts", holds: "export function parseJsonl(" },
  { token: "ImportRecordSchema", file: "packages/contracts/src/import-record.ts", holds: "export const ImportRecordSchema = z" },
  { token: "MAX_JSONL_BYTES", file: "packages/connector-sdk/src/jsonl.ts", holds: "export const MAX_JSONL_BYTES = 10 * 1024 * 1024;" },
  { token: "MAX_JSONL_LINE_CHARS", file: "packages/connector-sdk/src/jsonl.ts", holds: "export const MAX_JSONL_LINE_CHARS = 1024 * 1024;" },
  { token: "MAX_JSONL_DEPTH", file: "packages/connector-sdk/src/jsonl.ts", holds: "export const MAX_JSONL_DEPTH = 64;" },
  { token: "payload-too-large", file: "backend/src/server.ts", holds: 'reject(res, 413, "payload-too-large")' },
  { token: "POST /api/imports", file: "packages/contracts/src/index.ts", holds: 'path: "/api/imports"' },
  { token: "jsonl-import", file: "packages/connector-sdk/src/jsonl.ts", holds: 'export const JSONL_IMPORT_KIND = "jsonl-import";' },
  { token: "scope_claimed", file: "storage/src/sources.ts", holds: "s.scope_claimed" },
  { token: "deletionsOnRescan", file: "packages/connector-sdk/src/jsonl.ts", holds: "deletionsOnRescan: false," },
  { token: "scope-change", file: "packages/connector-sdk/src/jsonl.ts", holds: 'return "scope-change";' },
  { token: "access-revoked", file: "packages/connector-sdk/src/jsonl.ts", holds: 'case "access-revoked":' },
  { token: "ADR 0010", file: "docs/adr/0010-encryption-at-rest.md", holds: "safeStorage" },
  { token: "safeStorage", file: "apps/desktop/src/secret-store.ts", holds: "safeStorage" },
  { token: "RECHECK_TIMEOUT_MS", file: "backend/src/connector-sync-job.ts", holds: "export const RECHECK_TIMEOUT_MS = 60_000;" },
  { token: "POST /api/import/jsonl", file: "packages/contracts/src/index.ts", holds: 'path: "/api/import/jsonl"' },
  { token: "recheck", file: "backend/src/connectors.ts", holds: "async recheck(id, turn) {" },
  { token: "healthCheck", file: "backend/src/connectors.ts", holds: "const health = await connector.healthCheck();" },
  { token: "ChangeSet", file: "packages/contracts/src/connector.ts", holds: "export type ChangeSet = " },
  { token: "cursorExpired", file: "packages/contracts/src/connector.ts", holds: "cursorExpired: z.boolean().optional()," },
  { token: "scope-change-content-mismatch", file: "packages/contracts/src/connector.ts", holds: '"scope-change-content-mismatch",' },
  { token: "ConnectorCredentialError", file: "packages/contracts/src/connector.ts", holds: "export class ConnectorCredentialError extends Error" },
  { token: "HEALTH_REASON_CREDENTIAL_REJECTED", file: "packages/contracts/src/connector.ts", holds: 'export const HEALTH_REASON_CREDENTIAL_REJECTED = "credential-rejected";' },
  { token: "MAX_CREDENTIAL_SLOTS", file: "backend/src/connector-credentials.ts", holds: "export const MAX_CREDENTIAL_SLOTS = 8;" },
  { token: "CREDENTIAL_CHECK_TIMEOUT_MS", file: "backend/src/connector-credentials.ts", holds: "export const CREDENTIAL_CHECK_TIMEOUT_MS = 3_000;" },
  { token: "CREDENTIAL_RETRY_MIN_MS", file: "packages/contracts/src/secrets.ts", holds: "export const CREDENTIAL_RETRY_MIN_MS = 30_000;" },
  { token: "LOG_TAP_DEADLINE_MS", file: "packages/testkit/src/connector.contract.ts", holds: "const LOG_TAP_DEADLINE_MS = 4000;" },
  { token: "POST /api/connectors/credentials-changed", file: "packages/contracts/src/index.ts", holds: 'path: "/api/connectors/credentials-changed"' },
  { token: "instance-credentials-invalid", file: "backend/src/site-registration.ts", holds: '"instance-credentials-invalid"' },
  { token: "credential-unusable", file: "packages/contracts/src/index.ts", holds: '"credential-unusable",' },
  { token: "credential-rejection-unsignalled", file: "packages/testkit/src/connector.contract.ts", holds: '"credential-rejection-unsignalled",' },
] as const;

describe("docs.connector-sdk: the code blocks are the code", () => {
  const { found, unmarked } = excerpts(docText);

  it("finds the excerpts and every ts block carries its marker", () => {
    expect(found.length).toBeGreaterThanOrEqual(8);
    expect(unmarked).toEqual([]);
  });

  it("every excerpt appears line for line in the file it names", () => {
    expect(excerptProblems(docText)).toEqual([]);
  });

  it("the excerpts come from the example package, the contracts and the example's tests", () => {
    const files = new Set(found.map((f) => f.file));
    expect(files).toContain("packages/connector-example/src/adapters/example-connector.ts");
    expect(files).toContain("packages/connector-example/src/adapters/connector-example.contract.test.ts");
    expect(files).toContain("packages/connector-example/src/adapters/violating-connectors.ts");
    expect(files).toContain("packages/connector-example/src/adapters/connector-example.violations.test.ts");
    expect(files).toContain("packages/contracts/src/connector.ts");
  });

  it("fails when one line of an excerpt is changed", () => {
    const mutated = docText.replace("signal.throwIfAborted();", "signal.throwIfAbortedX();");
    expect(excerptProblems(mutated).length).toBeGreaterThan(0);
  });

  it("fails when an excerpt's marker names another file", () => {
    const mutated = docText.replace(
      /<!-- excerpt: packages\/connector-example\/src\/adapters\/violating-connectors\.ts -->/,
      "<!-- excerpt: packages/connector-example/src/adapters/example-connector.ts -->",
    );
    expect(excerptProblems(mutated).length).toBeGreaterThan(0);
  });

  it("fails when a ts block has no marker", () => {
    const mutated = docText.replace(/<!-- excerpt: packages\/contracts\/src\/connector\.ts -->\n/, "");
    expect(excerptProblems(mutated)).toEqual(expect.arrayContaining([expect.stringContaining("unmarked ts block")]));
  });

  it("fails when the file an excerpt came from changes", () => {
    const changed = read("packages/connector-example/src/adapters/example-connector.ts").replace(
      'nextCursor: `seq:${page.at(-1)?.seq ?? after}`,',
      'nextCursor: `seq:${page.at(-1)?.seq ?? after + 1}`,',
    );
    const { found: all } = excerpts(docText);
    const hit = all.filter((e) => e.file.endsWith("example-connector.ts"));
    expect(hit.some((e) => !appearsIn(e.lines, changed))).toBe(true);
  });
});

describe("docs.connector-sdk: what the text names exists in the code", () => {
  it("names every identifier of the facts table, as a whole identifier", () => {
    const missing = NAMED_FACTS.filter((f) => !namesToken(docText, f.token)).map((f) => f.token);
    expect(missing).toEqual([]);
  });

  it.each(NAMED_FACTS)("$token is held by $file", (fact) => {
    expect(read(fact.file)).toContain(fact.holds);
  });

  it("every file path the text names exists", () => {
    const paths = namedPaths(docText, docsDir);
    expect(paths.length).toBeGreaterThanOrEqual(8);
    expect(paths.filter(isMissing)).toEqual([]);
  });

  it("every relative link in the text resolves", () => {
    const links = [...docText.matchAll(/\]\((?!https?:|#)([^)#]+)(?:#[^)]*)?\)/g)].map((m) => m[1] as string);
    expect(links.length).toBeGreaterThanOrEqual(6);
    expect(links.filter((l) => !existsSync(resolve(docsDir, l)))).toEqual([]);
  });

  it("every in-page link names a heading the text has", () => {
    const anchors = [...docText.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1] as string);
    const headings = new Set(
      docText
        .split("\n")
        .filter((l) => /^#{2,3} /.test(l))
        .map((l) =>
          l
            .replace(/^#+ /, "")
            .toLowerCase()
            .replace(/[^\p{L}\p{N} -]/gu, "")
            .replaceAll(" ", "-"),
        ),
    );
    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors.filter((a) => !headings.has(a))).toEqual([]);
  });

  it("the commands it gives are commands the repository has", () => {
    expect(docText).toContain("pnpm exec vitest run packages/connector-example --reporter=verbose");
    expect(existsSync(resolve(repoRoot, "packages/connector-example"))).toBe(true);
    expect(docText).toContain("pnpm --filter @pki/backend site-check");
    expect(JSON.parse(read("backend/package.json")).scripts["site-check"]).toBeDefined();
    expect(docText).toContain("pnpm install --frozen-lockfile");
    expect(JSON.parse(read("package.json")).scripts.test).toBeDefined();
  });

  it("the example package's manifest still has the dependencies the text describes", () => {
    const manifest = JSON.parse(read("packages/connector-example/package.json"));
    expect(Object.keys(manifest.dependencies)).toEqual(["@pki/contracts"]);
    expect(Object.keys(manifest.devDependencies)).toEqual(["@pki/testkit"]);
  });

  it("the text carries no host name, URL or address", () => {
    expect(docText).not.toMatch(/https?:\/\//);
  });

  it("a token is matched as a whole identifier, never inside a longer one", () => {
    expect(namesToken("`ConnectorErrorX`", "ConnectorError")).toBe(false);
    expect(namesToken("`ConnectorError`", "ConnectorError")).toBe(true);
    expect(namesToken("`site-check-all`", "site-check")).toBe(false);
  });

  it("fails when a named identifier is renamed in every place the text writes it", () => {
    const mutated = docText.replaceAll(/(?<![A-Za-z0-9_-])SYNC_BACKOFF(?![A-Za-z0-9_-])/g, "SYNC_WAITS");
    expect(namesToken(docText, "SYNC_BACKOFF")).toBe(true);
    expect(namesToken(mutated, "SYNC_BACKOFF")).toBe(false);
  });

  it("fails when a file the text names does not exist", () => {
    const mutated = docText.replace("backend/src/composition.ts", "backend/src/gone.ts");
    const missing = namedPaths(mutated, docsDir).filter(isMissing);
    expect(docText).toContain("backend/src/composition.ts");
    expect(missing).toEqual(["backend/src/gone.ts"]);
  });
});

describe("docs.connector-sdk: what the text says is not built stays unbuilt", () => {
  // A stale-sentence detector, not a safety guard (I05-R18, C16): it catches the usual shapes of a loader of
  // anything under `site/` (the path named whole, or a quoted segment `"site"` as a separate string, near a
  // directory read, a glob or a dynamic import in one file). A loader that builds the path some other way
  // escapes it. A fixed path whose existence is checked or whose JSON is read is not a loader.
  const readsSite = (text: string) =>
    (/["'`][^"'`\n]*\bsite\/[^"'`\n]*["'`]/.test(text) || /["'`]site["'`]/.test(text)) &&
    /readdir|glob|import\(|require\(/.test(text);

  it("no product code LOADS anything from site/: no reader of that folder (chapters 7 and 11 say so)", () => {
    const roots = [
      "backend/src",
      "apps/desktop/src",
      "knowledge-engine/src",
      "storage/src",
      "providers/src",
    ];
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(resolve(repoRoot, dir), { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name) && !/\.test(-support)?\.tsx?$/.test(entry.name)) {
          if (readsSite(read(path))) hits.push(path);
        }
      }
    };
    roots.forEach(walk);
    expect(hits).toEqual([]);
  });

  it("the loader detector catches the folder named whole and built from parts, not a plain mention", () => {
    // positive: under site/ in general, not only site/connectors
    expect(readsSite('readdirSync("site/connectors")')).toBe(true);
    expect(readsSite('readdirSync("site")')).toBe(true);
    expect(readsSite('readdirSync(join(root, "site/composition"))')).toBe(true);
    expect(readsSite('readdirSync(join(root, "site", "connectors"))')).toBe(true);
    expect(readsSite('await import(join(root, "site", "composition", "src", "registration.ts"))')).toBe(true);
    expect(readsSite("await import(`${root}/site/connectors/x.ts`)")).toBe(true);
    expect(readsSite('const files = glob("site/**/*.ts");')).toBe(true);
    expect(readsSite('const m = require("../../site/composition/src/registration.ts");')).toBe(true);
    // negative: a static import, and the two fixed-path shapes the product has (backendEntry, site-check)
    expect(readsSite('import { x } from "../../site/connectors/x.ts";')).toBe(false);
    expect(readsSite('readdirSync(join(root, "docs"))')).toBe(false);
    expect(readsSite('if (!existsSync(join(root, "site/composition/package.json"))) return undefined;')).toBe(false);
    expect(
      readsSite('JSON.parse(readFileSync(join(root, "site/composition/package.json"), "utf8")).name'),
    ).toBe(false);
    expect(readsSite(read("apps/desktop/src/backend-entry.ts"))).toBe(false);
    expect(readsSite(read("backend/src/site-check-main.ts"))).toBe(false);
    expect(readsSite(read("backend/src/connector-scopes.ts"))).toBe(false);
  });

  it("the product registers no jsonl-import kind: a file instance cannot be configured (chapters 9 and 11)", () => {
    const composition = read("backend/src/composition.ts");
    const start = composition.indexOf("export const connectorKinds = {");
    const block = composition.slice(start, composition.indexOf("satisfies", start));
    expect(start).toBeGreaterThan(0);
    expect(block).not.toContain("jsonl-import");
    expect(block).not.toContain("JSONL");
  });

  it("boot waits at most INITIALIZE_TIMEOUT_MS and a failing instance leaves only itself unavailable (chapter 7)", () => {
    const code = read("backend/src/connectors.ts");
    expect(code).toContain("export const INITIALIZE_TIMEOUT_MS = 10_000;");
    expect(code).toContain("export const RECHECK_LATE_LIMIT = 3;");
    expect(code).toContain("async function makeEntry(given: ConnectorInstanceConfig): Promise<Entry> {");
    expect(code).toContain("await Promise.all(instances.map(makeEntry))");
    expect(code).toContain('log("connector-kind-unknown", { id });');
    expect(code).toContain('log("connector-initialize-timeout", { id });');
    expect(code).toContain('log("connector-factory-failed", { id });');
    expect(code).toContain('log("connector-initialize-failed", { id });');
    expect(code).toContain('log("connector-recheck-abandoned", { id: instanceId });');
    expect(code).not.toContain("unknown connector kind:");
    for (const sentence of [
      "만드는 함수를 다시 불러 새 객체를 만들고",
      "같은 설정의 다른 객체가 동시에 초기화 중일 수 있다",
      "60초를 넘겨 끝난 재점검의 결과는 성공이든 실패든 버린다",
      "`connector-initialize-failed`",
      "10초(`INITIALIZE_TIMEOUT_MS`)까지만 기다린",
    ]) {
      expect(docText).toContain(sentence);
    }
    for (const old of ["같은 수집기 객체로 다시 초기화", "제한 시간이 없다"]) {
      expect(docText).not.toContain(old);
    }
    expect(read("backend/src/connector-sync-job.ts")).toContain("export const RECHECK_TIMEOUT_MS = 60_000;");
  });

  it("no code gives a Connector a secret (chapter 8): initialize takes the config and the accessor only", () => {
    expect(read("packages/contracts/src/connector.ts")).toContain("initialize(config: unknown, context?: ConnectorContext): Promise<void>;");
    expect(read("backend/src/connectors.ts")).toContain("await connector.initialize(config, context);");
  });

  it("no product code calls getDocument, and healthCheck is called only by the hourly recheck (chapter 1)", () => {
    const calls = (needle: string) => {
      const hits: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(resolve(repoRoot, dir), { withFileTypes: true })) {
          const path = `${dir}/${entry.name}`;
          if (entry.isDirectory()) walk(path);
          else if (/\.tsx?$/.test(entry.name) && !/\.(test|e2e|test-support)\.tsx?$/.test(entry.name)) {
            if (read(path).includes(needle)) hits.push(path);
          }
        }
      };
      ["backend/src", "apps/desktop/src", "knowledge-engine/src", "storage/src", "providers/src"].forEach(walk);
      return hits;
    };
    expect(calls(".getDocument(")).toEqual([]);
    expect(calls(".healthCheck(")).toEqual(["backend/src/connectors.ts"]);
    expect(read("backend/src/connectors.ts").match(/\.healthCheck\(/g)).toHaveLength(1);
  });

  it("the file collector opens an approved location's file through the path boundary and reads a plain { path } as given (chapter 9)", () => {
    const collector = read("backend/src/adapters/jsonl-connector.ts");
    expect(collector).toContain("readLocationFile({");
    expect(collector).toContain("statSync(source.path)");
    expect(docText).toContain("### 승인한 JSONL 파일 위치(공용 저장소 #116)");
  });

  it("only the evidence screen and the question screen's cited-source view handle a locator (chapter 11, I02B-R39, X02B-R12)", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(resolve(repoRoot, dir), { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          if (read(path).includes("locator")) hits.push(path);
        }
      }
    };
    walk("apps/web/src");
    expect(hits.sort()).toEqual([
      "apps/web/src/ask.tsx",
      "apps/web/src/evidence-text.ts",
      "apps/web/src/evidence-view.tsx",
    ]);
  });
});

describe("docs.connector-sdk: shape of the text", () => {
  it("each of chapters 1 to 10 ends with its recap, and chapter 11 is the list of what is missing", () => {
    for (let n = 1; n <= 10; n++) {
      const body = chapter(docText, n);
      expect(body.length, `chapter ${n}`).toBeGreaterThan(100);
      expect(body, `chapter ${n}`).toContain("### 이 장을 줄이면");
    }
    expect(chapter(docText, 11)).toContain("| 항목 | 상태 |");
  });

  it("chapter 11 names each tracked gap by its issue number; the fork registration (#113) and the deferred ledger lines (#121) are built and are no row", () => {
    const eleven = chapter(docText, 11);
    expect(eleven).toContain("#116");
    expect(eleven).not.toContain("#162"); // closed by I06F: the gaps are fixed, one limit is stated (8장)
    // #114 is built (I06): the way to hand a Connector a credential is no row of chapter 11 any more
    expect(eleven).not.toContain("#114");
    expect(eleven).not.toContain("#121");
    // #115 is built (I07): neither the chapter 11 table nor chapter 7's list of what is missing names it
    expect(eleven).not.toContain("#115");
    expect(chapter(docText, 7)).not.toContain("#115");
    expect(eleven).not.toContain("#113");
    expect(chapter(docText, 7)).not.toContain("#113");
    expect(chapter(docText, 7)).not.toContain("#121");
  });

  it("fails when a chapter loses its recap", () => {
    const mutated = docText.replace("### 이 장을 줄이면\n\n- 수집기는", "### 요약\n\n- 수집기는");
    expect(chapter(mutated, 1)).not.toContain("### 이 장을 줄이면");
  });

  it("the text covers every content R30 names", () => {
    for (const needle of [
      "CONNECTOR_SDK_VERSION", // the specification
      "revision과 version", // the two numbers
      "upsert 하나가 판정되는 차례", // the accepting rules
      "SYNC_OUTCOMES", // the I03 result table
      "ConnectorRateLimitError", // errors and retries
      "위반 코드 표", // the violation table
      "수정 시각을 밀리초 정수로", // no integer revision
      "OS 자격 증명 저장소", // credentials
      "v1 수집기를 v2로 옮기는 법", // the migration
      "versionedSources", // the opt-in of the contract suite
    ]) {
      expect(docText, needle).toContain(needle);
    }
  });

  it("points to the ADR that holds the v1 to v2 steps, and it holds them", () => {
    expect(docText).toContain("adr/0016-connector-sdk-v2.md");
    expect(read("docs/adr/0016-connector-sdk-v2.md")).toContain("포크가 옮겨 가는 방법(v1 → v2)");
  });
});

describe("docs.connector-sdk: the places that point to it", () => {
  it("ownership.md section 2 points to it, and so does section 3", () => {
    const section = (n: number) => {
      const lines = ownership.split("\n");
      const start = lines.findIndex((l) => l.startsWith(`## ${n}. `));
      const rest = lines.slice(start + 1);
      const end = rest.findIndex((l) => l.startsWith("## "));
      return rest.slice(0, end < 0 ? undefined : end).join("\n");
    };
    expect(section(2)).toContain("(connector-sdk.md)");
    expect(section(3)).toContain("(connector-sdk.md)");
    expect(section(1)).not.toContain("(connector-sdk.md)");
  });

  it("ownership.md names what R30's table asks for: section 2 the Connector duties, section 3 the scopes file and the import check", () => {
    const lines = ownership.split("\n");
    const section = (n: number) => {
      const start = lines.findIndex((l) => l.startsWith(`## ${n}. `));
      const rest = lines.slice(start + 1);
      const end = rest.findIndex((l) => l.startsWith("## "));
      return rest.slice(0, end < 0 ? undefined : end).join("\n");
    };
    for (const word of ["scope-change", "revision", "namespace", "deletionsOnRescan", "@pki/connector-sdk"]) {
      expect(section(2), word).toContain(word);
    }
    for (const word of ["connector-scopes.json", "import 검사", "`site/`를 보지 않으므로", "현재의 예외"]) {
      expect(section(3), word).toContain(word);
    }
    // #115 is closed by I07 and #114 by I06: neither number stays in section 3 (I06-R25)
    expect(section(3)).not.toContain("#115");
    expect(section(3)).not.toContain("#114");
  });

  it("site-setup says once that its Connector specification is v2 (the lines before S01)", () => {
    const site = read("docs/site-setup.md");
    const at = site.indexOf("### 수집\n");
    const s01 = site.indexOf("- [ ] **S01 ");
    expect(at).toBeGreaterThan(0);
    expect(site.slice(at, s01)).toContain("`CONNECTOR_SDK_VERSION` = 2");
  });

  it("the README has one line that points to it", () => {
    const lines = readme.split("\n").filter((l) => l.includes("docs/connector-sdk.md"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^- /);
  });

  it("the docs index lists it", () => {
    expect(docsIndex).toContain("[connector-sdk.md](connector-sdk.md)");
  });

  it("site-setup S18 points to it", () => {
    expect(read("docs/site-setup.md")).toContain("[connector-sdk.md](connector-sdk.md)");
  });

  it("fails when ownership.md section 3 loses its pointers (every one of them)", () => {
    const [head, tail] = ownership.split("## 3.") as [string, string];
    const mutated = `${head}## 3.${tail.replaceAll("(connector-sdk.md)", "(connector-sdk-gone.md)")}`;
    expect(mutated).not.toBe(ownership);
    expect(mutated.split("## 3.")[1]).not.toContain("(connector-sdk.md)");
  });
});

// I05-C19 `docs.connector-sdk` (I05-R22, R23): chapter 7 says how a fork puts its collectors into the product, and
// each sentence a fork reader relies on is held here, either by the code it describes or as the sentence itself (a
// reverted sentence turns the test red). A test file in tooling/ cannot import the backend, so what the code holds
// is read as text. These tests hold with or without a `site/` folder: they read the example package, never `site/`.
describe("docs.connector-sdk (I05): chapter 7, the fork's way in", () => {
  const seven = chapter(docText, 7);
  const exampleDir = "packages/site-example";

  it("lists the files a fork adds, each of the composition package's that the example has too", () => {
    for (const line of [
      "├── composition/                  조립 패키지 @pki-site/composition",
      "│   ├── package.json",
      "│   ├── tsconfig.json",
      "│       ├── registration.ts       registration: SiteRegistration",
      "│       ├── registration.test.ts  checkSiteRegistration(registration)이 빈 목록",
      "│       ├── shell.ts              await runShell(registration)",
      "│       └── site-check.ts         await runSiteCheck(registration, 인자)",
      "├── connectors/<이름>/            수집기 패키지 @pki-site/connector-<이름>",
      "│   └── src/adapters/             구현과 계약 테스트",
    ]) {
      expect(seven, line).toContain(line);
    }
    for (const file of ["package.json", "tsconfig.json", "src/registration.ts", "src/registration.test.ts", "src/shell.ts", "src/site-check.ts"]) {
      expect(existsSync(resolve(repoRoot, exampleDir, file)), file).toBe(true);
    }
  });

  it("names a fork file only where the example package has the file it copies", () => {
    const forkNamed = namedPaths(seven, docsDir).filter((p) => p.startsWith("site/composition/"));
    expect(forkNamed.length).toBeGreaterThanOrEqual(3);
    for (const path of forkNamed) {
      const copy = path.replace("site/composition/", `${exampleDir}/`);
      expect(existsSync(resolve(repoRoot, copy)), `${path} is the example's ${copy}`).toBe(true);
    }
  });

  it("takes its code blocks from the example package: registration, both entries and the registration test", () => {
    const files = new Set(excerpts(seven).found.map((f) => f.file));
    for (const file of ["registration.ts", "shell.ts", "site-check.ts", "registration.test.ts"]) {
      expect(files, file).toContain(`${exampleDir}/src/${file}`);
    }
    expect(excerptProblems(seven)).toEqual([]);
  });

  it("gives the commands of I05-R21, in this order, and says the contract suite is a procedure the build does not enforce", () => {
    expect(seven).toContain(
      [
        "```sh",
        "pnpm install",
        "pnpm lint && pnpm typecheck && pnpm test",
        "pnpm --filter @pki-site/composition site-check <종류>",
        "pnpm --filter @pki-site/composition site-check --scopes",
        "pnpm --filter @pki/desktop build",
        "```",
      ].join("\n"),
    );
    expect(seven).toContain("**문서의 절차이고 빌드가 강제하지 않는다.**");
    expect(seven).toContain("`pnpm lint`는 ESLint와 `prettier --check`를 함께 돌려 `site/`의 파일도 본다.");
    expect(read("package.json")).toContain('"lint": "eslint -c eslint.config.js . && prettier --check ."');
    // the check initializes with an empty config, so a collector that needs one ends 1 with its own message
    expect(seven).toContain("`site-check`는 **빈 설정(`{}`)으로** 초기화한다.");
    expect(seven).toContain("설정을 요구하는 수집기는 자기 설정 오류의 문구로 실패하고 1로 끝난다");
    expect(read("backend/src/connectors.ts")).toContain("await initializeConnector(create(), {}, { credentials: REFUSING_CREDENTIALS });");
    expect(JSON.parse(read(`${exampleDir}/package.json`)).scripts["site-check"]).toBe("node src/site-check.ts");
    expect(JSON.parse(read("apps/desktop/package.json")).scripts.build).toBeDefined();
  });

  it("says the public site-check only points at the fork's command where a composition package exists, and the code does that", () => {
    expect(seven).toContain("조립 패키지가 있는 저장소에서 실행하면 자리표시의 결과를 내지 않고");
    expect(seven).toContain("그 패키지의 `package.json`의 `name`을 읽어 위의 포크 명령을 알린 뒤 2로 끝난다");
    const code = read("backend/src/site-check-main.ts");
    expect(code).toContain('const file = join(root, "site/composition/package.json");');
    expect(code).toContain("`pnpm --filter ${name} site-check <종류>`");
  });

  it("says which entry the build picks, with the two edges, and the code picks that way", () => {
    for (const sentence of [
      "`site/composition/package.json`이 있으면 `site/composition/src/shell.ts`를 백엔드의 진입점으로 고르고, 없으면 `backend/src/shell.ts`를 고른다",
      "`site/composition/package.json`은 있는데 `site/composition/src/shell.ts`가 없으면 그 경로를 적은 오류로 실패한다",
      "**반대로 `site/composition/src/shell.ts`만 있고 `site/composition/package.json`이 없으면 오류 없이 공용 진입점을 묶는다.**",
    ]) {
      expect(seven, sentence).toContain(sentence);
    }
    const code = read("apps/desktop/src/backend-entry.ts");
    expect(code).toContain('existsSync(join(root, "site/composition/package.json"))');
    expect(code).toContain('return join(root, "backend/src/shell.ts");');
    expect(code).toContain('join(root, "site/composition/src/shell.ts")');
    expect(code).toContain("has a package.json but no backend entry");
  });

  it("names exactly what the package entry exports, and says the boot and server functions are not exported", () => {
    const entry = read("backend/src/index.ts");
    const exported = [...entry.matchAll(/export (?:type )?\{([^}]*)\}/g)]
      .flatMap((m) => (m[1] as string).split(","))
      .map((n) => n.trim().replace(/^type /, ""))
      .filter(Boolean);
    expect(exported.length).toBeGreaterThanOrEqual(8);
    for (const name of exported) expect(namesToken(seven, name), `${name} is named`).toBe(true);
    expect(entry).not.toMatch(/bootBackend|startServer/);
    expect(seven).toContain("`bootBackend`와 서버를 띄우는 `startServer`는 내보내지 않는다.");
  });

  it("lists every registration check code, and which of them stop the start", () => {
    const code = read("backend/src/site-registration.ts");
    const union = /export type SiteRegistrationCode =([^;]*);/.exec(code)?.[1] ?? "";
    const all = [...union.matchAll(/"([a-z-]+)"/g)].map((m) => m[1] as string);
    expect(all.length).toBe(14);
    for (const name of all) expect(namesToken(seven, name), name).toBe(true);
    const stopping = [...(/const STOPPING_CODES = \[([^\]]*)\]/.exec(code)?.[1] ?? "").matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
    const rows = seven.split("\n").filter((l) => /^\| `[a-z-]+` \|/.test(l));
    const stoppingRows = rows.filter((l) => l.includes("**시작을 멈춘다**")).map((l) => /^\| `([a-z-]+)`/.exec(l)?.[1]);
    expect(stoppingRows).toEqual(stopping);
    expect(rows.length).toBe(12);
  });

  it("names the public kinds and the placeholders the registration cannot or may take, as the code lists them", () => {
    const kinds = read("backend/src/public-kinds.ts");
    expect(kinds).toMatch(
      /export const PUBLIC_CONNECTOR_KINDS: readonly string\[\] = \[\s*"jsonl-import",\s*"local-files",\s*"test-fixtures",?\s*\];/,
    );
    for (const name of ["PUBLIC_CONNECTOR_KINDS", "isPublicInstanceId", "`jsonl-import`", "`local-files`", "`test-fixtures`", "`site-mail`", "`site-messenger`", "`site-wiki`"]) {
      expect(seven, name).toContain(name);
    }
    expect(seven).toContain("**공용 종류는 등록할 수 없다**");
    expect(seven).toContain("인스턴스는 **이 등록이 등록한 종류의 것만** 만들 수 있다.");
  });

  it("gives the fork's package.json and tsconfig.json as the example's, with the one change tsconfig needs", () => {
    const blocks = [...seven.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1] as string));
    expect(blocks).toHaveLength(2);
    const manifest = JSON.parse(read(`${exampleDir}/package.json`));
    expect(blocks[0]).toEqual({ ...manifest, name: "@pki-site/composition" });
    const tsconfig = JSON.parse(read(`${exampleDir}/tsconfig.json`));
    const moved = (tsconfig.references as { path: string }[]).map((r) =>
      r.path.startsWith("../../") ? r : { path: r.path.replace("../", "../../packages/") },
    );
    // the example's `include` also lists its in-package scopes file (config/*.json); a fork's file lies outside the package
    expect(tsconfig.include).toEqual(["src", "config/*.json"]);
    expect(blocks[1]).toEqual({
      ...tsconfig,
      include: ["src"],
      references: [...moved, { path: "../connectors/<이름>" }],
    });
    // the copy is wrong exactly where the references changed: the example's own first three are siblings
    expect(tsconfig.references.some((r: { path: string }) => /^\.\.\/(?!\.)/.test(r.path))).toBe(true);
  });

  it("says the example's tsconfig.json cannot be copied as it is, and why", () => {
    for (const sentence of [
      "**`tsconfig.json`은 예시를 그대로 복사할 수 없다.**",
      "`../connector-example`처럼 가리키는데, `site/composition/`에서는 같은 패키지가 `../../packages/connector-example`이다",
      "그대로 두면 참조한 프로젝트를 찾지 못해 `pnpm typecheck`가 실패한다",
      "`site/` 아래 패키지에 `tsconfig.json`이 없으면 그 패키지 이름을 적어 실패한다",
    ]) {
      expect(seven, sentence).toContain(sentence);
    }
    expect(read("tooling/workspace/typecheck.ts")).toContain("has no tsconfig.json: add one");
  });

  it("states what the lint stops, including inline configuration, and the four ways it does not look", () => {
    for (const sentence of [
      "`backend/src`를 상대 경로, 절대 경로, `file:` 주소로 가져오거나 `@pki/backend/<하위 경로>`로 가져오는 것. 시험 파일도 마찬가지다.",
      "`site/`와 `packages/site-example/`의 파일에서는 인라인 설정(`// eslint-disable pki/module-boundary`, `/* eslint pki/module-boundary: … */`)이 효력이 없다.",
      "**린트가 보지 않는 길이 다섯 있다.** `tsconfig`의 `paths` 별칭, 심볼릭 링크, `createRequire(...)`로 부르기, 계산된 이름의 `import()`, `package.json`의 `imports`(`#이름`)다.",
      "`pnpm lint`는 저장소 루트의 `eslint.config.js` 하나만 쓴다(`eslint -c eslint.config.js`). 포크가 `site/` 아래에 둔 ESLint 설정 파일은 읽히지 않는다.",
      "**`pnpm e2e`도 포크 모양에서 통과한다(I05-T06, macOS 예행 한 번).** 공용 시험 다섯(산출물 시험 둘과 `v02-flow` 셋)은 두 모양에서 참이 되도록 고쳐졌다.",
      "일부러 해야 닿는 길이고 린트는 막지 않는다. 포크의 코드 검토가 맡는다.",
    ]) {
      expect(seven, sentence).toContain(sentence);
    }
    const config = read("eslint.config.js");
    expect(config).toContain('files: ["site/**", "packages/site-example/**"],');
    expect(config).toContain("linterOptions: { noInlineConfig: true },");
  });

  it("states what the native-module check misses, and that it depends on the machine that builds", () => {
    for (const sentence of [
      "수집기 패키지의 의존성이 네이티브 코드(패키지 폴더에 `binding.gyp`나 `prebuilds/` 폴더가 있거나 `.node` 파일이 든 것)이면 빌드가 그 패키지 이름을 적어 실패한다.",
      "**그 검사에는 빠져나가는 곳이 둘 있다.** 하나는 계산된 이름으로 네이티브 모듈을 불러오고 못 찾으면 순수 JS 코드로 내려가는 패키지다.",
      "검사가 **빌드하는 컴퓨터에 설치된 패키지만 본다**는 것이다.",
      "그래서 이 검사 통과는 Windows 설치본에서 동작한다는 증거가 아니다(site-setup S27).",
    ]) {
      expect(seven, sentence).toContain(sentence);
    }
    const code = read("apps/desktop/build/bundle.ts");
    expect(code).toContain('existsSync(join(pkg.dir, "binding.gyp"))');
    expect(code).toContain('existsSync(join(pkg.dir, "prebuilds"))');
    expect(code).toContain('export const EXTERNAL_PACKAGES = ["better-sqlite3", "@huggingface/transformers"] as const;');
  });

  it("says what the installed build refuses and keeps: no source-run switches, the registration's policy always", () => {
    for (const sentence of [
      "설치본의 백엔드는 `--scope-policy`와 `--fixtures`를 받지 않는다(받으면 시작이 실패한다).",
      "설치본을 공용 기본 정책으로 돌리는 스위치는 없다.",
      "묶음에는 등록과 그 수집기의 모듈이 들어가고, 테스트 파일과 `@pki/testkit`은 들어가지 않는다.",
    ]) {
      expect(seven, sentence).toContain(sentence);
    }
    const production = read("backend/src/shell-options.production.ts");
    expect(production).not.toContain("--fixtures");
    expect(production).toContain("origin: { type: \"string\", multiple: true, default: [] },");
  });

  it("holds the lockfile procedure: what changes, the conflict rule, the empty importer, the install-script exception", () => {
    for (const sentence of [
      "그 변경은 포크 패키지의 `importers` 항목과 그 외부 의존성뿐이다. 손으로 고치지 않는다.",
      "`pnpm-lock.yaml`이 충돌하면 **공용 쪽의 내용을 취하고** `pnpm install`을 다시 실행한다.",
      "의존성이 하나도 없는 포크 패키지는 `importers`에 빈 항목(`site/connectors/x: {}`)을 남기는데 그 패키지를 지워도 `pnpm install`이 그 항목을 지우지 않는다. 그때는 항목을 손으로 지운다.",
      "`tooling/workspace/lockfile-registry.test.ts`가 거부하고, 그 시험은 포크에서도 돈다.",
      "`pnpm install`이 `ERR_PNPM_IGNORED_BUILDS`로 실패하고, 그 실패한 실행이 `pnpm-workspace.yaml`의 `allowBuilds`에 `<패키지>: set this to true or false` 줄을 스스로 써 넣는다.",
      "포크는 그 줄을 `false`로 고친다(스크립트를 돌리지 않는다는 뜻이고, 측정한 것은 이 값뿐이다).",
      "스크립트가 정말 필요한 의존성(`true`)은 지원하지 않는다. [ownership.md 5절](ownership.md)의 방법으로 공용에 알린다.",
    ]) {
      expect(seven, sentence).toContain(sentence);
    }
    expect(existsSync(resolve(repoRoot, "tooling/workspace/lockfile-registry.test.ts"))).toBe(true);
    // both workspace lines are in the public file: a fork edits neither
    expect(read("pnpm-workspace.yaml")).toContain("  - site/composition\n  - site/connectors/*\n");
    expect(seven).toContain("`pnpm-workspace.yaml`의 `packages:` 목록에는 `site/composition`과 `site/connectors/*`가 이미 있다.");
  });

  it("states the trust boundary: not sandboxed, what the time limit cannot stop, the concurrent-initialize premise", () => {
    for (const sentence of [
      "정본 DB, 비밀 값 통로, 네트워크, 파일에 닿고 **가둬지지 않는다.**",
      "데이터 폴더에 파일을 놓아 실행본이 그것을 코드로 읽게 할 길은 없다(실행 중 로더가 없다). 설치 폴더의 파일을 바꿀 수 있는 공격자는 실행본 자체를 바꿀 수 있으므로 이 장치의 범위 밖이다.",
      "동기 멈춤은 포크의 코드 검토와 site-setup S27이, 포크 모듈을 읽는 도중의 예외는 포크의 `pnpm test`(조립 패키지의 부팅 테스트)와 S27이 맡는다.",
      "등록 검사와 시간 제한은 실수와 느린 초기화를 잡는 장치이지 격리가 아니다.",
      "막지 못하는 것: 만드는 함수나 `initialize`의 **동기 멈춤**",
      "**포크 모듈을 읽는 도중의 예외**",
      "그러므로 `initialize`는 같은 설정의 다른 객체가 동시에 초기화 중일 수 있다는 것을 전제로 쓴다. 혼자만 잡는 잠금 파일이나 포트를 쓰지 않는다.",
      "늦게 끝나 버려진 객체는 닫히지 않은 채 자원을 쥘 수 있다.",
      "60초를 넘겨 끝난 재점검이 연달아 3번이면 그 인스턴스의 재점검을 그만두고 앱을 다시 시작할 때까지 준비되지 않은 채로 둔다(`connector-recheck-abandoned`).",
    ]) {
      expect(seven, sentence).toContain(sentence);
    }
  });

  it("I04-C12 no longer warns against restoring with a build that lacks a kind: the waiting deletion is applied when the kind returns", () => {
    expect(seven).not.toContain("수집기 종류를 뺀 빌드로 백업을 복원하지 않는다");
    expect(seven).not.toContain("#121");
    expect(chapter(docText, 11)).not.toContain("수집기 종류를 뺀 빌드로 복원한 백업");
    const sentence = seven.split("\n").find((l) => l.includes("그 종류가 돌아온 빌드를 시작할 때"));
    expect(sentence).toBeDefined();
    expect(sentence).toContain("다시 적용한다");
  });

  it("lists every cause of `unavailable` in the outcome table's row (chapter 5)", () => {
    const row = docText.split("\n").find((l) => l.startsWith("| 인스턴스가 `unavailable`("));
    expect(row).toBeDefined();
    for (const cause of ["초기화 시간 초과", "초기화 실패", "만드는 함수의 예외", "등록에 없는 종류", "`unsupported-sdk-version`"]) {
      expect(row, cause).toContain(cause);
    }
  });

  it("chapter 6 sends a collector to chapter 7 and no longer asks the fork to edit the workspace file", () => {
    const six = chapter(docText, 6);
    expect(six).toContain("**`site/connectors/<이름>/`에 두는 법.**");
    expect(six).toContain("포크는 `pnpm-workspace.yaml`을 고치지 않는다.");
    expect(six).not.toContain("목록 안에** `  - site/connectors/*`");
    for (const old of ["지금 포크가 `site/` 밖에서 고쳐야 하는 곳 전부", "그 빈 곳은 #113이 추적한다"]) {
      expect(docText).not.toContain(old);
    }
  });

  it("no longer says the way in does not exist", () => {
    for (const old of [
      "`site/` 안에서 수집기를 등록하는 길이 없다",
      "`site/connectors/`를 읽는 코드와 워크스페이스 항목은 아직 없다",
      "지금은 `site/` 밖의 파일을 고쳐야 연결된다",
      "`backend/src/composition.ts`의 `connectorKinds`(종류와 만드는 함수)와 `connectorInstances()`(인스턴스와 설정)",
    ]) {
      expect(docText, old).not.toContain(old);
    }
  });
});

describe("docs.connector-sdk (I05): ownership.md section 3 (I05-R23)", () => {
  const lines = ownership.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## 3. "));
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  const three = rest.slice(0, end < 0 ? undefined : end).join("\n");
  const exception = three.slice(three.indexOf("**현재의 예외.**"), three.indexOf("`site/config/connector-scopes.json`은"));

  it("draws site/composition/ in the folder picture", () => {
    expect(three).toContain("├── composition/     포크: 조립 패키지(등록 객체 하나와 진입점 둘. 수집기를 제품에 끼운다)");
  });

  it("leaves only the lockfile, the allowBuilds `false` lines and the build values in the exception paragraph (#115 is closed by I07, #114 by I06)", () => {
    expect(exception.length).toBeGreaterThan(300);
    for (const word of ["`pnpm-lock.yaml`", "`allowBuilds`", "`false` 줄", "배포처 전송 규칙", "묶을 Provider", "검증된 CLI 조합 목록", "데이터 등급 목록"]) {
      expect(exception, word).toContain(word);
    }
    expect(exception).not.toContain("#115");
    expect(exception).not.toContain("#114");
    // the sentence that named the issue numbers goes with them: no issue is named here any more (I06-R25)
    expect(exception).not.toContain("공용 저장소의 이슈다.");
    expect(exception).not.toContain("수집기에 비밀 값을 건네는 길");
    expect(exception).toContain(
      "- 아직 메우지 못한 빌드 값: 배포처 전송 규칙·묶을 Provider·검증된 CLI 조합 목록·데이터 등급 목록. 각각 정책 판단이 따로 필요해 등록 객체로 옮기지 않았고, 포크가 공용 파일을 고쳐야 하는 값이다",
    );
    // the whole normative sentence (review F8): a `true`, or a licence to run the scripts, must turn it red
    expect(exception).toContain(
      "`pnpm-workspace.yaml`의 `allowBuilds`: 설치 스크립트가 있는 포크 의존성을 위해 더한 `false` 줄뿐이다(스크립트를 돌리지 않는다는 뜻이다). `packages:` 목록은 포함하지 않는다.",
    );
    expect(exception).toContain("`packages:` 목록은 포함하지 않는다.");
    expect(exception).toContain("[ADR 0018](adr/0018-fork-registration-at-build-time.md)");
  });

  it("no longer asks the fork to edit composition.ts, backend/package.json or the workspace list", () => {
    expect(exception).not.toContain("포크가 `site/` 밖의 다음 파일을 고쳐야 한다");
    expect(exception).not.toContain("`pnpm-workspace.yaml`의 `packages:` 목록과 `pnpm-lock.yaml`");
    expect(exception).not.toContain("`backend/package.json`의 의존성");
    expect(exception).not.toContain("#113");
    // the one mention of composition.ts says the fork does not edit it
    expect(exception).toContain("공용의 `backend/src/composition.ts`나 `backend/package.json`을 고치지 않는다");
  });

  it("points to chapter 7 as the way in, not as a gap", () => {
    expect(three).toContain("제품에 연결하는 방법은 7장에 있다.");
    expect(three).not.toContain("제품에 연결하는 길이 아직 없다는 점");
  });
});

describe("docs.connector-sdk (I05): the ADR and its index (I05-R24)", () => {
  it("is listed in the ADR index and in the docs index, and the file exists with the state and the decisions", () => {
    const adr = read("docs/adr/0018-fork-registration-at-build-time.md");
    expect(adr).toContain("# ADR 0018: 배포처 수집기는 빌드할 때 진입점 주입으로 등록한다");
    expect(adr).toContain("상태: **잠정 — 배포처 검증 대기**");
    expect(read("docs/adr/README.md")).toContain("| [0018](0018-fork-registration-at-build-time.md) |");
    expect(docsIndex).toContain("결정 기록 19건(잠정 14, 확정 4, 미결 1.");
    expect(docsIndex).toContain("포크에 두고 연결하는 방식은 ADR 0018");
    const numbers = readdirSync(resolve(docsDir, "adr")).flatMap((f) => /^(\d{4})-/.exec(f)?.[1] ?? []);
    expect(numbers).toContain("0018");
  });

  it("is the one chapter 7, ownership.md and site-setup.md point to", () => {
    for (const text of [docText, ownership, read("docs/site-setup.md")]) {
      expect(text).toContain("adr/0018-fork-registration-at-build-time.md");
    }
  });
});

describe("docs.connector-sdk (I07): the scopes file in chapter 7 (I07-R15)", () => {
  const seven = chapter(docText, 7);
  const section = seven.slice(seven.indexOf("### 인스턴스 범위 파일"), seven.indexOf("### 빌드와 산출물"));
  const forkImportLine =
    'import connectorScopes from "../../config/connector-scopes.json" with { type: "json" };';

  it("shows connectorScopes in the registration excerpt and in the field table, and the excerpt is the example's file", () => {
    const registrationExcerpt = excerpts(seven).found.find((f) => f.file === "packages/site-example/src/registration.ts");
    expect(registrationExcerpt?.lines).toContain("  connectorScopes,");
    expect(registrationExcerpt?.lines).toContain(
      'import connectorScopes from "../config/connector-scopes.json" with { type: "json" };',
    );
    expect(seven).toContain("| `connectorScopes` | 인스턴스마다의 접근 범위(site-setup S18) | 모든 인스턴스가 알 수 없음 |");
    expect(excerptProblems(seven)).toEqual([]);
  });

  it("says outside the excerpt, below it, what the fork's import line is and where the file is kept", () => {
    for (const sentence of [
      "위 발췌의 범위 파일 `import` 줄은 예시 패키지의 경로(`../config/connector-scopes.json`)다.",
      `포크의 \`site/composition/src/registration.ts\`는 같은 줄을 \`${forkImportLine}\`로 적고 \`connectorScopes\`를 등록의 필드로 넘긴다.`,
      "**범위 파일은 `site/config/connector-scopes.json`에만 둔다(다른 자리나 다른 이름이면 빌드가 멈추거나 판정을 벗어난다).**",
    ]) {
      expect(seven, sentence).toContain(sentence);
    }
    // the fork's line is not an excerpt: it is in no fenced ts block and the example's file does not hold it
    expect(excerpts(seven).found.flatMap((f) => f.lines)).not.toContain(forkImportLine);
    expect(read("packages/site-example/src/registration.ts")).not.toContain(forkImportLine);
    // the two specifiers the text names resolve as it says: the example's from its src/, the fork's from site/composition/src/
    expect(existsSync(resolve(repoRoot, "packages/site-example/src", EXAMPLE_IMPORT_SPECIFIER))).toBe(true);
    expect(resolve(repoRoot, "site/composition/src", FORK_IMPORT_SPECIFIER)).toBe(
      resolve(repoRoot, "site/config/connector-scopes.json"),
    );
  });

  it("has the section, says the registration binds the file at build time and the running build reads nothing", () => {
    expect(section.length).toBeGreaterThan(1000);
    for (const sentence of [
      "**이 파일이 설치본에 따로 놓이는 것이 아니라, 등록이 빌드할 때 그 내용을 가져와 백엔드 묶음에 넣는다.**",
      "실행본은 이 파일을 디스크에서 읽지 않고 등록이 건넨 값만 쓴다.",
      "그래서 환경 변수, 명령줄 인자, 현재 폴더, 데이터 폴더나 설치 폴더에 놓은 파일로는 값을 바꿀 수 없고, 바꾸려면 다시 빌드한다.",
      "[ADR 0020](adr/0020-installed-scopes-in-registration.md)",
    ]) {
      expect(section, sentence).toContain(sentence);
    }
  });

  it("says the place and the name are fixed, what stops the build there and what the build cannot see", () => {
    for (const sentence of [
      "범위 파일은 `site/config/connector-scopes.json`에만 둔다. 조립 패키지 안(`site/composition/config/` 등)에 두면 빌드가 `scopes-file-misplaced`로 멈춘다.",
      "다른 이름으로 바꾸거나 `node_modules/` 아래의 JSON을 가져오는 것은 빌드가 보지 못하므로 멈추지 않고 보고서가 `absent`로 통과한다.",
      "그 경우는 받아들인 위험이고, 시작 로그는 `bound`인데 보고서는 `absent`라는 데서 드러난다.",
      "인스턴스 ID를 잘못 적은 항목은 형식이 맞아 드러나지 않는다(S31의 확인이 드러낸다).",
      "가져온 값을 다른 곳에는 쓰면서 `connectorScopes`에는 넘기지 않은 등록도 빌드는 통과시킨다.",
      "이 경우 `site-check --scopes`가 0이 아닌 값으로 끝나고 시작 로그가 `absent`를 남긴다.",
    ]) {
      expect(section, sentence).toContain(sentence);
    }
  });

  it("says the import line needs `with { type: \"json\" }`, that no tsconfig setting is added, and not to turn resolveJsonModule off", () => {
    for (const sentence of [
      "`import` 줄에는 `with { type: \"json\" }`가 꼭 있어야 한다.",
      "빠져도 타입 검사와 시험은 통과하고 Node의 소스 실행은 `ERR_IMPORT_ATTRIBUTE_MISSING`으로 실패한다.",
      "속성 없는 가져오기의 묶기는 재지 않았다(통과하면 값이 묶음에 들어가 설치본은 정상이고, 실패하면 빌드가 멈춘다. 어느 쪽이든 조용하지 않다).",
      "측정한 모양(`references` 없는 최소 패키지)에서는 `tsconfig.json`에 더할 설정이 없다.",
      "`references`가 있는 실제 포크의 `tsconfig.json`은 재지 않았다.",
      "다만 `resolveJsonModule`을 `false`로 두지 않는다(명시로 `false`이면 TypeScript가 JSON 모듈을 찾지 못한다).",
      "포크의 범위 파일은 패키지 밖(`site/config/`)에 있어서 `include`에 더할 것도 없다.",
    ]) {
      expect(section, sentence).toContain(sentence);
    }
    // the example's own guard of the attribute and its tsconfig (no `resolveJsonModule`) are what the text describes
    expect(read("packages/site-example/src/scopes.test.ts")).toContain("`with { type: \"json\" }`");
    expect(read("packages/site-example/tsconfig.json")).not.toContain("resolveJsonModule");
    expect(read("tsconfig.base.json")).not.toContain("resolveJsonModule");
  });

  it("says the one exception of the module boundary rule, with the three things it needs and what stays barred", () => {
    for (const sentence of [
      "규칙에 **예외 하나**가 있다: 조립 패키지(`@pki-site/composition`)의 `site/composition/src/registration.ts`가 이 파일을 상대 경로의 정적 `import` 선언으로 가져오는 것만 허용된다.",
      "같은 패키지의 다른 파일(시험 파일 포함), `site/config/`의 다른 파일, `export … from`, `import()`, 절대 경로로 같은 파일을 가리키는 것은 지금처럼 막힌다.",
      "앞에서 적은 대로 인라인 설정 주석으로 규칙을 끄는 길도 없다.",
    ]) {
      expect(section, sentence).toContain(sentence);
    }
    const rule = read("tooling/eslint/module-boundary.js");
    expect(rule).toContain('pkg: "@pki-site/composition",');
    expect(rule).toContain('file: "src/registration.ts",');
    expect(rule).toContain('target: "../../site/config/connector-scopes.json",');
  });

  it("says what stops the build, in which words, where the result is left, and that nothing is copied", () => {
    for (const sentence of [
      "`pnpm --filter @pki/desktop build`는 백엔드를 묶은 뒤 범위 파일을 판정하고 다음 넷이면 멈춘다. 멈추면 오류의 문구에 이 코드가 적힌다.",
      "`scopes-file-misplaced`는 허용된 자리가 아닌 범위 파일이 묶음에 있는 것, `scopes-file-unbound`는 `site/config/connector-scopes.json`이 있는데 등록이 가져오지 않아 묶음에 없는 것, `scopes-file-invalid`는 객체가 아니거나 틀린 항목이 있거나 키 `__proto__`나 두 번 나오는 키가 있는 것, `scopes-file-placeholder`는 예시의 범위 값 `pki-example-scope`가 그대로인 것이다.",
      "파일이 없거나(`absent`) 범위가 있는 항목이 하나도 없는 것(`empty`)은 멈추지 않는다.",
      "통과한 빌드는 마지막 출력 줄을 `connector scopes: <상태>`로 끝내고, `apps/desktop/dist` 폴더의 `build-report.json`에 있는 `connectorScopes`에 상태(`absent`, `empty`, `bound`)와 항목 수, 범위가 있는 항목 수를 적는다.",
      "범위 값과 인스턴스 ID는 어디에도 싣지 않는다. 빌드는 범위 파일을 앱 폴더에 복사하지 않는다.",
    ]) {
      expect(section, sentence).toContain(sentence);
    }
    const judgment = read("apps/desktop/build/scopes-check.ts");
    for (const code of ["scopes-file-misplaced", "scopes-file-unbound", "scopes-file-invalid", "scopes-file-placeholder"]) {
      expect(judgment, code).toContain(`| "${code}"`);
    }
    expect(judgment).toContain('const EXAMPLE_PLACE = `packages/site-example/config/${FILE_NAME}`;');
    expect(read("packages/contracts/src/site-scopes.ts")).toContain("pki-example-scope");
    const build = read("apps/desktop/build/build.ts");
    expect(build).toContain("connector scopes: ${scopes.state}");
    expect(build).not.toMatch(/cpSync\([^)]*scopes/);
  });

  it("says an instance made while running cannot be listed and the browser backend knows no scopes, as the code has it", () => {
    for (const sentence of [
      "실행 중에 만들어지는 가져오기 인스턴스(I02-B의 `jsonl-file:…`)는 ID를 미리 알 수 없어 범위 파일에 적을 수 없고, 그런 인스턴스는 알 수 없음(닫힌 쪽)이다.",
      "브라우저 개발용 백엔드(`backend/src/dev.ts`)는 등록을 받지 않으므로 포크에서도 모든 인스턴스가 알 수 없음이다.",
    ]) {
      expect(section, sentence).toContain(sentence);
    }
    expect(read("backend/src/dev.ts")).not.toContain("connectorScopes");
  });

  it("lists the four edits of a fork that copies the example, each as a full sentence, and the copied files they name exist", () => {
    for (const sentence of [
      "**예시를 `site/composition/`에 복사하는 포크는 범위 파일 때문에 네 곳을 고친다.**",
      "고치지 않으면 빌드가 멈추거나 `pnpm typecheck`와 `pnpm test`가 실패한다(`import` 경로만 고친 시험 파일은 `pnpm lint`도 실패한다).",
      "1. 복사된 `site/composition/config/connector-scopes.json`(예시의 `packages/site-example/config/connector-scopes.json`)을 `site/config/connector-scopes.json`으로 옮긴다(`site/config/` 폴더를 만든다). `registration.ts`의 `import` 줄은 `../../config/connector-scopes.json`으로 고친다(`with { type: \"json\" }`는 그대로 둔다). 파일의 값은 예시의 인스턴스 ID(`example-import`)와 범위 값(`pki-example-scope`)이 아닌 포크의 것으로 바꾼다. 옮기지 않으면 빌드가 `scopes-file-misplaced`로, 값을 바꾸지 않으면 `scopes-file-placeholder`로 멈춘다.",
      "2. 복사한 `site/composition/src/scopes.test.ts`는 범위 파일을 `import`하지 않고 `readFileSync`로 읽도록 고친다. 옛 경로(`../config/connector-scopes.json`)는 타입 검사가 찾지 못하고(`TS2307`), 경로를 `../../config/connector-scopes.json`으로 고쳐 가져오면 경계 규칙이 `registration.ts`가 아닌 파일의 가져오기를 막는다(`pki/module-boundary`). 시험이 가져오기를 넣는 인스턴스와 기대하는 값도 포크의 범위 파일의 것으로 맞춘다.",
      "3. 복사한 `site/composition/src/registration.test.ts`와 `site/composition/src/shell.boot.test.ts`가 기대하는 수집기 종류와 인스턴스 ID를 포크의 등록에 맞춘다(수집기 종류와 인스턴스를 바꾸지 않았다면 고칠 것이 없다).",
      "4. 복사한 `tsconfig.json`의 `include`를 `[\"src\"]`로 한다(위 블록). 예시의 `config/*.json`은 범위 파일이 패키지 안에 있을 때만 필요하다.",
    ]) {
      expect(seven, sentence).toContain(sentence);
    }
    // what the copied files hold, which is why each of the four edits is needed
    const scopesTest = read("packages/site-example/src/scopes.test.ts");
    expect(scopesTest).toContain('import scopesFile from "../config/connector-scopes.json" with { type: "json" };');
    expect(scopesTest).toContain('const INSTANCE = "example-import";');
    expect(read("packages/site-example/config/connector-scopes.json")).toContain('"example-import": ["pki-example-scope"]');
    expect(read("packages/site-example/src/registration.test.ts")).toContain('id: "example-notes"');
    expect(read("packages/site-example/src/shell.boot.test.ts")).toContain('id: "example-notes"');
    expect(JSON.parse(read("packages/site-example/tsconfig.json")).include).toEqual(["src", "config/*.json"]);
  });

  it("gives the fork the `--scopes` command, as the code answers it, in the commands, the bullets and the recap", () => {
    for (const sentence of [
      "- 포크의 `site-check --scopes`는 종류 대신 등록의 인스턴스 범위 상태를 알린다. 항목 수와 범위가 있는 항목 수만 적고 범위 값과 인스턴스 ID는 적지 않는다.",
      "등록에 `connectorScopes`가 없으면(`미구현, 배포처 후속`), 객체가 아니면, 틀린 항목이 있으면, 예시의 범위 값이 그대로이면, 범위가 있는 항목이 하나도 없으면 0이 아닌 값으로 끝난다.",
      "`pnpm --filter @pki-site/composition site-check --scopes`, `pnpm --filter @pki/desktop build`다.",
      "- 인스턴스 범위 파일은 `site/config/connector-scopes.json`에만 두고, 등록이 정적 `import`로 가져와 빌드할 때 백엔드 묶음에 넣는다. 실행본은 그 파일을 읽지 않는다. 자리가 틀리거나 묶이지 않았거나 형식이 틀렸거나 예시 값 그대로이면 빌드가 멈춘다.",
    ]) {
      expect(seven, sentence).toContain(sentence);
    }
    const code = read("backend/src/site-check-main.ts");
    for (const line of [
      'fail("미구현, 배포처 후속 (S30: 범위 파일을 채우고 등록의 connectorScopes에 묶는다)");',
      'fail("connectorScopes가 객체가 아니다 (connector-scopes-field-invalid)");',
      "fail(`틀린 항목 ${bound.rejected}개 (connector-scopes-entry-invalid)`);",
      'fail("예시 값이 그대로다 (채우지 않은 예시의 범위 값)");',
      "fail(`범위가 있는 항목이 없다 (항목 ${bound.entries}개)`);",
    ]) {
      expect(code, line).toContain(line);
    }
  });

  it("lists the files a fork adds with the scopes file under config/, and the build's bundle line says only the backend holds the value", () => {
    for (const line of [
      "└── config/                       설정 값: connector-scopes.json(인스턴스 범위. 등록이 가져온다)",
      "│       ├── registration.ts       registration: SiteRegistration(범위 파일을 `connectorScopes`로 넘긴다)",
    ]) {
      expect(seven, line).toContain(line);
    }
    expect(seven).toContain(
      "- 범위 파일의 값은 백엔드 묶음 안에만 있다. 앱 폴더에는 `connector-scopes.json`이라는 이름의 파일이 없고, 셸의 묶음(`main.js`)과 화면(`web/`)에도 값이 없다. 공용 진입점을 묶으면 범위 파일도 그 값도 묶음에 없다",
    );
  });
});

describe("docs.connector-sdk (I07): chapters 7 and 11 no longer list the installed build's gap, ownership.md says the registration binds the file (I07-R15)", () => {
  it("chapter 7 has no list of what is missing any more: #116 is built by I02B-T06 (#114 by I06, the scopes file by I07)", () => {
    const seven = chapter(docText, 7);
    expect(seven).not.toContain("### 아직 없는 것");
    expect(seven).not.toContain("#116");
    expect(seven).not.toContain("#115");
    expect(seven).not.toContain("#114");
    expect(seven).not.toContain("비밀 값을 건네는 통로");
  });

  it("chapter 11's table has no row for the scopes file and no 'only the source tree reads it' sentence", () => {
    const eleven = chapter(docText, 11);
    expect(eleven).not.toContain("connector-scopes.json");
    expect(eleven).not.toContain("소스 트리에서 실행할 때만 그 파일을 읽는다");
  });

  it("ownership.md says the file takes effect only when bound into the registration, and where it may be kept", () => {
    const lines = ownership.split("\n");
    const start = lines.findIndex((l) => l.startsWith("## 3. "));
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => l.startsWith("## "));
    const three = rest.slice(0, end < 0 ? undefined : end).join("\n");
    expect(three).toContain(
      "이 파일은 포크의 등록(`connectorScopes`)에 묶어야 쓰이고, 포크의 빌드가 그 값을 백엔드 묶음에 넣는다.",
    );
    expect(three).toContain(
      "파일은 `site/config/connector-scopes.json`에만 둔다(다른 자리나 이름이면 빌드가 멈추거나 판정을 벗어난다. 방법은 [connector-sdk.md](connector-sdk.md) 7장).",
    );
    expect(three).not.toContain("#115");
  });
});

describe("docs.connector-sdk (I07): the ADR and its index (I07-R15)", () => {
  it("ADR 0020 exists with its title and state, and the ADR index and the docs index list it", () => {
    const adr = read("docs/adr/0020-installed-scopes-in-registration.md");
    expect(adr).toContain("# ADR 0020: 포크의 인스턴스 범위는 등록이 빌드할 때 묶어 설치본에 싣는다");
    expect(adr).toContain("상태: **잠정 — 배포처 검증 대기**");
    expect(read("docs/adr/README.md")).toContain("| [0020](0020-installed-scopes-in-registration.md) |");
    expect(docsIndex).toContain("인스턴스 범위 파일은 ADR 0020과 S30·S31");
    expect(docsIndex).toContain("결정 기록 19건(잠정 14, 확정 4, 미결 1.");
  });

  it("the ADR index links only files that exist (0017 is written by I02-B, 0019 by I06)", () => {
    const index = read("docs/adr/README.md");
    const links = [...index.matchAll(/\]\((\d{4}-[a-z0-9-]+\.md)\)/g)].map((m) => m[1] as string);
    expect(links.length).toBeGreaterThanOrEqual(18);
    expect(links.filter((l) => !existsSync(resolve(docsDir, "adr", l)))).toEqual([]);
    const numbers = readdirSync(resolve(docsDir, "adr")).flatMap((f) => /^(\d{4})-/.exec(f)?.[1] ?? []);
    expect(numbers).toContain("0020");
    expect(numbers).toContain("0019");
    // 0017 is written (I02B-T06): the file, its row of the index, and no "reserved" sentence left behind
    expect(numbers).toContain("0017");
    expect(links.filter((l) => l.startsWith("0017-"))).toEqual(["0017-local-files-in-place.md"]);
    expect(index).toContain("| [0017](0017-local-files-in-place.md) |");
    expect(index).not.toContain("0017은 I02-B spec이 정해 둔 번호이고 아직 쓰이지 않았다.");
    expect(index).not.toContain("0019는 I06 spec이 정해 둔 번호");
  });

  it("the ADR points to the chapter, the checklist and the spec, and names its eight decisions", () => {
    const adr = read("docs/adr/0020-installed-scopes-in-registration.md");
    for (const ref of ["../specs/2026-11-22-I07-installed-scopes-file.md", "../connector-sdk.md", "../site-setup.md", "0018-fork-registration-at-build-time.md"]) {
      expect(adr, ref).toContain(ref);
    }
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) expect(adr).toContain(`\n${n}. **`);
    expect(adr).not.toContain("\n9. **");
  });
});

describe("docs.connector-sdk (I06): chapter 8, the way a Connector gets a credential (I06-R24, C19)", () => {
  const eight = chapter(docText, 8);
  const connectors = read("backend/src/connectors.ts");

  it("takes exactly two code blocks, both from the example that reads its token, and they are that file's lines", () => {
    const blocks = excerpts(eight).found;
    expect(blocks.map((b) => b.file)).toEqual([
      "packages/connector-example/src/adapters/credentialed-connector.ts",
      "packages/connector-example/src/adapters/credentialed-connector.ts",
    ]);
    expect(excerptProblems(eight)).toEqual([]);
    // the first block holds the read and the refusal, the second the health answer
    expect(blocks[0]?.lines.join("\n")).toContain("if ((await credentials.read(SLOT)) !== acceptedToken) throw new ConnectorCredentialError();");
    expect(blocks[1]?.lines.join("\n")).toContain('return { state: "unavailable", reason: HEALTH_REASON_CREDENTIAL_REJECTED };');
  });

  it("says how to declare a slot: in the registration's instance, never the config or the manifest, and what the check says", () => {
    for (const sentence of [
      "인스턴스가 필요로 하는 자격 증명은 등록의 인스턴스 정의(7장)에 `credentials`로 선언한다. 값이 아니라 칸의 이름이다. `config`에도, 수집기의 `manifest`에도 적지 않는다.",
      "- 칸 이름은 `^[a-z][a-z0-9-]{0,15}$`를 따르고, 한 인스턴스 안에서 서로 달라야 하며, 많아야 8개(`MAX_CREDENTIAL_SLOTS`)다.",
      "- 어기면 등록 검사가 `instance-credentials-invalid`를 돌려주고, 시작할 때는 그 인스턴스를 빼고 계속한다(7장).",
      "- 칸을 선언하지 않은 인스턴스의 접근자는 무엇을 읽어도 거부한다.",
    ]) {
      expect(eight, sentence).toContain(sentence);
    }
    expect(read("backend/src/connector-credentials.ts")).toContain("export const CREDENTIAL_SLOT_PATTERN = /^[a-z][a-z0-9-]{0,15}$/;");
  });

  it("says what the accessor does and what the product keeps, as full sentences", () => {
    for (const sentence of [
      "제품은 `initialize`를 부를 때 **언제나** 둘째 인자 `context`를 넘긴다.",
      "- `read(칸)`은 **부를 때마다 저장소에서 읽는다.** 제품은 값을 기억해 두지 않는다.",
      "- 선언하지 않은 칸을 읽거나, 저장소가 \"없음\"이나 \"쓸 수 없음\"으로 답하거나, 3초(`CREDENTIAL_CHECK_TIMEOUT_MS`) 안에 답이 오지 않으면 `read`는 `ConnectorCredentialError`로 거부한다. 그 오류에는 칸 이름도 저장 이름도 실리지 않는다.",
      "- 제품이 버린 객체(시작 때 제한 시간을 넘긴 것, 실패한 재점검의 것, 새 객체로 바뀐 것)의 접근자는 그때부터 무엇을 읽어도 거부한다.",
      "- `context`는 이 길이 들어온 뒤의 제품에서는 언제나 있다. 그 앞의 제품은 `context`를 넘기지 않으므로, 자격 증명을 쓰는 수집기는 `context`가 없으면 `ConnectorCredentialError`로 끝낸다(위 발췌의 `if (!context)`).",
      "인자 하나만 받는 기존 `initialize`는 고치지 않아도 그대로 돈다. 규격 버전은 2 그대로다.",
    ]) {
      expect(eight, sentence).toContain(sentence);
    }
  });

  it("tells the Connector's author what to hold, what never to write, when to throw and how health says a refusal", () => {
    for (const sentence of [
      "- **필요한 동안만 쥔다.** 읽은 값을 필드에 오래 담아 두는 것은 제품이 막지 못한다. 쓸 때 읽고 쓰고 나면 놓는다.",
      "- **값을 어디에도 옮기지 않는다.** 레코드의 본문과 `metadata`, 던지는 오류의 문구와 이름과 `cause`, `healthCheck`의 사유, 수집기 자신의 로그와 파일에 넣지 않는다.",
      "- **원 시스템이 자격 증명을 받아 주지 않으면**(인증 실패, 만료, 철회) `initialize`나 `getChanges`에서 `ConnectorCredentialError`를 던진다.",
      "원 시스템이 준 오류의 이름과 문구를 `Error` 하나로 다시 만들어 던지지 않는다. 이름이 `ConnectorCredentialError`이고 문구가 고정 문구와 같은 오류는 거부로 읽히기 때문이다.",
      "- **`healthCheck`는 던지지 않으므로** 거부를 `{ state: \"unavailable\", reason: HEALTH_REASON_CREDENTIAL_REJECTED }`로 알린다(값은 `credential-rejected`). 제품은 `healthCheck`의 `reason`을 이 상수와 같은지만 본다. 건강 사유의 값은 재점검과 다시 만들기에서만 읽힌다.",
      "제품은 시작할 때 `healthCheck`를 묻지 않으므로 시작과 동기화에서의 거부는 `ConnectorCredentialError`로 알려야 하고, 건강 사유로만 알리는 수집기는 계약 묶음이 `credential-rejection-unsignalled`로 잡는다.",
      "제품은 이 오류를 `instanceof`와 고정된 이름·문구 쌍 **둘 다**로 알아본다(`@pki/contracts`의 `isConnectorCredentialError`). 포크의 번들이 `@pki/contracts`를 한 벌 더 싣더라도 거부가 읽힌다.",
      "- **`healthCheck`의 그 밖의 `unavailable`은 거부로 읽히지 않고** 한 시간마다 같은 값으로 다시 시도된다.",
      "- **값을 되쓰는 길은 없다.** 접근자는 읽기만 한다.",
    ]) {
      expect(eight, sentence).toContain(sentence);
    }
  });

  it("says where the value is put in, the one line and 8192 characters, and what the screen does after a save", () => {
    for (const sentence of [
      "**포크는 화면을 고치지 않는다.**",
      "- 값은 화면에서 셸의 저장소로 곧장 간다(preload의 `setSecret(name, value)`와 `deleteSecret(name)`, 이름은 목록이 준 `name`). 백엔드의 API를 지나지 않는다. 화면에는 값을 되읽는 함수가 없고, 백엔드의 어떤 API도 값을 답에 싣지 않는다.",
      "- 저장이나 삭제가 성공하면 화면이 `POST /api/connectors/credentials-changed`(`{ connectorId }`)를 한 번 부른다. 이 알림에는 값이 없고 다른 API와 같은 검사(세션 토큰, Origin, Host)를 지난다.",
      "답은 그 인스턴스의 목록 요약과 `rebuild` 하나다: `done`(바로 다시 만들었다), `queued`(진행 중인 재점검이나 간격 때문에 미뤘다), `skipped`(재점검을 그만둔 인스턴스이거나 만드는 함수가 없는 종류, 읽을 수 없는 선언의 인스턴스라 하지 않았다).",
      "- **이 화면에서 넣는 자격 증명은 한 줄, 8192자 이하다.** 길이는 UTF-16 코드 단위로 세므로 기본 다국어 평면 밖의 글자는 둘로 센다. 줄바꿈이 든 값과 8192자를 넘는 값은 저장하지 않고 안내만 보인다(자르지 않는다). 여러 줄 값(PEM, JSON 키)은 이 화면이 받지 않는다. 한 줄로 이어 붙인 PEM만 한도 안에서 된다.",
      "이 입력란에 남은 한계는 하나다. 코드가 넣은 값(비밀번호 관리자의 자동 채움, 스크립트)은 브라우저가 줄바꿈을 지운 뒤에야 화면에 닿으므로, 화면은 그 값에 줄바꿈이 있었는지 알 수 없고 지워진 값이 저장된다.",
      "- OS 보호(Windows의 DPAPI)를 쓸 수 없으면 값은 저장되지 않는다. 환경 변수나 설정 파일의 평문으로 조용히 넘어가지 않는다.",
    ]) {
      expect(eight, sentence).toContain(sentence);
    }
    expect(eight).not.toContain("#162");
  });

  it("says what each way of a refusal ends in: the four reasons, the stop code, and what is not retried", () => {
    for (const sentence of [
      "- 만료와 거부는 한 사유다. 저장소는 만료 시각을 모르고 사용자가 할 일도 같기 때문이다.",
      "- 사유는 수집기의 말이 아니라 **저장소가 한 답**으로 정한다.",
      "- 칸을 선언하지 않은 인스턴스나 선언하지 않은 칸을 읽은 수집기가 이 오류를 던지면 넣을 값이 없으므로 사유 없는 `unavailable`이 되고 한 시간마다 다시 시도된다.",
      "- 동기화 도중에 `getChanges`가 `ConnectorCredentialError`를 던지면 그 동기화는 멈춤 코드 `credential-unusable`로 멈춘다. 같은 호출을 다시 시도하지 않고, 앞서 저장한 페이지와 cursor는 남으며, 그 작업은 `held`가 되어 시도를 쓰지 않는다(5장의 표).",
      "- 앱을 시작할 때 값이 없거나 저장소를 쓸 수 없으면 제품은 만드는 함수도 `initialize`도 부르지 않고 수집기 객체를 만들지 않는다.",
      "- 읽기가 3초 안에 답하지 못하면 `read`는 거부되고 사유는 `credential-unreadable`이다. 선언한 칸의 값이 없는데 저장소도 쓸 수 없으면 사유는 `credential-store-unavailable`이다(저장소를 쓸 수 없음이 먼저다).",
      "다시 만들기가 진행 중인 인스턴스는 한 시간마다의 재점검이 건너뛴다.",
      "- **거부된 값은 한 시간마다 다시 시도되지 않는다.** `credential-rejected`인 인스턴스는 한 시간마다의 재점검이 존재 확인도 만드는 함수도 `initialize`도 부르지 않고 건너뛴다.",
      "- 그 인스턴스가 다시 시도되는 때는 변경 알림과 앱을 다시 시작할 때뿐이다.",
      "30초(`CREDENTIAL_RETRY_MIN_MS`) 안에 온 알림은 그 시각 뒤의 한 번으로 모은다.",
      "- 이 상한은 **수집기가 거부를 알렸을 때만** 선다.",
      "다시 만들기가 60초(`RECHECK_TIMEOUT_MS`)를 넘기면 옛 객체를 버리고 사유 없는 `unavailable`이 되며 다음 재점검이 되살린다.",
    ]) {
      expect(eight, sentence).toContain(sentence);
    }
  });

  it("says the address is not in the stored name, so a changed origin changes the instance ID, and what stays when an instance leaves", () => {
    for (const sentence of [
      "**`config`(원 시스템의 주소)는 이름에 들어가지 않는다.**",
      "그래서 같은 종류와 ID를 둔 채 주소만 바꾼 빌드에서는 **옛 값이 새 주소로 건네진다.** 이를 막는 것은 포크의 일이다: 인스턴스가 가리키는 원 시스템을 바꿀 때는 인스턴스 ID도 바꾼다. 그러면 사용자가 값을 다시 넣게 된다(site-setup S28 ⑤).",
      "등록에서 빠진 인스턴스의 값은 저장소에 암호문으로 남는다. 제품은 시작할 때 저장소를 정리하지 않는다.",
    ]) {
      expect(eight, sentence).toContain(sentence);
    }
  });

  it("lists the ten things the product cannot catch, each with who owns it, and says nothing is left in the places it writes", () => {
    const rows = eight
      .split("\n")
      .filter((l) => l.startsWith("| ") && !l.startsWith("| 경우 ") && !l.startsWith("| 사유 "))
      .filter((l) => !l.startsWith("| `credential-") && !l.startsWith("| `login-required`"))
      .map((l) => l.split("|")[1]?.trim());
    expect(rows).toEqual([
      "수집기가 값을 레코드의 본문이나 `metadata`에 넣어 돌려준다",
      "수집기나 그 의존성이 자기 로그나 파일에 값을 쓴다",
      "포크의 코드가 다른 인스턴스의 값을 읽는다",
      "느린 수집기의 값을 바꾸면 멈춘다",
      "보류된 작업 하나가 한 시간 기다린다(미세한 틈 둘)",
      "알림을 쉬지 않고 보내는 호출자가 있다",
      "주소만 바꾼 인스턴스가 옛 값을 받는다",
      "수집기가 거부를 알리지 않는다(`healthCheck`의 다른 사유, 다른 종류의 오류)",
      "칸을 선언하지 않은 수집기(OS 로그인에 기대는 것)의 인증 실패",
      "화면(렌더러)이 깨져 값을 바꿔 넣거나 지운다",
    ]);
    for (const sentence of [
      "제품이 쓰는 어느 곳에도 값이 남지 않는다: 데이터 폴더의 모든 파일(정본 DB와 보조 파일, 삭제 장부, `secrets.json`에는 암호문뿐), 설정 파일, 백엔드와 셸의 로그와 표준 출력·오류, 모든 API 응답과 셸이 화면에 돌려주는 답, 동기화 결과와 작업과 활동 목록, `site-check`의 출력이다.",
      "수집기가 값을 오류의 문구나 건강 사유에 **일부러 실어도** 같다.",
      "계약 묶음이 재지 않는 누출 모양도 있다: 둘로 나눠 쓴 글, 16진수, `user:`와 값을 이은 `Basic` base64, 패딩이 없거나 어긋난 base64, 처리되지 않은 약속 거부, 한 바퀴보다 늦게 도는 타이머다.",
      "값이 지나는 길은 둘뿐이다. \"화면 입력 → 셸의 저장소\"와 \"셸 → 백엔드 프로세스 → 수집기\"다.",
      "포크의 수집기는 같은 프로세스에서 같은 권한으로 도는 믿는 코드이므로 칸의 제한은 실수를 잡는 장치이지 격리가 아니다(7장).",
    ]) {
      expect(eight, sentence).toContain(sentence);
    }
  });

  it("no longer says the way does not exist, nor leaves the fork to choose the way", () => {
    for (const old of [
      "수집기가 비밀 값을 받는 통로는 아직 없다",
      "수집기에 비밀 값을 건네는 통로는 아직 없다",
      "그러므로 포크가 수집기의 자격 증명을 어떻게 읽을지",
      "포크가 정해야 하고",
    ]) {
      expect(docText, old).not.toContain(old);
    }
    expect(eight).toContain("OS 자격 증명 저장소");
  });

  it("is true to the code: one place makes the object, asks the slots first, reads only the fixed health reason, skips the rejected hourly", () => {
    const open = connectors.slice(connectors.indexOf("async function openConnector("));
    const body = open.slice(0, open.indexOf("\n}\n"));
    expect(body.indexOf("reasonOfPresence(await access.check())")).toBeGreaterThan(0);
    expect(body.indexOf("reasonOfPresence(await access.check())")).toBeLessThan(body.indexOf("connector = factory();"));
    expect(body.indexOf("connector = factory();")).toBeLessThan(body.indexOf("initializeConnector(connector, config, { credentials: access.credentials })"));
    expect(connectors).toContain("return health.reason === HEALTH_REASON_CREDENTIAL_REJECTED ? \"rejected\" : \"down\";");
    expect(connectors).toContain('if (entry.summary.reason === "credential-rejected" || entry.slot) return entry.summary.state;');
    expect(connectors).toContain('return { stop: "credential-unusable" }; // the same call is not tried again (I06-R10)');
    const screen = read("apps/web/src/connector-credential.ts");
    const secretCheck = read("apps/web/src/api-key.ts");
    expect(secretCheck).toContain("export const MAX_SECRET_LENGTH = 8192;");
    expect(secretCheck).toContain('if (/[\\r\\n]/.test(value)) return "line-break";');
    expect(read("apps/web/src/connector-text.ts")).toContain('"이 실행에는 저장소가 없습니다.');
    expect(screen).toContain('queued: "곧 반영됩니다."');
    expect(screen).toContain('skipped: "앱을 다시 시작해야 반영됩니다."');
    expect(screen).toContain('return "자격 증명을 저장할 수 없습니다 (OS 보호 저장소를 쓸 수 없음).";');
    expect(screen).toContain('return "자격 증명을 지우지 못했습니다 (저장소 파일을 읽거나 쓸 수 없음).";');
    // the preload has no function that reads a value back
    const bridge = read("apps/desktop/src/bridge.ts");
    expect(bridge).not.toMatch(/getSecret|readSecret/);
    for (const fn of ["setSecret", "hasSecret", "deleteSecret"]) expect(bridge, fn).toContain(`${fn}: checked(`);
  });
});

describe("docs.connector-sdk (I06): chapters 2, 5, 6 and 7 carry what the credential path adds (I06-R24)", () => {
  it("chapter 2 gives initialize its optional second argument and says an old one-argument implementation needs no change", () => {
    const two = chapter(docText, 2);
    expect(two).toContain("- `initialize(config, context?)`: 설정을 읽고 준비한다.");
    expect(two).toContain(
      "둘째 인자 `context`는 선택 항목이고 자격 증명을 읽는 접근자(`context.credentials`)를 담는다. 인자 하나만 받는 구현은 고치지 않아도 된다(8장).",
    );
    expect(two).toContain("- 자격 증명이 필요하면 `initialize`의 둘째 인자로 받은 접근자로 읽는다. 값은 설정에 적지 않는다(8장).");
  });

  it("chapter 5 names ConnectorCredentialError as an error to throw, says it stops the sync and is not retried, and the one exception to 'a ready object is not replaced'", () => {
    const five = chapter(docText, 5);
    for (const sentence of [
      "- `ConnectorCredentialError`: 원 시스템이 자격 증명을 받아 주지 않을 때(인증 실패, 만료, 철회) 던진다. 인자가 없고 문구가 고정이다. 같은 호출을 다시 시도하지 않고 동기화는 `credential-unusable`로 멈춘다. 언제 던지는지는 8장에 있다.",
      "**`ConnectorError`, `ConnectorRateLimitError`, `ConnectorCredentialError`가 아닌 예외를 던지면** 제품은",
      "다만 `ConnectorCredentialError`로 끝난 `site-check`는 그 문구도 출력하지 않는다(7장).",
      "자격 증명 때문에 `unavailable`인 인스턴스(사유 `credential-store-unavailable`, `credential-missing`, `credential-unreadable`, `credential-rejected`)의 수집 작업은 `connector-unavailable`이 아니라 그 인스턴스의 사유로 보류되고, 그 인스턴스가 `ready`가 되면 풀린다.",
      "재점검은 준비된 인스턴스의 객체를 바꾸지 않는다(사용자가 자격 증명을 바꿨다는 변경 알림만 예외다. 8장).",
      "다만 원 시스템이 자격 증명을 거부한 인스턴스(`credential-rejected`)는 한 시간마다는 건너뛴다(8장).",
    ]) {
      expect(five, sentence).toContain(sentence);
    }
    expect(five).not.toContain("수집기는 실패를 두 종류의 오류로 알린다.");
  });

  it("chapter 5 says a mismatched instance id is unavailable, never made, and its job held (I05F-R8, C7)", () => {
    expect(chapter(docText, 5)).toContain(
      "등록의 인스턴스 ID가 정본에 다른 종류로 묶여 있으면 그 인스턴스는 `unavailable`(사유 `instance-kind-mismatch`)이고, 제품은 그 수집기를 만들지도 초기화하지도 않는다. 그 수집 작업은 그 사유로 보류되며, 등록의 ID나 종류를 고쳐 다시 시작해 어긋남이 없어지면 풀린다.",
    );
  });

  it("chapter 6 lists the two scenario fields and the five codes they open, with the 4 second limit, as the testkit has them", () => {
    const six = chapter(docText, 6);
    const testkit = read("packages/testkit/src/connector.contract.ts");
    expect(testkit).toContain("credentials?: Record<string, string>;");
    expect(testkit).toContain("rejected?: { config: unknown; credentials: Record<string, string> };");
    const rows = six.split("\n").filter((l) => /^\| `(credentials|rejected)` \|/.test(l));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("값은 16자 이상이어야 한다(짧으면 위반이 아니라 시나리오의 오류다).");
    expect(testkit).toContain("const MIN_CREDENTIAL_LENGTH = 16;");
    for (const sentence of [
      "시나리오에 `credentials`나 `rejected`가 있으면 계약 묶음은 위반 코드 다섯을 더 본다. 어느 것도 값이나 문구를 싣지 않고 코드만 돌려준다.",
      "값은 원래 글, base64로 바꾼 글, 주소용으로 바꾼 글(percent-encoding) 세 모양으로 찾는다.",
      "값이 든 시나리오의 확인은 4초(`LOG_TAP_DEADLINE_MS`) 안에 끝나야 한다. 더 느린 수집기는 시험의 제한 시간을 늘려도 그 상한에서 확인이 실패한다. 상한 뒤에 버려진 실행의 뒤늦은 출력은 다음 확인의 것으로 잡히거나 실제 `console`로 나갈 수 있다.",
      "이 예시는 `exports`에 올라 있지 않다. 포크는 이 파일과 그것이 가져오는 `example-connector.ts`, 계약 시험이 쓰는 `synthetic-notes.ts`를 자기 수집기 패키지로 복사해 모델로 삼는다.",
      "예시 패키지에는 규격을 한 곳만 어긴 변형이 여덟 있다.",
    ]) {
      expect(six, sentence).toContain(sentence);
    }
    // the example is not exported (the doc says so) and the eight variants are in the file
    expect(JSON.parse(read("packages/connector-example/package.json")).exports).toEqual({ "./adapters": "./src/adapters/example-connector.ts" });
    const variants = read("packages/connector-example/src/adapters/violating-connectors.ts").match(/^export function create\w+Connector\(\)/gm) ?? [];
    expect(variants).toHaveLength(8);
  });

  it("chapter 7 lists the optional `credentials` of an instance and says the slots are asked for before the factory is called", () => {
    const seven = chapter(docText, 7);
    expect(seven).toContain(
      "| `connectorInstances` | 시작할 때의 인스턴스(`id`, `kind`, `config`와 선택 항목 `credentials`). `credentials`는 그 인스턴스가 필요로 하는 자격 증명의 칸 이름 목록이고 값이 아니다(8장) |",
    );
    expect(seven).toContain(
      "- 칸을 선언한 인스턴스는 만드는 함수를 부르기 **전에** 칸마다 값이 있는지 먼저 묻는다. 하나라도 없거나 저장소를 쓸 수 없으면 수집기 객체를 만들지 않고 그 인스턴스를 사유와 함께 `unavailable`로 둔다(8장).",
    );
    expect(seven).toContain("원 시스템이 자격 증명을 거부해 `credential-rejected`가 된 인스턴스는 한 시간마다의 재점검이 건너뛴다.");
    expect(seven).toContain("- 칸을 선언한 인스턴스의 자격 증명은 화면에서 넣고, 수집기는 `initialize`의 접근자로 읽는다. 포크가 `site/` 밖의 화면을 고치지 않는다(8장).");
  });

  it("chapter 11 has a row for what is still missing of the credential path, and none that says the path is missing", () => {
    const eleven = chapter(docText, 11);
    const rows = eleven.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| 항목 "));
    const firsts = rows.map((l) => l.split("|")[1]?.trim());
    for (const row of [
      "수집기가 자격 증명 값을 저장소에 되쓰는 길",
      "화면에서 여러 줄 자격 증명을 넣는 일",
      "등록에서 빠진 인스턴스의 자격 증명을 한 번에 정리하는 화면",
      "Windows의 OS 보호(DPAPI)와 실제 원 시스템에서의 자격 증명 확인",
    ]) {
      expect(firsts, row).toContain(row);
    }
    expect(eleven).not.toContain("수집기에 비밀 값을 건네는 통로");
    expect(eleven).toContain("한 줄, 8192자 이하만 받는다. 코드가 넣은 값의 줄바꿈은 화면이 알 수 없다(8장)");
    expect(eleven).toContain("site-setup의 S28·S29가 배포처에서 확인한다(8장)");
  });
});

describe("docs.connector-sdk (I06): ownership.md and the ADR (I06-R25)", () => {
  const lines = ownership.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## 3. "));
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  const three = rest.slice(0, end < 0 ? undefined : end).join("\n");

  it("ownership.md section 3 says credentials are not kept under site/, the fork declares slots and the screen and the store are the public repository's", () => {
    expect(three).toContain(
      "수집기가 원 시스템에 낼 자격 증명은 `site/`에 두지 않는다. 포크는 필요한 칸의 이름을 등록의 인스턴스 정의(`credentials`)에 선언하고 수집기가 `initialize`의 접근자로 읽게 할 뿐이고, 값은 앱의 출처 화면에서 사용자가 넣어 OS가 보호하는 저장소에만 남는다. 값을 넣는 화면과 저장소는 공용 저장소의 것이라 포크는 화면을 고치지 않는다.",
    );
    expect(three).toContain("[ADR 0019](adr/0019-connector-credentials.md)");
    expect(ownership).toContain("자격 증명이 필요하면 칸의 선언과 접근자로 읽기.");
  });

  it("ADR 0019 exists with its title and state, is in both indexes, and ADR 0010 and 0016 point to it", () => {
    const adr = read("docs/adr/0019-connector-credentials.md");
    expect(adr).toContain("# ADR 0019: 수집기 자격 증명은 V01의 비밀 값 저장소에 두고 접근자로 건넨다");
    expect(adr).toContain("상태: **잠정 — 배포처 검증 대기**");
    expect(read("docs/adr/README.md")).toContain("| [0019](0019-connector-credentials.md) |");
    expect(docsIndex).toContain("수집기 자격 증명은 ADR 0019와 S28·S29");
    expect(read("docs/adr/0010-encryption-at-rest.md")).toContain("[ADR 0019](0019-connector-credentials.md)");
    expect(read("docs/adr/0016-connector-sdk-v2.md")).toContain("[ADR 0019](0019-connector-credentials.md)");
    expect(docText).toContain("adr/0019-connector-credentials.md");
    expect(read("docs/site-setup.md")).toContain("adr/0019-connector-credentials.md");
  });

  it("the ADR points to the chapter, the checklist and the spec, names its ten decisions, and carries the way the value goes in the same words", () => {
    const adr = read("docs/adr/0019-connector-credentials.md");
    for (const ref of ["../specs/2026-11-22-I06-connector-credentials.md", "../connector-sdk.md", "../site-setup.md", "0010-encryption-at-rest.md", "0016-connector-sdk-v2.md", "0018-fork-registration-at-build-time.md"]) {
      expect(adr, ref).toContain(ref);
    }
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) expect(adr).toContain(`\n${n}. **`);
    expect(adr).not.toContain("\n11. **");
    expect(adr).toContain("값이 지나는 길은 둘뿐이다. \"화면 입력 → 셸의 저장소\"와 \"셸 → 백엔드 프로세스 → 수집기\"다.");
    // the public surface T01 asked the ADR to name
    for (const name of ["CONNECTOR_CREDENTIAL_MESSAGE", "onInitialize", "isConnectorCredentialError", "HEALTH_REASON_CREDENTIAL_REJECTED", "instance-credentials-invalid", "credential-unusable"]) {
      expect(adr, name).toContain(name);
    }
    expect(read("packages/contracts/src/connector.ts")).toContain('export const CONNECTOR_CREDENTIAL_MESSAGE = "connector credential unusable";');
    expect(read("packages/testkit/src/scripted-connector.ts")).toContain("onInitialize");
  });
});
