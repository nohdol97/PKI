// I05-C1 ② ③ `site.no-public-reference` (I05-R4, R20): the letters `@pki-site/` appear in no public workspace
// package (source, tests, package.json, tsconfig.json), and no public package outside the example's own
// folder names `@pki/site-example` as a dependency, a tsconfig reference or an import, export or import()
// specifier. This file lives under tooling/, one of the places that may know the fork's name. The root is
// an argument: the real checkout and temporary roots are read by the same function.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publicReferenceProblems } from "./packages.ts";

const REAL_ROOT = resolve(import.meta.dirname, "../..");
// spelled in pieces: this file is not a workspace package, but the fixture text reads clearer so
const FORK = ["@pki-site", "/composition"].join("");
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pki-public-refs-"));
  write("pnpm-workspace.yaml", "packages:\n  - backend\n  - packages/*\n  - site/composition\n");
  write("backend/package.json", "{}");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(rel: string, text: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

describe("site.no-public-reference", () => {
  it("finds the fork's name in a public package's source, test, package.json and tsconfig.json", () => {
    write("backend/src/a.ts", `import "${FORK}";\n`);
    write("backend/src/a.test.ts", `const n = "${FORK}";\n`);
    write("packages/p/package.json", JSON.stringify({ dependencies: { [FORK]: "workspace:*" } }));
    write("packages/p/tsconfig.json", `{ "paths": "${FORK}" }`);
    expect(publicReferenceProblems(root).sort()).toEqual([
      "backend/src/a.test.ts names @pki-site/",
      "backend/src/a.ts names @pki-site/",
      "packages/p/package.json names @pki-site/",
      "packages/p/tsconfig.json names @pki-site/",
    ]);
  });

  it("does not read the fork's own folder, node_modules, dist or a folder outside the workspace", () => {
    write("site/composition/src/registration.ts", `import "${FORK}";\n`);
    write("backend/node_modules/x/index.js", `"${FORK}"`);
    write("backend/dist/a.d.ts", `"${FORK}"`);
    write("tooling/a.ts", `"${FORK}"`);
    expect(publicReferenceProblems(root)).toEqual([]);
  });

  it.each([
    ["an import", 'import { r } from "@pki/site-example";'],
    ["a re-export", 'export { r } from "@pki/site-example";'],
    ["a dynamic import", 'const m = await import("@pki/site-example");'],
    ["a deep import", 'import "@pki/site-example/src/registration.ts";'],
  ])("finds %s of the example package in another public package", (_name, code) => {
    write("backend/src/a.ts", `${code}\n`);
    expect(publicReferenceProblems(root)).toEqual(["backend/src/a.ts names @pki/site-example"]);
  });

  it("finds the example package as a dependency or a tsconfig reference of another package", () => {
    write(
      "backend/package.json",
      JSON.stringify({ devDependencies: { "@pki/site-example": "workspace:*" } }),
    );
    write("packages/p/package.json", "{}");
    write(
      "packages/p/tsconfig.json",
      JSON.stringify({ references: [{ path: "../site-example" }] }),
    );
    expect(publicReferenceProblems(root).sort()).toEqual([
      "backend/package.json names @pki/site-example",
      "packages/p/tsconfig.json references ../site-example",
    ]);
  });

  it("lets the example package name itself, and a path that only points at its entry", () => {
    write("packages/site-example/package.json", JSON.stringify({ name: "@pki/site-example" }));
    write("packages/site-example/src/a.ts", 'import "@pki/site-example";\n');
    write("backend/src/a.test.ts", 'const entry = "packages/site-example/src/shell.ts";\n');
    expect(publicReferenceProblems(root)).toEqual([]);
  });

  it("finds the fork's name in the example package's own folder too: only the example's name is its own to use", () => {
    write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    write("packages/site-example/package.json", JSON.stringify({ name: "@pki/site-example" }));
    write("packages/site-example/src/a.ts", `import "${FORK}";\n`);
    expect(publicReferenceProblems(root)).toEqual([
      "packages/site-example/src/a.ts names @pki-site/",
    ]);
  });

  it("holds in the real checkout", () => {
    expect(publicReferenceProblems(REAL_ROOT)).toEqual([]);
  });
});
