// V01-C4 `gate.inputs` (V01-R10): the build kind is named by one module only (and
// the bundler configuration), and the decision code (the execution gate, the
// Broker and the modules that supply the gate's inputs) touches no environment,
// no global object and no "is this installed" check of the runtime.
import { ESLint, RuleTester } from "eslint";
import { join, resolve } from "node:path";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import gateInputs, { BUILD_KIND_MODULE, BUNDLER_CONFIGS, DECISION_MODULES } from "./gate-inputs.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const at = (rel: string) => join(repoRoot, rel);
const RULE_ID = "pki/gate-inputs";
// spelled in pieces: this file may not name the build value either
const NAME = ["PKI", "BUILD", "KIND"].join("_");
const OLD = `__${NAME}__`;

const buildKind = at(BUILD_KIND_MODULE);
const gate = at("providers/src/execution-gate.ts");
const broker = at("providers/src/broker.ts");
const elsewhere = at("backend/src/composition.ts");
const otherProviders = at("providers/src/egress-policy.ts");
const viteConfig = at("vitest.config.ts");

RuleTester.describe = describe;
RuleTester.it = it;
const ruleTester = new RuleTester({ languageOptions: { parser: tseslint.parser } });

const invalid = (code: string, filename: string, messageId: string, count = 1) => ({
  code,
  filename,
  errors: Array.from({ length: count }, () => ({ messageId })),
});

describe("gate-inputs rule", () => {
  it("covers the gate, the Broker and the modules that supply the gate's inputs", () => {
    expect([...DECISION_MODULES].sort()).toEqual(
      [
        "providers/src/broker.ts",
        "providers/src/build-kind.ts",
        "providers/src/cli-profiles.ts",
        "providers/src/execution-gate.ts",
        "providers/src/synthetic-manifest.ts",
        "providers/src/user-actions.ts",
        "providers/src/verified-cli.ts",
      ].sort(),
    );
    expect([...BUNDLER_CONFIGS]).toEqual(["vitest.config.ts"]);
  });

  ruleTester.run("gate-inputs", gateInputs, {
    valid: [
      // the one module that reads the bundler's value
      {
        code: `const k = typeof import.meta.${NAME} === "string" ? import.meta.${NAME} : undefined;`,
        filename: buildKind,
      },
      {
        code: `declare global { interface ImportMeta { readonly ${NAME}?: string } }`,
        filename: buildKind,
      },
      // the bundler configuration names it to write it
      {
        code: `export default { define: { "import.meta.${NAME}": '"test"' } };`,
        filename: viteConfig,
      },
      // decision code may use the OS, its own inputs and import.meta.url
      { code: 'import { platform } from "node:os"; platform();', filename: gate },
      { code: "const p = input.process; const q = { process: 1, globalThis: 2 };", filename: gate },
      { code: 'import { BUILD_KIND } from "./build-kind.ts";', filename: gate },
      { code: "const here = import.meta.url;", filename: broker },
      // other modules are not decision code
      {
        code: "const u = process.env.HOME; Reflect.get(globalThis, 'x');",
        filename: otherProviders,
      },
      { code: "app.isPackaged;", filename: elsewhere },
    ],
    invalid: [
      // any mention of the name outside build-kind.ts and the bundler configs
      ...[elsewhere, gate, broker, otherProviders, at("backend/src/cli-gate.test.ts")].map((f) =>
        invalid(`const k = import.meta.${NAME};`, f, "buildKindRead"),
      ),
      invalid(`const k = ${OLD};`, elsewhere, "buildKindRead"),
      invalid(`globalThis.${OLD} = "development";`, at("backend/src/dev.ts"), "buildKindRead"),
      invalid(
        `Object.defineProperty(globalThis, "${OLD}", { value: "development" });`,
        at("backend/src/dev.ts"),
        "buildKindRead",
      ),
      invalid(`globalThis["${OLD}"];`, elsewhere, "buildKindRead"),
      invalid(`const o = { ${NAME}: 1 };`, elsewhere, "buildKindRead"),
      invalid(`const o = { "${NAME}": 1 };`, elsewhere, "buildKindRead"),
      invalid(`process.env.${NAME} = "development";`, elsewhere, "buildKindRead"),
      invalid(`const s = \`x \${y} ${NAME}\`;`, elsewhere, "buildKindRead"),
      // a define in some other file is not a bundler configuration
      invalid(
        `export default { define: { "import.meta.${NAME}": '"development"' } };`,
        elsewhere,
        "buildKindRead",
      ),
      // decision code: environment, process, global objects, loaders
      ...[
        gate,
        broker,
        buildKind,
        at("providers/src/verified-cli.ts"),
        at("providers/src/cli-profiles.ts"),
        at("providers/src/synthetic-manifest.ts"),
        at("providers/src/user-actions.ts"),
      ].map((f) => invalid("const v = process.env.PKI_DEV;", f, "runtimeInput")),
      invalid('const v = process["env"];', gate, "runtimeInput"),
      invalid("const { env } = process;", gate, "runtimeInput"),
      invalid("const p = process; p.env.X;", gate, "runtimeInput"),
      invalid("globalThis.process.env.X;", gate, "runtimeInput"),
      invalid('globalThis["process"].env;', broker, "runtimeInput"),
      invalid('globalThis["pro" + "cess"].env;', broker, "runtimeInput"),
      invalid("(0, globalThis).process.env;", broker, "runtimeInput"),
      invalid('Reflect.get(globalThis, "process");', gate, "runtimeInput", 2),
      invalid('Reflect.get(o, "x");', gate, "runtimeInput"),
      invalid("global.process.versions.electron;", broker, "runtimeInput"),
      invalid("self.process; window.process;", broker, "runtimeInput", 2),
      invalid('const g = Function("return process")();', gate, "runtimeInput"),
      invalid('const g = new Function("return this")();', gate, "runtimeInput"),
      invalid('eval("process");', gate, "runtimeInput"),
      invalid("const v = import.meta.env.MODE;", gate, "runtimeInput"),
      invalid('import { env } from "node:process";', gate, "runtimeInput"),
      invalid('import process2 from "process";', gate, "runtimeInput"),
      invalid('export { env } from "node:process";', gate, "runtimeInput"),
      invalid('export * from "node:process";', gate, "runtimeInput"),
      invalid('const m = await import("node:process");', gate, "runtimeInput"),
      invalid('const m = require("process");', gate, "runtimeInput"),
      invalid('import { app } from "electron";', gate, "runtimeInput"),
      invalid(
        'import { createRequire } from "node:module"; createRequire(import.meta.url)("node:process");',
        gate,
        "runtimeInput",
        2,
      ),
      invalid('import vm from "node:vm";', gate, "runtimeInput"),
      invalid("if (app.isPackaged) run();", gate, "installedCheck"),
      invalid('if (app["isPackaged"]) run();', gate, "installedCheck"),
      invalid("const { isPackaged } = app;", gate, "installedCheck"),
      invalid("const d = shellInfo.defaultApp;", broker, "installedCheck"),
      invalid("const r = info.resourcesPath;", broker, "installedCheck"),
    ],
  });
});

describe("repository lint config enforces gate-inputs", () => {
  async function lint(code: string, rel: string) {
    const eslint = new ESLint({ cwd: repoRoot });
    const [result] = await eslint.lintText(code, { filePath: at(rel) });
    return (result?.messages ?? []).filter((m) => m.ruleId === RULE_ID);
  }

  it("fails the execution gate reading an environment variable", async () => {
    const messages = await lint(
      "export const on = process.env.PKI_DEV === '1';\n",
      "providers/src/execution-gate.ts",
    );
    expect(messages.map((m) => [m.messageId, m.severity])).toEqual([["runtimeInput", 2]]);
  });

  it("fails the Broker asking whether it is installed", async () => {
    const messages = await lint(
      "declare const app: { isPackaged: boolean };\nexport const dev = !app.isPackaged;\n",
      "providers/src/broker.ts",
    );
    expect(messages.map((m) => m.messageId)).toEqual(["installedCheck"]);
  });

  it("fails setting the build value at run time from an entry point", async () => {
    const messages = await lint(
      `(globalThis as Record<string, unknown>)["${OLD}"] = "development";\nexport {};\n`,
      "backend/src/dev.ts",
    );
    expect(messages.map((m) => m.messageId)).toEqual(["buildKindRead"]);
  });

  it("fails reading the build value outside build-kind.ts", async () => {
    const messages = await lint(
      `export const k = import.meta.${NAME};\n`,
      "backend/src/composition.ts",
    );
    expect(messages.map((m) => m.messageId)).toEqual(["buildKindRead"]);
  });
});
