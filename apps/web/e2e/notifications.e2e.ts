// P02-C1c (R15, R16) in the browser: on the 알림 screen the user sees a card with the 추론 mark, the reason and the
// fact line, opens its evidence, and snoozes another card — it leaves the feed and the timeline says "다시 알림 예정";
// the daily summary shows the low-confidence line with its reason; and when a source is deleted in another tab the
// screen that was left open changes by itself, without a click. One browser flow; the shell adds no assertion of its
// own. The data directory is seeded before start (backend/src/p02-seed.e2e.ts).
import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { webConfig } from "../dev/dev-server.ts";
import { freePort, ROOT } from "./v02-screens.ts";

const SEED = join(ROOT, "backend/src/p02-seed.e2e.ts");
const FIRST = "마감 임박 업무 가";
const SECOND = "마감 임박 업무 나";
const WEAK = "낮은 신뢰 추정";

let dir: string;
let vite: ViteDevServer;
let port: number;

test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pki-e2e-notify-"));
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

test("notifications.e2e: read a card, open its evidence, snooze one, read the summary, and see a deletion made in another tab", async ({
  page,
  context,
}) => {
  const url = `http://127.0.0.1:${port}`;
  const nav = page.getByRole("navigation");
  await page.goto(url);
  await expect(nav.getByRole("button", { name: /알림/ })).toContainText("2");
  await nav.getByRole("button", { name: /알림/ }).click();
  await expect(page.getByRole("heading", { name: "알림", level: 1 })).toBeVisible();

  // the feed: the two important ones, labelled as inferences, with the reason and the fact line
  const feed = page.getByRole("list", { name: "알림 피드" }).locator(":scope > li");
  await expect(feed).toHaveCount(2);
  const first = feed.filter({ hasText: `${FIRST} 요약` });
  await expect(first.getByText("추론", { exact: true })).toBeVisible();
  await expect(first).toContainText(`${FIRST} 이유`);
  await expect(first).toContainText(`${FIRST} 줄`);

  // the second one's evidence opens in the source view the other screens use
  const second = feed.filter({ hasText: `${SECOND} 요약` });
  await second.getByRole("button", { name: /근거 보기/ }).click();
  await expect(page.getByRole("heading", { name: "근거", exact: true })).toBeVisible();
  await page.getByRole("button", { name: `원본 보기: 제목 ${SECOND}` }).click();
  await expect(page.getByRole("region", { name: "원본 보기" }).locator("mark")).toHaveText(
    `${SECOND}의 본문`,
  );

  // snoozing the first leaves the feed, and the timeline keeps it as "다시 알림 예정"
  await first.getByRole("button", { name: `다시 알림 1시간: ${FIRST} 요약` }).click();
  await expect(feed).toHaveCount(1);
  await page.getByRole("button", { name: "타임라인" }).click();
  const line = page
    .getByRole("list", { name: "알림 타임라인" })
    .locator(":scope > li")
    .filter({ hasText: `${FIRST} 요약` });
  await expect(line).toContainText("다시 알림 예정");

  // the daily summary shows the low-confidence line with its reason
  await page.getByRole("button", { name: "요약", exact: true }).click();
  await page.getByRole("button", { name: /내용 보기: 매일 요약/ }).click();
  const digest = page.getByRole("list", { name: "요약 내용" }).locator(":scope > li");
  await expect(digest.filter({ hasText: `${WEAK} 요약` })).toContainText("신뢰도 낮음");
  await page.getByRole("button", { name: "피드", exact: true }).click();

  // another tab deletes the second one's source; this tab changes without a click
  const other = await context.newPage();
  await other.goto(url);
  await other.getByRole("navigation").getByRole("button", { name: "원본" }).click();
  await other.getByRole("button", { name: `제목 ${SECOND} 삭제` }).click();
  await other
    .getByRole("alertdialog", { name: "원본 삭제 확인" })
    .getByRole("button", { name: "지우기" })
    .click();
  await expect(other.getByRole("status")).toContainText("지웠습니다");

  await expect(page.getByText("지금 볼 알림이 없습니다.")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "근거", exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("alert").filter({ hasText: "더 이상 표시되지 않습니다" }),
  ).toBeVisible();
});
