// I05-C3 ③ `workspace.typecheck-projects` (I05-R3, R25): the type check runner looks at the repository's own
// project and, when they exist, the composition package and the collector packages of a fork. The root is an
// argument, so each shape of the `site/` folder is a temporary root and the real checkout's own shape never
// changes the result.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { typecheckProjects } from "./typecheck.ts";

const REAL_ROOT = resolve(import.meta.dirname, "../..");
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pki-typecheck-"));
  write(
    "pnpm-workspace.yaml",
    "packages:\n  - backend\n  - site/composition\n  - site/connectors/*\n",
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(rel: string, text: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}
const project = (dir: string) => {
  write(`${dir}/package.json`, JSON.stringify({ name: `x-${dir}` }));
  write(`${dir}/tsconfig.json`, "{}");
};

describe("workspace.typecheck-projects", () => {
  it("is the root project alone where `site/` holds only the notice", () => {
    write("site/README.md", "notice");
    expect(typecheckProjects(root)).toEqual(["."]);
  });

  it("is the root project alone where only the folder `site/connectors` exists, empty", () => {
    mkdirSync(join(root, "site/connectors"), { recursive: true });
    expect(typecheckProjects(root)).toEqual(["."]);
  });

  it("adds the composition package and every collector package of a fork-shaped tree, in order", () => {
    project("site/composition");
    project("site/connectors/b");
    project("site/connectors/a");
    expect(typecheckProjects(root)).toEqual([
      ".",
      "site/composition",
      "site/connectors/a",
      "site/connectors/b",
    ]);
  });

  it("looks at a fork package only if it has a tsconfig.json", () => {
    write("site/connectors/a/package.json", JSON.stringify({ name: "a" }));
    project("site/connectors/b");
    expect(typecheckProjects(root)).toEqual([".", "site/connectors/b"]);
  });

  it("does not add a public package: the root tsconfig.json lists those", () => {
    project("backend");
    expect(typecheckProjects(root)).toEqual(["."]);
  });

  it("is used by the root script, and the public tsconfig.json names no fork project", () => {
    const scripts = (
      JSON.parse(readFileSync(join(REAL_ROOT, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts["typecheck"]).toBe("node tooling/workspace/typecheck.ts");
    const references = (
      JSON.parse(readFileSync(join(REAL_ROOT, "tsconfig.json"), "utf8")) as {
        references: { path: string }[];
      }
    ).references;
    expect(references.filter((r) => r.path.startsWith("site"))).toEqual([]);
  });
});
