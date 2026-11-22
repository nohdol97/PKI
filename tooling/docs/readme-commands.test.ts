// V01-R19 (spec "T17이 넘기는 것" 5): the product README is the source of commands.
// Every `pnpm --filter <package> <script>` it gives runs a script that package has,
// every root `pnpm <script>` it gives is a root script, and every package script is
// given somewhere a user reads: the README or docs/site-setup.md (the site commands).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { workspaceDirs } from "../workspace/packages.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const siteSetup = readFileSync(join(ROOT, "docs/site-setup.md"), "utf8");

interface Manifest {
  name: string;
  scripts?: Record<string, string>;
  /** The package's folder relative to the root; set for workspace packages. */
  dir?: string;
}
const read = (dir: string, root = ROOT) =>
  JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")) as Manifest;

/**
 * The workspace packages (pnpm-workspace.yaml's globs; a glob whose parent folder is absent is skipped,
 * which is the public repository's case for the fork's two lines, I05-R3). `root` is an argument (I05-R25).
 */
function packages(root = ROOT): Manifest[] {
  return workspaceDirs(root).map((dir) => ({ ...read(dir, root), dir }));
}

/** A fork's package documents its commands in the fork's own documents (I05-R3), not in the public ones. */
const isForkPackage = (m: Manifest) => m.dir?.startsWith("site/") ?? false;

const FILTERED = /pnpm --filter (@pki\/[a-z0-9-]+) ([a-z0-9:-]+)/g;
/** `line` as a whole command: the script name may not continue (`build` is not `build:fixtures`). */
const mentions = (text: string, line: string) =>
  new RegExp(`${line.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?![a-z0-9:-])`).test(text);
const ROOT_COMMAND = /`pnpm ([a-z0-9:-]+)`/g;

function commandProblems(text: string, docs: string, all: Manifest[], root: Manifest) {
  const problems: string[] = [];
  const byName = new Map(all.map((m) => [m.name, m]));
  for (const [, name, script] of text.matchAll(FILTERED)) {
    const scripts = byName.get(name ?? "")?.scripts ?? {};
    if (!Object.hasOwn(scripts, script ?? "")) {
      problems.push(`README: ${name} has no script ${script}`);
    }
  }
  for (const [, script] of text.matchAll(ROOT_COMMAND)) {
    if (script === "install" || script === "exec") continue;
    if (!Object.hasOwn(root.scripts ?? {}, script ?? "")) problems.push(`README: no root script ${script}`);
  }
  for (const m of all.filter((m) => !isForkPackage(m))) {
    for (const script of Object.keys(m.scripts ?? {})) {
      const line = `pnpm --filter ${m.name} ${script}`;
      if (!mentions(text, line) && !mentions(docs, line)) problems.push(`not documented: ${line}`);
    }
  }
  for (const script of Object.keys(root.scripts ?? {})) {
    if (!text.includes(`\`pnpm ${script}\``)) problems.push(`not documented: pnpm ${script}`);
  }
  return problems;
}

describe("README commands (V01-R19)", () => {
  const all = packages();
  const root = read(".");

  it("finds the workspace packages", () => {
    expect(all.map((m) => m.name)).toEqual(expect.arrayContaining(["@pki/backend", "@pki/web"]));
  });

  it("every command exists and every script is documented", () => {
    expect(commandProblems(readme, siteSetup, all, root)).toEqual([]);
  });

  it("fails for a command naming a script the package does not have", () => {
    const stale = `${readme}\n- \`pnpm --filter @pki/backend serve\`\n`;
    expect(commandProblems(stale, siteSetup, all, root)).toContain(
      "README: @pki/backend has no script serve",
    );
  });

  it("fails for a package script given nowhere", () => {
    const dropped = readme.replaceAll("pnpm --filter @pki/backend dev", "");
    expect(commandProblems(dropped, siteSetup, all, root)).toContain(
      "not documented: pnpm --filter @pki/backend dev",
    );
  });

  it("fails for a script documented only as the prefix of a longer one", () => {
    const withBuild = all.map((m) =>
      m.name === "@pki/document-normalize"
        ? { ...m, scripts: { ...m.scripts, build: "node build.ts" } }
        : m,
    );
    // README gives `build:fixtures` only: that line does not document `build`
    expect(commandProblems(readme, siteSetup, withBuild, root)).toContain(
      "not documented: pnpm --filter @pki/document-normalize build",
    );
  });

  it("finds the example package, and fails for its script given nowhere (I05-C3 ②, C17)", () => {
    expect(all.map((m) => m.name)).toContain("@pki/site-example");
    const dropped = readme.replaceAll("pnpm --filter @pki/site-example site-check", "");
    expect(commandProblems(dropped, siteSetup, all, root)).toContain(
      "not documented: pnpm --filter @pki/site-example site-check",
    );
  });

  it("fails for a root script missing from the README", () => {
    const dropped = readme.replaceAll("`pnpm e2e`", "");
    expect(commandProblems(dropped, siteSetup, all, root)).toContain("not documented: pnpm e2e");
  });
});

describe("README commands on a temporary root (I05-C3 ②, C20 ②)", () => {
  const withRoot = (files: Record<string, string>, run: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "pki-readme-"));
    try {
      files["pnpm-workspace.yaml"] ??= "packages:\n  - backend\n  - site/composition\n  - site/connectors/*\n";
      for (const [rel, text] of Object.entries(files)) {
        mkdirSync(join(dir, rel, ".."), { recursive: true });
        writeFileSync(join(dir, rel), text);
      }
      run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const manifest = (name: string, scripts: Record<string, string>) =>
    JSON.stringify({ name, scripts });

  it("skips a glob whose parent folder is absent, with no exception", () => {
    withRoot({ "backend/package.json": manifest("@pki/backend", { dev: "x" }) }, (dir) => {
      expect(packages(dir).map((m) => m.name)).toEqual(["@pki/backend"]);
    });
  });

  it("does not count a fork package's script as missing from the public documents", () => {
    withRoot(
      {
        "backend/package.json": manifest("@pki/backend", { dev: "x" }),
        "site/composition/package.json": manifest("@pki-site/composition", { "site-check": "x" }),
        "site/connectors/x/package.json": manifest("@pki-site/connector-x", { "contract": "x" }),
      },
      (dir) => {
        const all = packages(dir);
        expect(all.map((m) => m.name)).toContain("@pki-site/composition");
        const doc = "`pnpm --filter @pki/backend dev`";
        expect(commandProblems(doc, "", all, { name: "pki" })).toEqual([]);
      },
    );
  });

  it("counts a public package's script as missing, a package next to a fork's included", () => {
    withRoot(
      {
        "backend/package.json": manifest("@pki/backend", { dev: "x" }),
        "site/composition/package.json": manifest("@pki-site/composition", { "site-check": "x" }),
      },
      (dir) => {
        expect(commandProblems("", "", packages(dir), { name: "pki" })).toEqual([
          "not documented: pnpm --filter @pki/backend dev",
        ]);
      },
    );
  });
});
