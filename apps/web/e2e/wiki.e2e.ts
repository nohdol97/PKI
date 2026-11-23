// K01-C2b (R16) in the browser: on the 위키 screen the user opens a page, sees a claim, opens
// its evidence (the same source view Home uses), follows a link to the other page and sees the
// backlink there, adds a note, and finds it again after leaving the screen and reopening the
// page. One browser flow; the Electron shell adds no assertion of its own (not in the
// electron project's testMatch). The data directory is seeded before start with the product's
// pipeline (backend/src/v02-seed.e2e.ts, fixture set "plain"); the runner that seed uses
// queues and runs the `wiki-build` job, so the pages are there when the backend starts.
import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { webConfig } from "../dev/dev-server.ts";
import { freePort, ROOT } from "./v02-screens.ts";

const SEED = join(ROOT, "backend/src/v02-seed.e2e.ts");
// fixtures/v02-expected.json, set "plain": A depends on B; A has a target date, evidence in the mail
const PROJECT = "미리내 프로젝트";
const SYSTEM = "물결 API";
const CLAIM_QUOTE = "미리내 프로젝트의 완료 목표는 2026-12-05입니다";
const NOTE = "다음 주 회의에서 일정을 다시 확인할 것";

let dir: string;
let vite: ViteDevServer;
let port: number;

test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pki-e2e-wiki-"));
  const dataDir = join(dir, "data");
  const seeded = spawnSync(process.execPath, [SEED, "--data-dir", dataDir, "--set", "plain"], {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
  });
  expect(seeded.status).toBe(0);
  // An empty fixtures file: only the seed put sources in this run's DB.
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

test("wiki.e2e: open a page, its claim and evidence, follow a link to the backlink, keep a note", async ({
  page,
}) => {
  const nav = page.getByRole("navigation");
  const openWiki = async () => {
    await nav.getByRole("button", { name: "위키" }).click();
    await expect(page.getByRole("heading", { name: "위키", level: 1 })).toBeVisible();
  };
  await page.goto(`http://127.0.0.1:${port}`);
  await openWiki();

  // the index lists the pages by kind
  await expect(page.getByRole("list", { name: "프로젝트" }).getByRole("button")).toHaveText(
    PROJECT,
  );
  await expect(page.getByRole("list", { name: "시스템" }).getByRole("button")).toHaveText(SYSTEM);

  // a page: its heading takes focus, and a claim shows its value and status
  await page.getByRole("list", { name: "프로젝트" }).getByRole("button", { name: PROJECT }).click();
  await expect(page.getByRole("heading", { name: PROJECT, level: 2 })).toBeFocused();
  const claims = page.getByRole("list", { name: "주장" });
  const dated = claims.getByRole("listitem").filter({ hasText: "2026-12-05" });
  await expect(dated).toHaveCount(1);

  // its evidence opens in the source view with the quote marked
  await dated.getByRole("button", { name: /근거 보기/ }).click();
  const source = page.getByRole("region", { name: "원본 보기" });
  await expect(source.locator("mark")).toHaveText(CLAIM_QUOTE);

  // the link leads to the other page, which lists this one as a backlink
  await page.getByRole("list", { name: "링크" }).getByRole("button", { name: SYSTEM }).click();
  await expect(page.getByRole("heading", { name: SYSTEM, level: 2 })).toBeFocused();
  await expect(
    page.getByRole("list", { name: "이 페이지를 가리키는 페이지" }).getByRole("button", {
      name: PROJECT,
      exact: true, // the Insight page that names both ends is a backlink too
    }),
  ).toBeVisible();

  // a note stays after leaving the screen and opening the page again
  await page.getByLabel("메모 쓰기").fill(NOTE);
  await page.getByRole("button", { name: "메모 추가" }).click();
  await expect(page.getByRole("list", { name: "메모" })).toContainText(NOTE);
  await nav.getByRole("button", { name: "홈" }).click();
  await openWiki();
  await page.getByRole("list", { name: "시스템" }).getByRole("button", { name: SYSTEM }).click();
  await expect(page.getByRole("list", { name: "메모" })).toContainText(NOTE);
});
