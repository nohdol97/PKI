import { defineConfig } from "vitest/config";

export default defineConfig({
  // The build kind the bundler writes into the code (providers/src/build-kind.ts):
  // everything the test runner builds is a test build (V01-R10). On import.meta,
  // not a global: Vitest also assigns plain-identifier defines to globalThis.
  define: { "import.meta.PKI_BUILD_KIND": JSON.stringify("test") },
  test: {
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "eval/**", "verification/**"],
  },
});
