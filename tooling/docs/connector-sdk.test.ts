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
const isForkPath = (path: string) => FORK_FILES.has(path) || path.startsWith("site/");
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
  { token: "healthCheck", file: "backend/src/connectors.ts", holds: "(await connector.healthCheck()).state === " },
  { token: "ChangeSet", file: "packages/contracts/src/connector.ts", holds: "export type ChangeSet = " },
  { token: "cursorExpired", file: "packages/contracts/src/connector.ts", holds: "cursorExpired: z.boolean().optional()," },
  { token: "scope-change-content-mismatch", file: "packages/contracts/src/connector.ts", holds: '"scope-change-content-mismatch",' },
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
    expect(paths.filter((p) => !isForkPath(p) && !existsSync(resolve(repoRoot, p)))).toEqual([]);
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
    const missing = namedPaths(mutated, docsDir).filter(
      (p) => !isForkPath(p) && !existsSync(resolve(repoRoot, p)),
    );
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
    expect(code).toContain("instances.map(async ({ id, kind, config }): Promise<Entry> => {");
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

  it("no code gives a Connector a secret (chapter 8): initialize takes the config only", () => {
    expect(read("packages/contracts/src/connector.ts")).toContain("initialize(config: unknown, context?: ConnectorContext): Promise<void>;");
    expect(read("backend/src/connectors.ts")).toContain("await connector.initialize(config);");
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

  it("the file collector reads its path as given (chapter 9's open item)", () => {
    const collector = read("backend/src/adapters/jsonl-connector.ts");
    expect(collector).toContain("statSync(source.path)");
    expect(collector).not.toMatch(/realpath|symlink|lstat/i);
  });

  it("the screens draw no locator (chapter 11)", () => {
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
    expect(hits).toEqual([]);
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

  it("chapter 11 names each tracked gap by its issue number; the fork registration (#113) is built and is no row", () => {
    const eleven = chapter(docText, 11);
    for (const issue of ["#114", "#115", "#116", "#121"]) expect(eleven, issue).toContain(issue);
    expect(eleven).not.toContain("#113");
    expect(chapter(docText, 7)).not.toContain("#113");
    expect(chapter(docText, 7)).toContain("#121");
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
    for (const word of ["connector-scopes.json", "import 검사", "`site/`를 보지 않으므로", "현재의 예외", "#114", "#115"]) {
      expect(section(3), word).toContain(word);
    }
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
    expect(read("backend/src/connectors.ts")).toContain("await initializeConnector(create(), {});");
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
    expect(all.length).toBe(12);
    for (const name of all) expect(namesToken(seven, name), name).toBe(true);
    const stopping = [...(/const STOPPING_CODES = \[([^\]]*)\]/.exec(code)?.[1] ?? "").matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
    const rows = seven.split("\n").filter((l) => /^\| `[a-z-]+` \|/.test(l));
    const stoppingRows = rows.filter((l) => l.includes("**시작을 멈춘다**")).map((l) => /^\| `([a-z-]+)`/.exec(l)?.[1]);
    expect(stoppingRows).toEqual(stopping);
    expect(rows.length).toBe(10);
  });

  it("names the public kinds and the placeholders the registration cannot or may take, as the code lists them", () => {
    const kinds = read("backend/src/public-kinds.ts");
    expect(kinds).toContain('export const PUBLIC_CONNECTOR_KINDS: readonly string[] = ["jsonl-import", "test-fixtures"];');
    for (const name of ["PUBLIC_CONNECTOR_KINDS", "isPublicInstanceId", "`jsonl-import`", "`test-fixtures`", "`site-mail`", "`site-messenger`", "`site-wiki`"]) {
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
      "**`pnpm e2e`는 다르다. 공용 시험 다섯(산출물 시험 둘과 `v02-flow` 셋)은 지금 포크 모양에서 실패한다.** 공용 저장소의 I05-T06이 고친다.",
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

  it("warns against restoring a backup with a build that lacks a kind, and points to the issue that tracks it", () => {
    for (const sentence of [
      "### 수집기 종류를 뺀 빌드로 백업을 복원하지 않는다",
      "모르는 종류의 줄은 건너뛰면서도 적용 위치를 올린다.",
      "그 사이에 건너뛴 삭제는 다시 적용되지 않고 지운 자료가 다음 동기화에서 되돌아올 수 있다.",
      "고치는 일은 공용 저장소의 #121이 추적한다.",
    ]) {
      expect(seven, sentence).toContain(sentence);
    }
    expect(chapter(docText, 11)).toContain("(7장, #121)");
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

  it("leaves only the lockfile, the allowBuilds `false` lines, #114, #115 and the build values in the exception paragraph", () => {
    expect(exception.length).toBeGreaterThan(300);
    for (const word of ["`pnpm-lock.yaml`", "`allowBuilds`", "`false` 줄", "#114", "#115", "배포처 전송 규칙", "묶을 Provider", "검증된 CLI 조합 목록", "데이터 등급 목록"]) {
      expect(exception, word).toContain(word);
    }
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
    expect(docsIndex).toContain("결정 기록 17건(잠정 12, 확정 4, 미결 1.");
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
