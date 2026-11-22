// I05-C2 `backend-entry` (I05-R2, R25): which file starts the backend. The root is an argument, so the three
// shapes are temporary roots and the real checkout (with or without a fork's composition package) never
// changes the answer. The production layout knows only the bundled entry, and the shell's bundle text has no
// `site/composition`.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backendEntry } from "./backend-entry.ts";

let root: string;
beforeEach(() => void (root = mkdtempSync(join(tmpdir(), "pki-backend-entry-"))));
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(rel: string, text = "") {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

describe("backend-entry", () => {
  it("① is the public entry where there is no composition package, notice or connectors folder or not", () => {
    expect(backendEntry(root)).toBe(join(root, "backend/src/shell.ts"));
    write("site/README.md", "notice");
    mkdirSync(join(root, "site/connectors/x"), { recursive: true });
    expect(backendEntry(root)).toBe(join(root, "backend/src/shell.ts"));
  });

  it("② is the composition package's entry where its package.json exists", () => {
    write("site/composition/package.json", "{}");
    write("site/composition/src/shell.ts");
    expect(backendEntry(root)).toBe(join(root, "site/composition/src/shell.ts"));
  });

  it("③ fails with the path where the composition package has no entry, and does not fall back to the public one", () => {
    write("site/composition/package.json", "{}");
    expect(() => backendEntry(root)).toThrow(join(root, "site/composition/src/shell.ts"));
  });

  it("the package.json decides: a bare site/composition folder, even with an entry file, is not a composition package", () => {
    write("site/composition/src/shell.ts");
    expect(backendEntry(root)).toBe(join(root, "backend/src/shell.ts"));
  });

  it("the production layout names only the bundled entry; its code has no composition lookup", () => {
    const production = readFileSync(resolve(import.meta.dirname, "layout.production.ts"), "utf8");
    expect(production).toContain("./backend/shell.js");
    expect(production).not.toContain("site/composition");
    expect(production).not.toContain("backend-entry");
  });

  it("the build picks the backend entry through the function too", () => {
    const build = readFileSync(resolve(import.meta.dirname, "../build/build.ts"), "utf8");
    expect(build).toContain("backendEntry(REPO_ROOT)");
    expect(build).not.toContain('"backend/src/shell.ts"');
  });

  it("the source layout picks its entry through the function, for the repository root", () => {
    const layout = readFileSync(resolve(import.meta.dirname, "layout.ts"), "utf8");
    expect(layout).toContain("backendEntry(");
    expect(layout).not.toContain("backend/src/shell.ts");
  });
});
