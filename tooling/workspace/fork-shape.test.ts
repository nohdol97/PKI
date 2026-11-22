// I05-C20 ② `fork-shape` (I05-R25): every piece of code whose behavior depends on what `site/` holds takes the
// repository root as an argument, and each is called here with three temporary roots: `site/` holding only the
// notice, `site/connectors` alone, and a fork-shaped tree (a composition package and a collector). The
// public checks pass in all three shapes and the fork's pieces appear only in the last, so the public suite
// gives the same result with or without a `site/` folder. Two more shapes (I07-C13) hold the scopes file's
// wrong places: `site/config/connector-scopes.json` with no composition package, and one inside the composition
// package; the build's judgment says `scopes-file-unbound` and `scopes-file-misplaced`. A last test type-checks the
// import of `../../config/connector-scopes.json` from a minimal composition package in a temporary root. The pieces outside tooling/ (`backendEntry`, the
// `site-check` guidance) are loaded in a child process by their paths: a test file may not import another package.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** The build's scopes judgment (apps/desktop/build/scopes-check.ts) for `root`, loaded by path as the other pieces are. */
function scopesVerdict(
  dir: string,
  modules: string[],
): { ok: boolean; code?: string; state?: string } {
  const judge = pathToFileURL(join(REPO, "apps/desktop/build/scopes-check.ts")).href;
  const entry = pathToFileURL(join(REPO, "apps/desktop/src/backend-entry.ts")).href;
  const script = `
    const { judgeConnectorScopes } = await import(${JSON.stringify(judge)});
    const { backendEntry } = await import(${JSON.stringify(entry)});
    const root = ${JSON.stringify(dir)};
    console.log(JSON.stringify(judgeConnectorScopes(root, backendEntry(root), ${JSON.stringify(modules)})));`;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }),
  ) as { ok: boolean; code?: string; state?: string };
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

describe("fork-shape: the scopes file's two wrong shapes and the type check of its import (I07-C13)", () => {
  it("④ a tree with site/config/connector-scopes.json and no composition package gives the public answer everywhere and the judgment's scopes-file-unbound", () => {
    write("site/config/connector-scopes.json", '{"inst-a":["scope-a"]}');
    expect(typecheckProjects(root)).toEqual(["."]);
    expect(workspaceDirs(root)).toEqual(["backend"]);
    expect(forkNameProblems(root)).toEqual([]);
    expect(siteImporterProblems(lock(), root)).toEqual([]);
    expect(publicReferenceProblems(root)).toEqual([]);
    expect(productPieces(root)).toEqual({
      entry: join(root, "backend/src/shell.ts"),
      guidance: null,
    });
    // the public bundle keeps no such file, so the file is there and not bound
    expect(scopesVerdict(root, ["backend/src/shell.ts"])).toMatchObject({
      ok: false,
      code: "scopes-file-unbound",
    });
  }, 60_000);

  it("⑤ a fork-shaped tree with config/connector-scopes.json inside the composition package gives the fork's answer everywhere and scopes-file-misplaced", () => {
    fork();
    write("site/composition/config/connector-scopes.json", '{"inst-a":["scope-a"]}');
    expect(typecheckProjects(root)).toEqual([".", "site/composition", "site/connectors/x"]);
    expect(workspaceDirs(root)).toEqual(["backend", "site/composition", "site/connectors/x"]);
    expect(forkNameProblems(root)).toEqual([]);
    expect(siteImporterProblems(lock("site/composition", "site/connectors/x"), root)).toEqual([]);
    expect(siteImporterProblems(lock(), root)).toHaveLength(2);
    expect(publicReferenceProblems(root)).toEqual([]);
    const pieces = productPieces(root);
    expect(pieces.entry).toBe(join(root, "site/composition/src/shell.ts"));
    expect(pieces.guidance).toContain("pnpm --filter @pki-site/composition site-check");
    expect(
      scopesVerdict(root, [
        "site/composition/src/shell.ts",
        "site/composition/config/connector-scopes.json",
      ]),
    ).toMatchObject({ ok: false, code: "scopes-file-misplaced" });
  }, 60_000);

  /** `tsc -b site/composition` in the temporary root: a package importing no @pki package, with the base's copy. */
  function typecheck(source: string): { status: number | null; out: string } {
    copyFileSync(join(REPO, "tsconfig.base.json"), join(root, "tsconfig.base.json"));
    write("site/composition/package.json", JSON.stringify({ name: "@pki-site/composition" }));
    write(
      "site/composition/tsconfig.json",
      JSON.stringify({ extends: "../../tsconfig.base.json", include: ["src"] }),
    );
    write("site/composition/src/registration.ts", source);
    const tsc = join(REPO, "node_modules/typescript/bin/tsc");
    const run = spawnSync(process.execPath, [tsc, "-b", "site/composition"], {
      cwd: root,
      encoding: "utf8",
    });
    return { status: run.status, out: run.stdout + run.stderr };
  }
  const IMPORT =
    'import connectorScopes from "../../config/connector-scopes.json" with { type: "json" };';
  const SCOPES = '{"inst-a":["scope-z","scope-a"],"inst-b":null}';

  it("③ a composition package that imports ../../config/connector-scopes.json passes the type check (the minimal shape, no types: node)", () => {
    write("site/config/connector-scopes.json", SCOPES);
    const run = typecheck(
      `${IMPORT}\nexport const registration: { connectorScopes?: unknown } = { connectorScopes };\n`,
    );
    expect(run.out).toBe("");
    expect(run.status).toBe(0);
  }, 60_000);

  it("③ the check holds something: a wrong use of the JSON's type, and a missing file, fail it", () => {
    write("site/config/connector-scopes.json", SCOPES);
    const wrong = typecheck(`${IMPORT}\nexport const n: number = connectorScopes["inst-a"];\n`);
    expect(wrong.status).not.toBe(0);
    expect(wrong.out).toContain("TS2322");
    rmSync(join(root, "site/config/connector-scopes.json"));
    const missing = typecheck(`${IMPORT}\nexport const registration = { connectorScopes };\n`);
    expect(missing.status).not.toBe(0);
    expect(missing.out).toContain("TS2307");
  }, 60_000);
});
