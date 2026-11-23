import { defineConfig } from "@playwright/test";

// `*.e2e.{ts,tsx}` files. The browser project runs them all except the shell's own;
// the electron project (V01-T06) runs the main flows and the shell's tests inside the shell,
// after building the screens the shell serves. Files that only check one screen against backend
// state (degraded, activity) run in the browser only: the shell adds no assertion of its own there. The artifact project
// checks and launches the production build (V01-T15).
export default defineConfig<{ target: "browser" | "electron" }>({
  projects: [
    {
      name: "browser",
      testMatch: "**/*.e2e.{ts,tsx}",
      // the backend's test-build-only entries (seed, Provider double) are scripts, not
      // tests: named one by one, so a future backend E2E is not dropped silently
      testIgnore: [
        "apps/desktop/**",
        "backend/src/v02-seed.e2e.ts",
        "backend/src/k02-seed.e2e.ts",
        "backend/src/data-dir-check.e2e.ts",
        "backend/src/v02-double.e2e.ts",
        "backend/src/v02-double.hook.e2e.ts",
        "backend/src/v02-shell.e2e.ts",
        "backend/src/swap-double.e2e.ts",
        "backend/src/swap-double.hook.e2e.ts",
      ],
    },
    { name: "build-web", testMatch: "apps/desktop/e2e/build-web.setup.ts" },
    {
      name: "electron",
      testMatch: [
        "apps/web/e2e/screens.e2e.ts",
        "apps/web/e2e/provider-settings.e2e.ts",
        "apps/web/e2e/evidence.e2e.ts",
        "apps/web/e2e/v02-flow.e2e.ts",
        "apps/web/e2e/local-files.e2e.ts",
        "apps/desktop/e2e/**/*.e2e.{ts,tsx}",
      ],
      dependencies: ["build-web"],
      use: { target: "electron" },
    },
    // V01-T15: the production build's app folder, built first, then checked and launched
    { name: "build-artifact", testMatch: "apps/desktop/artifact/build-artifact.setup.ts" },
    {
      name: "artifact",
      testMatch: "apps/desktop/artifact/**/*.e2e.ts",
      dependencies: ["build-artifact"],
    },
  ],
});
