// I01-R28 `connectors.public-only`: the public repository holds no real mail,
// messenger or wiki client. The script files of the Connector paths (SCAN_ROOTS,
// EXTRA_FILES) import only what the allow-list names, and use no dynamic
// import(), no require, no other module loader (process.getBuiltinModule,
// process.binding, process.dlopen) and no network global. Those names are
// refused as an identifier in any position and as a whole string literal (a
// key, an element access, an argument such as Reflect.get(globalThis, "fetch")). Filtering by an allow-list, not by
// names, also refuses an SDK package nobody listed. site/ belongs to the fork
// (ownership.md 3) and is not read, except that the placeholder files the public
// repository ships there exist and are not scripts.
// The repository root is a parameter: the tests run the check on a temporary copy.
// Decisions the spec left open: I01 spec "T09가 넘기는 것".
// Known gaps (review catches them; this stops a client brought in by mistake, not
// hidden code): a name assembled at run time (globalThis["fe" + "tch"], a
// template with a substitution), eval and new Function, sockets or device files
// opened through the allowed node:fs. A symbolic link inside a root is not
// followed: it is a finding.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import ts from "typescript";

/** Folders whose script files are inspected, relative to the repository root. */
export const SCAN_ROOTS = [
  "backend/src/adapters",
  "packages/connector-example/src",
  "packages/connector-sdk/src",
] as const;

/**
 * Packages not on main yet (connector-sdk, I01-T05; connector-example landed
 * with I01-T08 and left the list): skipped while the package folder
 * is absent. Once the folder exists the root is inspected and the entry itself
 * is a finding: the PR that lands the package removes its entry, and from then
 * on a missing root fails.
 */
export const OPTIONAL_PACKAGES: readonly string[] = ["packages/connector-sdk"];

/**
 * Files outside the roots that a root's file reads by a relative path, inspected
 * under the same list. jsonl-lines.ts: the JSONL parsing until I01-T05 moves it
 * to @pki/connector-sdk; unused, the entry fails and is to be removed.
 */
export const EXTRA_FILES = ["backend/src/jsonl-lines.ts"] as const;

/** The files the public repository ships under site/. */
export const SITE_PLACEHOLDERS = ["site/README.md"] as const;

const ALLOWED_IMPORTS = new Set([
  "@pki/contracts",
  "@pki/connector-sdk",
  "zod",
  "node:crypto",
  "node:fs",
  "node:fs/promises",
  "node:path",
]);
const TEST_ONLY_IMPORTS = new Set(["@pki/testkit", "vitest"]);
const TEST_FILE = /\.test\.tsx?$/;
const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
  ".ts": ts.ScriptKind.TS,
  ".mts": ts.ScriptKind.TS,
  ".cts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".js": ts.ScriptKind.JS,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX,
};
const NETWORK_GLOBALS = new Set(["fetch", "XMLHttpRequest", "WebSocket"]);
const REQUIRE = "require";
/** process.getBuiltinModule, process.binding, process.dlopen: a module with no import or require. */
const MODULE_LOADERS = new Set(["getBuiltinModule", "binding", "dlopen"]);

export type FindingCode =
  | "import-not-allowed"
  | "dynamic-import"
  | "require"
  | "module-loader"
  | "network-global"
  | "missing-root"
  | "optional-package-present"
  | "symlink"
  | "unused-extra-file"
  | "placeholder-missing"
  | "placeholder-is-script";

export interface Finding {
  /** Relative to the repository root, with forward slashes. */
  file: string;
  line: number;
  code: FindingCode;
  detail: string;
}

/** Lower-cased: Windows and macOS resolve `./m.ts` to a file named `m.TS`. */
const scriptExtension = (path: string): string => extname(path).toLowerCase();
const isScript = (path: string): boolean => Object.hasOwn(SCRIPT_KINDS, scriptExtension(path));
const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();
const isDirectory = (path: string): boolean => existsSync(path) && statSync(path).isDirectory();
const inside = (dir: string, path: string): boolean => {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/** The script files under `dir` (absolute), sorted. */
function scriptsIn(dir: string): string[] {
  if (!isDirectory(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && isScript(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/** The symbolic links under `dir` (absolute), to a file or a folder; none is followed. */
function symlinksIn(dir: string): string[] {
  if (!isDirectory(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isSymbolicLink())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

interface Target {
  /** Absolute. */
  path: string;
  /** The root the file is under (absolute); undefined for an extra file. */
  scanRoot: string | undefined;
}

/** Every file the check parses: the one list both the check and its liveness report read. */
function targets(root: string): Target[] {
  return [
    ...SCAN_ROOTS.flatMap((scanRoot) => {
      const dir = join(root, scanRoot);
      return scriptsIn(dir).map((path): Target => ({ path, scanRoot: dir }));
    }),
    ...EXTRA_FILES.map((file): Target => ({ path: join(root, file), scanRoot: undefined })).filter(
      (target) => isFile(target.path),
    ),
  ];
}

/** The script files the check reads in `repoRoot`, relative to it. */
export function inspectedFiles(repoRoot: string): string[] {
  const root = resolve(repoRoot);
  return targets(root).map((target) => relative(root, target.path).split(sep).join(posix.sep));
}

/** The placeholder files exist, are plain files and are not scripts; nothing else under site/ is read. */
export function checkPlaceholders(
  repoRoot: string,
  placeholders: readonly string[] = SITE_PLACEHOLDERS,
): Finding[] {
  return placeholders.flatMap((file): Finding[] => {
    const path = join(resolve(repoRoot), file);
    const finding = (code: FindingCode, detail = ""): Finding[] => [
      { file, line: 1, code, detail },
    ];
    if (!isFile(path)) return finding("placeholder-missing");
    if (isScript(path)) return finding("placeholder-is-script", extname(path));
    if (readFileSync(path, "utf8").startsWith("#!")) return finding("placeholder-is-script", "#!");
    return [];
  });
}

/** The module a declaration names, for every form that takes a string specifier. */
function specifierOf(node: ts.Node): ts.Expression | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    return node.moduleReference.expression;
  }
  return undefined;
}

export function checkPublicOnly(repoRoot: string): Finding[] {
  const root = resolve(repoRoot);
  const findings: Finding[] = [];
  const extras = EXTRA_FILES.map((file) => join(root, file));
  const usedExtras = new Set<string>();

  const inspect = (path: string, scanRoot: string | undefined): void => {
    const file = relative(root, path).split(sep).join(posix.sep);
    const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      SCRIPT_KINDS[scriptExtension(path)],
    );
    const report = (node: ts.Node, code: FindingCode, detail: string): void => {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      findings.push({ file, line, code, detail });
    };
    const allowed = (specifier: string): boolean => {
      if (ALLOWED_IMPORTS.has(specifier)) return true;
      if (TEST_ONLY_IMPORTS.has(specifier)) return TEST_FILE.test(path);
      if (!/^\.\.?(\/|$)/.test(specifier)) return false;
      const target = resolve(path, "..", specifier);
      if (scanRoot !== undefined && extras.includes(target)) {
        usedExtras.add(target);
        return true;
      }
      return scanRoot !== undefined && inside(scanRoot, target);
    };
    const named = (node: ts.Node, name: string): void => {
      if (name === REQUIRE) report(node, "require", name);
      else if (MODULE_LOADERS.has(name)) report(node, "module-loader", name);
      else if (NETWORK_GLOBALS.has(name)) report(node, "network-global", name);
    };
    const visit = (node: ts.Node): void => {
      const specifier = specifierOf(node);
      if (specifier) {
        const text = ts.isStringLiteralLike(specifier) ? specifier.text : specifier.getText(source);
        if (!allowed(text)) report(specifier, "import-not-allowed", text);
      }
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        report(node.moduleReference, "require", REQUIRE);
      }
      const dynamic =
        ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (dynamic || ts.isImportTypeNode(node)) report(node, "dynamic-import", "import()");
      // a whole string literal too: a key, an element access, an argument
      if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) named(node, node.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  };

  const files = targets(root);
  for (const scanRoot of SCAN_ROOTS) {
    const dir = join(root, scanRoot);
    const pkg = OPTIONAL_PACKAGES.find((optional) => scanRoot.startsWith(`${optional}/`));
    const landed = pkg !== undefined && existsSync(join(root, pkg));
    if (landed) {
      findings.push({ file: pkg, line: 1, code: "optional-package-present", detail: "" });
    }
    const empty = !files.some((target) => target.scanRoot === dir);
    if (empty && (pkg === undefined || landed)) {
      findings.push({ file: scanRoot, line: 1, code: "missing-root", detail: "" });
    }
    for (const link of symlinksIn(dir)) {
      const file = relative(root, link).split(sep).join(posix.sep);
      findings.push({ file, line: 1, code: "symlink", detail: "" });
    }
  }
  for (const target of files) inspect(target.path, target.scanRoot);
  for (const [i, extra] of extras.entries()) {
    if (!usedExtras.has(extra) || !isFile(extra)) {
      findings.push({
        file: EXTRA_FILES[i] as string,
        line: 1,
        code: "unused-extra-file",
        detail: "",
      });
    }
  }
  findings.push(...checkPlaceholders(root));
  return findings;
}
