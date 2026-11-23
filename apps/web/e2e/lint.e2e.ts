// K02-C3c (R15) in the browser: on the 점검 screen the user sees a finding (work past its target date), opens
// its evidence in the same source view the Wiki and Home use, closes it, and finds it closed with one false
// positive counted after leaving the screen and coming back. One browser flow; the Electron shell adds no
// assertion of its own. The data directory is seeded before start (backend/src/k02-seed.e2e.ts: the V02 "plain"
// set, a Task past its date and one re-review).
import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { webConfig } from "../dev/dev-server.ts";
import { freePort, ROOT } from "./v02-screens.ts";

const SEED = join(ROOT, "backend/src/k02-seed.e2e.ts");
const TASK = "예약 점검 업무";
const QUOTE = "미리내 프로젝트의 완료 목표는 2026-12-05입니다";

let dir: string;
let vite: ViteDevServer;
let port: number;

test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pki-e2e-lint-"));
  const dataDir = join(dir, "data");
  const seeded = spawnSync(process.execPath, [SEED, "--data-dir", dataDir], {
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

test("lint.e2e: see a finding, open its evidence, close it, and find it closed with one false positive", async ({
  page,
}) => {
  const nav = page.getByRole("navigation");
  const openLint = async () => {
    await nav.getByRole("button", { name: "점검" }).click();
    await expect(page.getByRole("heading", { name: "점검", level: 1 })).toBeVisible();
  };
  await page.goto(`http://127.0.0.1:${port}`);
  await openLint();

  // the finding is listed under its rule, open
  const list = page.getByRole("list", { name: "목표일이 지난 업무" });
  const item = list.getByRole("listitem").filter({ hasText: TASK });
  await expect(item).toHaveCount(1);
  await expect(item).toContainText("열림");

  // choosing the row opens the finding in the detail pane to its right (UI01-C8)
  await item.getByRole("button").click();
  await expect(item.getByRole("button")).toHaveAttribute("aria-current", "true");
  const detail = page.getByRole("region", { name: "발견 상세" });
  const [listBox, detailBox] = [await list.boundingBox(), await detail.boundingBox()];
  expect(detailBox?.x).toBeGreaterThanOrEqual((listBox?.x ?? 0) + (listBox?.width ?? 0));

  // its evidence opens in the source view with the quote marked
  await detail.getByRole("button", { name: /근거 보기/ }).click();
  await expect(page.getByRole("region", { name: "원본 보기" }).locator("mark")).toHaveText(QUOTE);

  // closing it counts one false positive
  await detail.getByRole("button", { name: `닫기: ${TASK}` }).click();
  await expect(item).toContainText("닫음");
  await expect(page.getByText(/오탐 1/)).toBeVisible();

  // after leaving the screen and coming back it is still closed, and still one false positive
  await nav.getByRole("button", { name: "홈" }).click();
  await openLint();
  await expect(list.getByRole("listitem").filter({ hasText: TASK })).toContainText("닫음");
  await expect(page.getByText(/오탐 1/)).toBeVisible();
});
