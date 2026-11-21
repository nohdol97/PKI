import { defineConfig } from "@playwright/test";

// Browser E2E (V01-T05) and, from T06, Electron E2E files: `*.e2e.{ts,tsx}`.
export default defineConfig({
  testMatch: "**/*.e2e.{ts,tsx}",
});
