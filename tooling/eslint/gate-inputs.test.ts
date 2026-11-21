// V01-C4 `gate.inputs` (V01-R10): the build kind is read by one module only, and the
// decision code (the execution gate, the Broker and what they read) touches no
// environment variable and no "is this installed" check of the runtime.
import { ESLint, RuleTester } from "eslint";
import { join, resolve } from "node:path";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import gateInputs, { BUILD_KIND_MODULE, DECISION_MODULES } from "./gate-inputs.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const at = (rel: string) => join(repoRoot, rel);
const RULE_ID = "pki/gate-inputs";

const buildKind = at(BUILD_KIND_MODULE);
const gate = at("providers/src/execution-gate.ts");
const broker = at("providers/src/broker.ts");
const elsewhere = at("backend/src/composition.ts");
const otherProviders = at("providers/src/egress-policy.ts");

RuleTester.describe = describe;
RuleTester.it = it;
const ruleTester = new RuleTester({ languageOptions: { parser: tseslint.parser } });

describe("gate-inputs rule", () => {
  it("covers the gate, the Broker and the modules they read", () => {
    expect([...DECISION_MODULES].sort()).toEqual(
      [
        "providers/src/broker.ts",
        "providers/src/build-kind.ts",
        "providers/src/cli-profiles.ts",
        "providers/src/execution-gate.ts",
        "providers/src/verified-cli.ts",
      ].sort(),
    );
  });

  ruleTester.run("gate-inputs", gateInputs, {
    valid: [
      // the one module that reads the bundler's value
      {
        code: "const k = typeof __PKI_BUILD_KIND__ === 'string' ? __PKI_BUILD_KIND__ : undefined;",
        filename: buildKind,
      },
      { code: "declare const __PKI_BUILD_KIND__: string | undefined;", filename: buildKind },
      // the bundler configuration names it as a key, which reads nothing
      {
        code: "export default { define: { __PKI_BUILD_KIND__: '\"test\"' } };",
        filename: at("vitest.config.ts"),
      },
      { code: "const o = { '__PKI_BUILD_KIND__': 1 }; o.__PKI_BUILD_KIND__;", filename: elsewhere },
      // decision code may use the OS and its own inputs
      { code: 'import { platform } from "node:os"; platform();', filename: gate },
      { code: "const p = input.process; const q = { process: 1 };", filename: gate },
      { code: 'import { BUILD_KIND } from "./build-kind.ts";', filename: gate },
      // other modules are not decision code
      { code: "const u = process.env.HOME;", filename: otherProviders },
      { code: "app.isPackaged;", filename: elsewhere },
    ],
    invalid: [
      ...[elsewhere, gate, broker, otherProviders, at("backend/src/cli-gate.test.ts")].map(
        (filename) => ({
          code: "const k = __PKI_BUILD_KIND__;",
          filename,
          errors: [{ messageId: "buildKindRead" }],
        }),
      ),
      {
        code: 'globalThis["__PKI_BUILD_KIND__"];',
        filename: elsewhere,
        errors: [{ messageId: "buildKindRead" }],
      },
      ...[
        gate,
        broker,
        buildKind,
        at("providers/src/verified-cli.ts"),
        at("providers/src/cli-profiles.ts"),
      ].map((filename) => ({
        code: "const v = process.env.PKI_BUILD_KIND;",
        filename,
        errors: [{ messageId: "runtimeInput" }],
      })),
      {
        code: 'const v = process["env"];',
        filename: gate,
        errors: [{ messageId: "runtimeInput" }],
      },
      { code: "const { env } = process;", filename: gate, errors: [{ messageId: "runtimeInput" }] },
      {
        code: "const p = process; p.env.X;",
        filename: gate,
        errors: [{ messageId: "runtimeInput" }],
      },
      {
        code: "globalThis.process.env.X;",
        filename: gate,
        errors: [{ messageId: "runtimeInput" }],
      },
      {
        code: 'globalThis["process"].env;',
        filename: broker,
        errors: [{ messageId: "runtimeInput" }],
      },
      {
        code: "global.process.versions.electron;",
        filename: broker,
        errors: [{ messageId: "runtimeInput" }],
      },
      {
        code: "const v = import.meta.env.MODE;",
        filename: gate,
        errors: [{ messageId: "runtimeInput" }],
      },
      {
        code: 'import { env } from "node:process";',
        filename: gate,
        errors: [{ messageId: "runtimeInput" }],
      },
      {
        code: 'import process2 from "process";',
        filename: gate,
        errors: [{ messageId: "runtimeInput" }],
      },
      {
        code: 'export { env } from "node:process";',
        filename: gate,
        errors: [{ messageId: "runtimeInput" }],
      },
      {
        code: 'const m = await import("node:process");',
        filename: gate,
        errors: [{ messageId: "runtimeInput" }],
      },
      {
        code: 'const m = require("process");',
        filename: gate,
        errors: [{ messageId: "runtimeInput" }],
      },
      {
        code: 'import { app } from "electron";',
        filename: gate,
        errors: [{ messageId: "runtimeInput" }],
      },
      {
        code: "if (app.isPackaged) run();",
        filename: gate,
        errors: [{ messageId: "installedCheck" }],
      },
      {
        code: 'if (app["isPackaged"]) run();',
        filename: gate,
        errors: [{ messageId: "installedCheck" }],
      },
      {
        code: "const { isPackaged } = app;",
        filename: gate,
        errors: [{ messageId: "installedCheck" }],
      },
      {
        code: "const d = shellInfo.defaultApp;",
        filename: broker,
        errors: [{ messageId: "installedCheck" }],
      },
      {
        code: "const r = info.resourcesPath;",
        filename: broker,
        errors: [{ messageId: "installedCheck" }],
      },
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

  it("fails reading the build value outside build-kind.ts", async () => {
    const messages = await lint(
      "declare const __PKI_BUILD_KIND__: string;\nexport const k = __PKI_BUILD_KIND__;\n",
      "backend/src/composition.ts",
    );
    expect(messages.map((m) => m.messageId)).toEqual(["buildKindRead", "buildKindRead"]);
  });
});
