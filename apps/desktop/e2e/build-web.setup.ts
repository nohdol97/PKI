// The shell serves the built screens (apps/web/dist), so the Electron E2E builds them
// first: the same build the browser E2E serves through the Vite dev server.
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

test("build the screens", () => {
  test.setTimeout(120_000);
  execFileSync("pnpm", ["--filter", "@pki/web", "build"], { stdio: "inherit" });
  // I02B-C30: the dev-only typed-path input is compiled out of the built screens
  const assets = "apps/web/dist/assets";
  const js = readdirSync(assets).filter((name) => name.endsWith(".js"));
  expect(js.length).toBeGreaterThan(0);
  for (const name of js)
    expect(readFileSync(`${assets}/${name}`, "utf8")).not.toContain("폴더 경로(개발용)");
});
