// V01-R19 (spec "T17이 넘기는 것" 5): the product README is the source of commands.
// Every `pnpm --filter <package> <script>` it gives runs a script that package has,
// every root `pnpm <script>` it gives is a root script, and every package script is
// given somewhere a user reads: the README or docs/site-setup.md (the site commands).
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const siteSetup = readFileSync(join(ROOT, "docs/site-setup.md"), "utf8");

interface Manifest {
  name: string;
  scripts?: Record<string, string>;
}
const read = (dir: string) =>
  JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")) as Manifest;

/** The workspace packages (pnpm-workspace.yaml's globs: one level, or a folder itself). */
function packages(): Manifest[] {
  const globs = [...readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8").matchAll(/^ {2}- (.+)$/gm)]
    .map((m) => (m[1] ?? "").trim());
  return globs.flatMap((glob) => {
    if (!glob.endsWith("/*")) return existsSync(join(ROOT, glob, "package.json")) ? [read(glob)] : [];
    const parent = glob.slice(0, -2);
    return readdirSync(join(ROOT, parent))
      .filter((d) => existsSync(join(ROOT, parent, d, "package.json")))
      .map((d) => read(join(parent, d)));
  });
}

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
  for (const m of all) {
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

  it("fails for a root script missing from the README", () => {
    const dropped = readme.replaceAll("`pnpm e2e`", "");
    expect(commandProblems(dropped, siteSetup, all, root)).toContain("not documented: pnpm e2e");
  });
});
