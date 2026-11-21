// The shell serves the built screens (apps/web/dist), so the Electron E2E builds them
// first: the same build the browser E2E serves through the Vite dev server.
import { test } from "@playwright/test";
import { execFileSync } from "node:child_process";

test("build the screens", () => {
  test.setTimeout(120_000);
  execFileSync("pnpm", ["--filter", "@pki/web", "build"], { stdio: "inherit" });
});
