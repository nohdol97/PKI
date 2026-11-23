// P03-C1d (R15) in the browser: on Home the user presses "관련 없음" on the Insight and it leaves the list; the
// "최근 피드백" list shows the line, and cancelling it there brings the Insight back. One browser flow; the
// Electron shell adds no assertion of its own. The data directory is seeded before start with the V02 "plain" set
// (one "의존 업무 지연" Insight) by the test-build-only seed entry (backend/src/v02-seed.e2e.ts).
import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { webConfig } from "../dev/dev-server.ts";
import { freePort, insightItems, ROOT } from "./v02-screens.ts";

const SEED = join(ROOT, "backend/src/v02-seed.e2e.ts");

let dir: string;
let vite: ViteDevServer;
let port: number;

test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pki-e2e-feedback-"));
  const dataDir = join(dir, "data");
  const seeded = spawnSync(process.execPath, [SEED, "--data-dir", dataDir, "--set", "plain"], {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
  });
  expect(seeded.status).toBe(0);
  writeFileSync(join(dir, "empty.jsonl"), "");
  port = await freePort();
  vite = await createServer({
    ...webConfig({ port, dataDir, fixtures: join(dir, "empty.jsonl") }),
    configFile: false,
    logLevel: "warn",
  });
  await vite.listen();
});
test.afterEach(async () => {
  await vite.close();
  rmSync(dir, { recursive: true, force: true });
});

test("feedback.e2e: mark an Insight irrelevant, see it leave Home, cancel the feedback and see it return", async ({
  page,
}) => {
  await page.goto(`http://127.0.0.1:${port}`);
  const insights = insightItems(page);
  await expect(insights).toHaveCount(1);

  await insights.getByRole("button", { name: /^관련 없음/ }).click();
  await expect(insights).toHaveCount(0);
  await expect(page.getByText("보여 줄 Insight가 없습니다.")).toBeVisible();

  const recent = page.getByRole("region", { name: "최근 피드백" });
  const line = recent.getByRole("listitem");
  await expect(line).toHaveCount(1);
  await expect(line).toContainText("관련 없음");

  await line.getByRole("button", { name: /^취소/ }).click();
  await expect(insights).toHaveCount(1);
  await expect(recent.getByText("최근 피드백이 없습니다.")).toBeVisible();
});
