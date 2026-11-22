// I07-T02 (I07-R2, I07-C2 ② ③): the instance scopes cannot be moved by an argument, and the code that
// reads them looks at no ambient input. ② the production build's argument parsing refuses what it does
// not know, `--connector-scopes` included. ③ is a check of letters (it cannot see another way to read
// a file; the guarantee is boot.connector-scopes-decoys): the reading module does not use the file
// system, `process.env`, `process.argv`, `process.cwd` or `import.meta.url`, and no product code of the
// five roots names the range file.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { shellOptions as production } from "./shell-options.production.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const PRODUCT_ROOTS = [
  "backend/src",
  "apps/desktop/src",
  "knowledge-engine/src",
  "storage/src",
  "providers/src",
];

/** The files under `dir` that are product code: not a test, not a declaration of a test double. */
function productFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : productFiles(path);
    return /\.(?:ts|tsx|js|mjs|cjs)$/.test(name) && !/\.(?:test|e2e)\.[tj]sx?$/.test(name)
      ? [path]
      : [];
  });
}

describe("② the production build's arguments", () => {
  it.each([
    ["--connector-scopes", "/synthetic/scopes.json"],
    ["--connector-scopes=/synthetic/scopes.json"],
    ["--scopes", "/synthetic/scopes.json"],
    ["--unknown-switch", "x"],
  ])("refuses %s", (...args) => {
    expect(() => production(["--origin", "app://pki", ...args])).toThrow();
  });
});

describe("③ the reading module and the product code", () => {
  it("backend/src/connector-scopes.ts uses no file system, environment, argument, cwd or module location", () => {
    const text = readFileSync(join(ROOT, "backend/src/connector-scopes.ts"), "utf8");
    const code = text
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/node:fs|"fs"|node:path|node:os|node:url|node:process/);
    for (const forbidden of ["process.env", "process.argv", "process.cwd", "import.meta"]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
    // the file-reading names of I01-T06 are gone
    for (const gone of ["CONNECTOR_SCOPES_FILE", "loadConnectorScopes", "readFileSync"]) {
      expect(code, gone).not.toContain(gone);
    }
    expect(code).not.toMatch(/\bCONNECTOR_SCOPES\b/);
    expect(code).not.toContain("unreadable");
  });

  it("no product code of the five roots names `connector-scopes.json`", () => {
    const named = PRODUCT_ROOTS.flatMap((root) => productFiles(join(ROOT, root))).filter((file) =>
      readFileSync(file, "utf8").includes("connector-scopes.json"),
    );
    expect(named.map((f) => f.slice(ROOT.length + 1))).toEqual([]);
  });

  it("the scan reaches product files (it is not vacuous)", () => {
    const files = PRODUCT_ROOTS.flatMap((root) => productFiles(join(ROOT, root))).map((f) =>
      f.slice(ROOT.length + 1),
    );
    expect(files).toContain("backend/src/connector-scopes.ts");
    expect(files).toContain("storage/src/migrations.ts");
    expect(files.some((f) => f.endsWith(".test.ts"))).toBe(false);
  });
});
