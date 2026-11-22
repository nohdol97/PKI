// I05-C3 ③ `workspace.typecheck-projects` (I05-R3, R25): the type check runner looks at the repository's own
// project and, when they exist, the composition package and the collector packages of a fork. The root is an
// argument, so each shape of the `site/` folder is a temporary root and the real checkout's own shape never
// changes the result.
import { spawnSync } from "node:child_process";
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

  it("fails, naming the package, for a fork package with no tsconfig.json: it is never left out silently", () => {
    write("site/connectors/a/package.json", JSON.stringify({ name: "a" }));
    project("site/connectors/b");
    expect(() => typecheckProjects(root)).toThrow(
      "site/connectors/a has no tsconfig.json: add one (the type check would leave it out)",
    );
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

describe("the runner's exit status (C-F1)", () => {
  const RUNNER = join(REAL_ROOT, "tooling/workspace/typecheck.ts");
  const run = () =>
    spawnSync(process.execPath, [RUNNER, root], { encoding: "utf8", cwd: root, timeout: 120_000 });
  const forkProject = (source: string) => {
    write("tsconfig.json", '{ "compilerOptions": { "noEmit": true }, "include": ["root.ts"] }');
    write("root.ts", "export {};\n");
    write("site/composition/package.json", JSON.stringify({ name: "@pki-site/composition" }));
    write(
      "site/composition/tsconfig.json",
      '{ "compilerOptions": { "noEmit": true }, "include": ["src"] }',
    );
    write("site/composition/src/a.ts", source);
  };

  it("passes tsc's failure through: a fork project with a type error gives a non-zero status and names the file", () => {
    forkProject('export const bad: number = "x";\n');
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("site/composition/src/a.ts");
  }, 130_000);

  it("a clean fork project gives 0", () => {
    forkProject("export const good: number = 1;\n");
    expect(run().status).toBe(0);
  }, 130_000);

  it("a fork package with no tsconfig.json fails with the message, not a stack", () => {
    write("tsconfig.json", '{ "files": [] }');
    write("site/composition/package.json", "{}");
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("site/composition has no tsconfig.json");
    expect(result.stderr).not.toContain("    at ");
  }, 130_000);
});
