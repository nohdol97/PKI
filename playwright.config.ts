import { defineConfig } from "@playwright/test";

// Browser and Electron E2E files (`*.e2e.ts`) arrive with the screens (V01-T05, T06).
export default defineConfig({
  testMatch: "**/*.e2e.ts",
});
