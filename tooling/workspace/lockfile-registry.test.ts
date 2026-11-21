// I02A-C12 / R21: every dependency comes from the npm registry (no tarball or git
// address, so a mirror can serve it), the document-normalize package pins exact
// versions, and no install script is newly allowed.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

/**
 * Lockfile lines that mean "not the registry": resolution by URL, git or a local
 * tarball. `link:` (a workspace package) is local by design and not matched.
 */
export function nonRegistryResolutions(lockfile: string): string[] {
  return lockfile
    .split("\n")
    .filter(
      (line) =>
        /^\s+(tarball|repo|commit|directory):\s/.test(line) ||
        /\bresolution:\s*\{[^}]*(tarball|repo|commit|type):/.test(line) ||
        /^\s+(version|specifier):\s+['"]?(git\+|git:|github:|https?:|file:|[\w.-]+\/[\w.-]+#)/.test(
          line,
        ),
    )
    .map((line) => line.trim());
}

describe("lockfile registry", () => {
  const lockfile = read("pnpm-lock.yaml");

  it("resolves nothing from a tarball, git or local address", () => {
    expect(nonRegistryResolutions(lockfile)).toEqual([]);
  });

  it("the check catches each kind of address (positive control)", () => {
    const bad = [
      "      version: https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz",
      "      specifier: git+https://github.com/x/y.git",
      "    resolution: {tarball: https://example.test/a.tgz}",
      "    resolution: {type: git, repo: https://example.test/a.git, commit: abc}",
      "      version: github:user/repo#abc123",
      "      version: file:../local",
    ];
    for (const line of bad) expect(nonRegistryResolutions(line), line).toHaveLength(1);
    expect(nonRegistryResolutions("    resolution: {integrity: sha512-abc}")).toEqual([]);
    expect(nonRegistryResolutions("      version: 4.3.2")).toEqual([]);
    expect(nonRegistryResolutions("        version: link:../../packages/contracts")).toEqual([]);
  });
});

describe("document-normalize dependencies", () => {
  const pkg = JSON.parse(read("packages/document-normalize/package.json")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const all = { ...pkg.dependencies, ...pkg.devDependencies };

  it("pins every dependency to an exact version", () => {
    const loose = Object.entries(all).filter(([, v]) => !/^\d+\.\d+\.\d+$/.test(v));
    expect(loose).toEqual([]);
  });

  it("declares the parsers the I02A spec chose", () => {
    expect(Object.keys(pkg.dependencies)).toEqual(
      expect.arrayContaining([
        "unpdf",
        "mammoth",
        "read-excel-file",
        "parse5",
        "mdast-util-from-markdown",
        "csv-parse",
        "yauzl",
        "fflate",
      ]),
    );
  });
});

describe("allowBuilds", () => {
  it("is the set that existed before this slice: no new install scripts", () => {
    const keys = read("pnpm-workspace.yaml")
      .split("\n")
      .flatMap((l) => /^ {2}([\w@/.-]+):\s*(true|false)\s*$/.exec(l)?.[1] ?? []);
    expect(keys.sort()).toEqual(["better-sqlite3", "electron", "onnxruntime-node", "protobufjs"]);
  });
});
