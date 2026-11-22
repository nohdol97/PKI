import { defineConfig } from "@playwright/test";

// `*.e2e.{ts,tsx}` files. The browser project runs them all except the shell's own;
// the electron project (V01-T06) runs the same screens file inside the shell plus the
// shell's tests, after building the screens the shell serves.
export default defineConfig<{ target: "browser" | "electron" }>({
  projects: [
    {
      name: "browser",
      testMatch: "**/*.e2e.{ts,tsx}",
      // the test-build-only seed entry is a script run by evidence.e2e.ts, not a test
      testIgnore: ["apps/desktop/**", "backend/src/v02-seed.e2e.ts"],
    },
    { name: "build-web", testMatch: "apps/desktop/e2e/build-web.setup.ts" },
    {
      name: "electron",
      testMatch: [
        "apps/web/e2e/screens.e2e.ts",
        "apps/web/e2e/provider-settings.e2e.ts",
        "apps/web/e2e/evidence.e2e.ts",
        "apps/web/e2e/degraded.e2e.ts",
        "apps/desktop/e2e/**/*.e2e.{ts,tsx}",
      ],
      dependencies: ["build-web"],
      use: { target: "electron" },
    },
  ],
});
