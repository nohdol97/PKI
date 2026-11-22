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
  { token: "recheck", file: "backend/src/connectors.ts", holds: "async recheck(id) {" },
  { token: "healthCheck", file: "backend/src/connectors.ts", holds: "(await entry.connector.healthCheck()).state === " },
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
    expect(paths.filter((p) => !FORK_FILES.has(p) && !existsSync(resolve(repoRoot, p)))).toEqual([]);
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
      (p) => !FORK_FILES.has(p) && !existsSync(resolve(repoRoot, p)),
    );
    expect(docText).toContain("backend/src/composition.ts");
    expect(missing).toEqual(["backend/src/gone.ts"]);
  });
});

describe("docs.connector-sdk: what the text says is not built stays unbuilt", () => {
  it("the workspace lists no site/connectors entry (chapters 6, 7 and 11 say so)", () => {
    expect(read("pnpm-workspace.yaml")).not.toContain("site/");
  });

  it("no product code reads site/connectors (chapters 7 and 11 say so)", () => {
    const roots = ["backend/src", "apps/desktop/src", "knowledge-engine/src", "storage/src", "providers/src"];
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(resolve(repoRoot, dir), { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name) && !/\.test(-support)?\.tsx?$/.test(entry.name)) {
          if (read(path).includes("site/connectors")) hits.push(path);
        }
      }
    };
    roots.forEach(walk);
    expect(hits).toEqual([]);
  });

  it("the public repository holds nothing under site/ but its placeholder", () => {
    expect(readdirSync(resolve(repoRoot, "site"))).toEqual(["README.md"]);
  });

  it("the product's connector kinds are written in code the fork edits (chapter 7)", () => {
    const composition = read("backend/src/composition.ts");
    expect(composition).toContain('"site-mail": () => createSiteConnector("site-mail"),');
    expect(composition).toContain('"site-messenger": () => createSiteConnector("site-messenger"),');
    expect(composition).toContain('"site-wiki": () => createSiteConnector("site-wiki"),');
  });

  it("no code gives a Connector a secret (chapter 8): initialize takes the config only", () => {
    expect(read("packages/contracts/src/connector.ts")).toContain("initialize(config: unknown): Promise<void>;");
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

  it("fails when a guard's subject is built: a workspace entry would turn the first red", () => {
    expect(`${read("pnpm-workspace.yaml")}\n  - site/connectors/*\n`).toContain("site/");
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
    for (const word of ["connector-scopes.json", "import 검사", "`site/`를 보지 않으므로"]) {
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

  it("fails when ownership.md section 3 loses its pointer", () => {
    const mutated = ownership.replace(
      /(## 3\. [\s\S]*?)\(connector-sdk\.md\)/,
      "$1(connector-sdk-gone.md)",
    );
    expect(mutated).not.toBe(ownership);
    expect(mutated.split("## 3.")[1]).not.toContain("(connector-sdk.md)");
  });
});
