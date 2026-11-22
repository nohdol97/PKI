// I05-T05 review F2: ESLint 10 picks the nearest config file for each linted file, so a fork's own
// `site/eslint.config.js` would replace the root config for `site/**` (the boundary rule and
// `noInlineConfig` with it) while `pnpm lint` still exited 0. The root `lint` script therefore names the root
// config with `-c`. Held two ways: the script's text, and the behaviour on a temporary tree that has a nested
// config (a stand-in rule, `no-debugger`, so the tree needs none of the repository's modules).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const ESLINT = join(repoRoot, "node_modules/eslint/bin/eslint.js");
const root = mkdtempSync(join(tmpdir(), "pki-nested-config-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
writeFileSync(join(root, "package.json"), "{}");
writeFileSync(
  join(root, "eslint.config.js"),
  'export default [{ rules: { "no-debugger": "error" } }, { files: ["site/**"], linterOptions: { noInlineConfig: true } }];\n',
);
mkdirSync(join(root, "site"));
writeFileSync(join(root, "site/eslint.config.js"), "export default [];\n");
writeFileSync(join(root, "site/x.js"), "// eslint-disable-next-line no-debugger\ndebugger;\n");

const lint = (args: string[]) =>
  spawnSync(process.execPath, [ESLINT, ...args, "site/x.js"], { cwd: root, encoding: "utf8" });

describe("a nested ESLint config under site/ cannot replace the root rules", () => {
  it("the root script names the root config", () => {
    const script = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).scripts.lint;
    expect(script).toBe("eslint -c eslint.config.js . && prettier --check .");
  });

  it("run the way the script runs (-c), the root rule still reports in a file whose inline disable is ignored", () => {
    const run = lint(["-c", "eslint.config.js"]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("no-debugger");
  });

  it("without -c the nested config wins and nothing is reported (why the flag is there)", () => {
    const run = lint([]);
    expect(run.status).toBe(0);
  });
});
