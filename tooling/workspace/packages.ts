// What the workspace checks know about the repository's packages, with the repository root as an argument
// (I05-R25): the code here reads `site/` (a fork's packages) where it exists and finds nothing where it does
// not, so the public suite gives the same result with or without that folder. Only tooling/ and the documents
// may know the fork's name (`@pki-site/`, I05-R4).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const FORK_SCOPE = "@pki-site/";
const COMPOSITION_NAME = `${FORK_SCOPE}composition`;
const EXAMPLE_PACKAGE = "@pki/site-example";
const EXAMPLE_DIR = "packages/site-example";
/** Folders no check reads inside a package: installed code, build output and dot folders (tests' scratch input). */
const skipped = (name: string) =>
  name === "node_modules" || name === "dist" || name.startsWith(".");
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|json)$/;

const readJson = (path: string) =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
const isDir = (path: string) => existsSync(path) && statSync(path).isDirectory();

/** The lines of `pnpm-workspace.yaml`'s `packages:` list, quotes removed. */
export function workspaceGlobs(root: string): string[] {
  const globs: string[] = [];
  let inList = false;
  for (const line of readFileSync(join(root, "pnpm-workspace.yaml"), "utf8").split("\n")) {
    if (/^\S/.test(line)) inList = line.trim() === "packages:";
    else if (inList) {
      const glob = /^\s+-\s+(\S+)/.exec(line)?.[1];
      if (glob !== undefined) globs.push(glob.replace(/^(['"])(.*)\1$/, "$2"));
    }
  }
  return globs;
}

/** The workspace packages' folders relative to `root`; a glob whose parent folder is absent finds none. */
export function workspaceDirs(root: string): string[] {
  return workspaceGlobs(root)
    .flatMap((glob) => {
      if (!glob.endsWith("/*")) return [glob];
      const parent = glob.slice(0, -2);
      return isDir(join(root, parent))
        ? readdirSync(join(root, parent))
            .sort()
            .map((entry) => `${parent}/${entry}`)
        : [];
    })
    .filter((dir) => existsSync(join(root, dir, "package.json")));
}

/** A fork's package: its folder is under `site/`. */
export const isSiteDir = (dir: string): boolean => dir.startsWith("site/");

/** The names a fork's packages must have (I05-R4): the composition package and the collectors under `site/connectors`. */
export function forkNameProblems(root: string): string[] {
  return workspaceDirs(root)
    .filter(isSiteDir)
    .flatMap((dir) => {
      const name = readJson(join(root, dir, "package.json"))["name"];
      const shown = typeof name === "string" ? `is named ${name}` : "has no name";
      if (dir === "site/composition") {
        return name === COMPOSITION_NAME
          ? []
          : [`${dir} ${shown}: the composition package must be named ${COMPOSITION_NAME}`];
      }
      return typeof name === "string" && name.startsWith(FORK_SCOPE)
        ? []
        : [`${dir} ${shown}: a package under site/connectors must be named ${FORK_SCOPE}…`];
    });
}

/** The importers of a `pnpm-lock.yaml` that sit under `site/`, in the file's order. */
export function siteImporters(lockfile: string): string[] {
  const found: string[] = [];
  let inImporters = false;
  for (const line of lockfile.split("\n")) {
    if (/^\S/.test(line)) inImporters = line.trim() === "importers:";
    else if (inImporters) {
      const key = /^ {2}(\S+):/.exec(line)?.[1];
      if (key?.startsWith("site/")) found.push(key.replace(/^(['"])(.*)\1$/, "$2"));
    }
  }
  return found;
}

/**
 * The lockfile's importers under `site/` against the fork packages on disk (I05-R3, C3 ⑤). A package with no
 * dependencies keeps an empty importer that `pnpm install` does not remove (I05-T01), so the way out of a
 * leftover entry is to delete it by hand.
 */
export function siteImporterProblems(lockfile: string, root: string): string[] {
  const listed = new Set(siteImporters(lockfile));
  const onDisk = new Set(workspaceDirs(root).filter(isSiteDir));
  return [
    ...[...listed]
      .filter((dir) => !onDisk.has(dir))
      .map(
        (dir) =>
          `pnpm-lock.yaml lists ${dir} but no such package is on disk: delete that importer entry (pnpm install does not remove an empty one)`,
      ),
    ...[...onDisk]
      .filter((dir) => !listed.has(dir))
      .map(
        (dir) => `${dir} is on disk but pnpm-lock.yaml has no importer for it: run pnpm install`,
      ),
  ];
}

/** The files of a public package that count as its source: scripts and JSON, outside installed code and build output. */
function sourceFiles(root: string, dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return skipped(entry.name) ? [] : sourceFiles(root, path);
    return SOURCE_FILE.test(entry.name) ? [path] : [];
  });
}

const EXAMPLE_SPECIFIER = new RegExp(`["'\`]${EXAMPLE_PACKAGE}(?:/[^"'\`]*)?["'\`]`);

/**
 * Two rules about the public workspace packages (I05-C1 ② ③): none names the fork's scope, and none but the
 * example package itself names the example package (as a dependency, a tsconfig reference or an import,
 * export or import() specifier). A path string that points at the example's files is not a name.
 */
export function publicReferenceProblems(root: string): string[] {
  const problems: string[] = [];
  for (const dir of workspaceDirs(root).filter((d) => !isSiteDir(d))) {
    for (const file of sourceFiles(root, dir)) {
      const text = readFileSync(join(root, file), "utf8");
      if (text.includes(FORK_SCOPE)) problems.push(`${file} names ${FORK_SCOPE}`);
      if (dir === EXAMPLE_DIR) continue;
      if (EXAMPLE_SPECIFIER.test(text)) problems.push(`${file} names ${EXAMPLE_PACKAGE}`);
      if (file.endsWith("/tsconfig.json")) {
        const references = (readJson(join(root, file))["references"] ?? []) as { path: string }[];
        for (const { path } of references) {
          if (relative(root, join(root, dir, path)) === EXAMPLE_DIR) {
            problems.push(`${file} references ${path}`);
          }
        }
      }
    }
  }
  return problems;
}
