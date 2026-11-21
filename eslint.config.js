import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";
import moduleBoundary from "./tooling/eslint/module-boundary.js";

export default defineConfig(
  {
    ignores: [
      "**/node_modules/**",
      "eval/**",
      "verification/**",
      "test-results/**",
      "playwright-report/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.strict,
  {
    languageOptions: { globals: globals.node },
    plugins: { pki: { rules: { "module-boundary": moduleBoundary } } },
    rules: { "pki/module-boundary": "error" },
  },
  prettier,
);
