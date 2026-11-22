// Builds the production app folder the artifact tests check and launch (V01-T15):
// the same command as a release (README), so what is tested is what R04 packages.
import { test } from "@playwright/test";
import { REPO_ROOT } from "../build/bundle.ts";
import { pnpm } from "../build/pnpm.ts";

test("build the production app folder", () => {
  test.setTimeout(300_000);
  pnpm(["--filter", "@pki/desktop", "build"], REPO_ROOT);
});
