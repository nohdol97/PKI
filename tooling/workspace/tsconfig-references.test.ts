// Every `@pki/*` package a workspace package declares must also be a tsconfig
// project reference. Without it, incremental `tsc -b` (pnpm typecheck) does not
// rebuild the dependent when the dependency changes, and type drift passes.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

function workspaceDirs(): string[] {
  const globs = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")
    .split("\n")
    .flatMap((l) => /^\s+-\s+(\S+)/.exec(l)?.[1] ?? []);
  return globs
    .flatMap((g) =>
      g.endsWith("/*")
        ? readdirSync(join(root, g.slice(0, -2))).map((d) => join(g.slice(0, -2), d))
        : [g],
    )
    .filter((d) => existsSync(join(root, d, "package.json")));
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

function missingReferences(): string[] {
  const dirs = workspaceDirs();
  const dirOf = new Map(dirs.map((d) => [readJson(join(root, d, "package.json")).name, d]));
  return dirs.flatMap((dir) => {
    const pkg = readJson(join(root, dir, "package.json"));
    const declared = Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
    }).filter((n) => n.startsWith("@pki/"));
    const refs = new Set(
      (readJson(join(root, dir, "tsconfig.json")).references ?? []).map((r: { path: string }) =>
        relative(root, resolve(root, dir, r.path)),
      ),
    );
    return declared
      .filter((name) => !refs.has(dirOf.get(name) ?? name))
      .map((name) => `${dir} declares ${name} without a tsconfig reference`);
  });
}

describe("tsconfig project references", () => {
  it("finds the workspace packages", () => {
    expect(workspaceDirs()).toEqual(expect.arrayContaining(["storage", "packages/testkit"]));
  });

  it("references every declared @pki/* dependency", () => {
    expect(missingReferences()).toEqual([]);
  });
});
