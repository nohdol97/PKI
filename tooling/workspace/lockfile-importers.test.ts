// I05-C3 ⑤ `workspace.lockfile-site-importers` (I05-R3): the lockfile's `importers` under `site/` are exactly
// the fork packages on disk (none in the public repository, where both sides are empty). A package with no
// dependencies still leaves an empty `site/connectors/x: {}` entry that `pnpm install` never removes (I05-T01),
// so a fork that deletes such a package deletes the entry by hand; the failure message says so.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { siteImporterProblems, siteImporters } from "./packages.ts";

const REAL_ROOT = resolve(import.meta.dirname, "../..");
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pki-lock-importers-"));
  write("pnpm-workspace.yaml", "packages:\n  - site/composition\n  - site/connectors/*\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(rel: string, text: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}
const onDisk = (dir: string) => write(`${dir}/package.json`, JSON.stringify({ name: dir }));
const lock = (...importers: string[]) =>
  `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    devDependencies: {}\n\n${importers
    .map((i) => `  ${i}:\n    dependencies: {}\n\n`)
    .join("")}packages:\n\n  site/not-an-importer: {}\n`;

describe("workspace.lockfile-site-importers", () => {
  it("reads the importers under site/, an empty entry included, and not the lines of other sections", () => {
    const text = `${lock("site/composition", "packages/x")}`.replace(
      "  packages/x:\n    dependencies: {}\n",
      "  site/connectors/e: {}\n  packages/x:\n    dependencies: {}\n",
    );
    expect(siteImporters(text)).toEqual(["site/composition", "site/connectors/e"]);
  });

  it("passes with none on either side: the public repository", () => {
    expect(siteImporterProblems(lock(), root)).toEqual([]);
  });

  it("passes when the importers are the fork packages on disk, an empty entry too", () => {
    onDisk("site/composition");
    onDisk("site/connectors/x");
    const text = lock("site/composition").replace(
      "packages:",
      "  site/connectors/x: {}\n\npackages:",
    );
    expect(siteImporterProblems(text, root)).toEqual([]);
  });

  it("fails an importer whose package is gone from disk, and says to delete the entry", () => {
    onDisk("site/composition");
    expect(siteImporterProblems(lock("site/composition", "site/connectors/gone"), root)).toEqual([
      "pnpm-lock.yaml lists site/connectors/gone but no such package is on disk: delete that importer entry (pnpm install does not remove an empty one)",
    ]);
  });

  it("fails a fork package on disk that the lockfile does not list, and says to run pnpm install", () => {
    onDisk("site/composition");
    onDisk("site/connectors/x");
    expect(siteImporterProblems(lock("site/composition"), root)).toEqual([
      "site/connectors/x is on disk but pnpm-lock.yaml has no importer for it: run pnpm install",
    ]);
  });

  it("is not moved by a public importer", () => {
    expect(siteImporterProblems(lock("packages/x"), root)).toEqual([]);
  });

  it("holds for the real checkout's lockfile", () => {
    expect(
      siteImporterProblems(readFileSync(join(REAL_ROOT, "pnpm-lock.yaml"), "utf8"), REAL_ROOT),
    ).toEqual([]);
  });
});
