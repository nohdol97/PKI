import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";
import gateInputs from "./tooling/eslint/gate-inputs.js";
import moduleBoundary from "./tooling/eslint/module-boundary.js";

export default defineConfig(
  {
    ignores: [
      "**/node_modules/**",
      "eval/**",
      "verification/**",
      "test-results/**",
      "playwright-report/**",
      "**/dist/**",
      // scratch input that bundle.test.ts writes and removes while other tests run
      "apps/desktop/build/.bundle-test-*/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.strict,
  {
    languageOptions: { globals: globals.node },
    plugins: { pki: { rules: { "module-boundary": moduleBoundary, "gate-inputs": gateInputs } } },
    rules: { "pki/module-boundary": "error", "pki/gate-inputs": "error" },
  },
  {
    // a deployment fork's files (and the example the forks copy) cannot switch a rule off or re-configure
    // it from a comment: `// eslint-disable pki/module-boundary` would open the boundary (I05-T04 review D2)
    files: ["site/**", "packages/site-example/**"],
    linterOptions: { noInlineConfig: true },
  },
  prettier,
);
