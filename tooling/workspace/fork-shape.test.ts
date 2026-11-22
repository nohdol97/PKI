// I05-C20 ② `fork-shape` (I05-R25): every piece of code whose behavior depends on what `site/` holds takes the
// repository root as an argument, and each is called here with three temporary roots: `site/` holding only the
// notice, `site/connectors` alone, and a fork-shaped tree (a composition package and a collector). The
// public checks pass in all three shapes and the fork's pieces appear only in the last, so the public suite
// gives the same result with or without a `site/` folder. The pieces outside tooling/ (`backendEntry`, the
// `site-check` guidance) are loaded in a child process by their paths: a test file may not import another package.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  forkNameProblems,
  publicReferenceProblems,
  siteImporterProblems,
  workspaceDirs,
} from "./packages.ts";
import { typecheckProjects } from "./typecheck.ts";

const REPO = resolve(import.meta.dirname, "../..");
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pki-fork-shape-"));
  write(
    "pnpm-workspace.yaml",
    "packages:\n  - backend\n  - site/composition\n  - site/connectors/*\n",
  );
  write("backend/package.json", JSON.stringify({ name: "@pki/backend" }));
  write("backend/tsconfig.json", "{}");
  write("backend/src/shell.ts", "");
  write("site/README.md", "notice");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(rel: string, text: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}
const fork = () => {
  write(
    "site/composition/package.json",
    JSON.stringify({ name: "@pki-site/composition", dependencies: { "@pki/backend": "x" } }),
  );
  write("site/composition/tsconfig.json", "{}");
  write("site/composition/src/shell.ts", "");
  write("site/connectors/x/package.json", JSON.stringify({ name: "@pki-site/connector-x" }));
  write("site/connectors/x/tsconfig.json", "{}");
};
const lock = (...importers: string[]) =>
  `importers:\n\n  backend: {}\n\n${importers.map((i) => `  ${i}: {}\n\n`).join("")}packages:\n`;

/** What the product's own pieces say about `dir` (backend-entry.ts, site-check-main.ts), by path in a child process. */
function productPieces(dir: string): { entry: string | string[]; guidance: string | null } {
  const entry = pathToFileURL(join(REPO, "apps/desktop/src/backend-entry.ts")).href;
  const check = pathToFileURL(join(REPO, "backend/src/site-check-main.ts")).href;
  const script = `
    const { backendEntry } = await import(${JSON.stringify(entry)});
    const { siteCheckGuidance } = await import(${JSON.stringify(check)});
    const root = ${JSON.stringify(dir)};
    let entry;
    try { entry = backendEntry(root); } catch (e) { entry = ["threw", String(e.message)]; }
    console.log(JSON.stringify({ entry, guidance: siteCheckGuidance(root) ?? null }));`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
  });
  return JSON.parse(out) as { entry: string | string[]; guidance: string | null };
}

describe("fork-shape: the same code on three shapes of site/", () => {
  it("a tree where `site/` holds only the notice is public in every piece", () => {
    expect(typecheckProjects(root)).toEqual(["."]);
    expect(workspaceDirs(root)).toEqual(["backend"]);
    expect(forkNameProblems(root)).toEqual([]);
    expect(siteImporterProblems(lock(), root)).toEqual([]);
    expect(publicReferenceProblems(root)).toEqual([]);
    expect(productPieces(root)).toEqual({
      entry: join(root, "backend/src/shell.ts"),
      guidance: null,
    });
  });

  it("a tree with `site/connectors` alone is public too", () => {
    mkdirSync(join(root, "site/connectors"), { recursive: true });
    expect(typecheckProjects(root)).toEqual(["."]);
    expect(workspaceDirs(root)).toEqual(["backend"]);
    expect(forkNameProblems(root)).toEqual([]);
    expect(siteImporterProblems(lock(), root)).toEqual([]);
    expect(productPieces(root)).toEqual({
      entry: join(root, "backend/src/shell.ts"),
      guidance: null,
    });
  });

  it("a fork-shaped tree gives the fork's answer in every piece", () => {
    fork();
    expect(typecheckProjects(root)).toEqual([".", "site/composition", "site/connectors/x"]);
    expect(workspaceDirs(root)).toEqual(["backend", "site/composition", "site/connectors/x"]);
    expect(forkNameProblems(root)).toEqual([]);
    expect(siteImporterProblems(lock("site/composition", "site/connectors/x"), root)).toEqual([]);
    expect(siteImporterProblems(lock(), root)).toHaveLength(2);
    expect(publicReferenceProblems(root)).toEqual([]);
    const pieces = productPieces(root);
    expect(pieces.entry).toBe(join(root, "site/composition/src/shell.ts"));
    expect(pieces.guidance).toContain("pnpm --filter @pki-site/composition site-check");
  });
});
