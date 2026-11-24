// X02B-C8 (R7..R9) and C9 (R10, R11) in the browser, two flows in one file. The data directory is seeded before
// start (backend/src/x02b-curation-seed.e2e.ts: the V02 "plain" set, a second Project to merge, and filler
// candidate items). Browser project only: the shell adds no assertion of its own (not in the electron testMatch).
import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { webConfig } from "../dev/dev-server.ts";
import { freePort, ROOT } from "./v02-screens.ts";

const SEED = join(ROOT, "backend/src/x02b-curation-seed.e2e.ts");
const PROJECT = "미리내 프로젝트";
const MEMBER = "새별 프로젝트";

let dir: string;
let vite: ViteDevServer;
let port: number;

test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pki-e2e-curation-"));
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

test("explore-curation.e2e: find an item, see the graph, merge another Project into it, see the member, undo", async ({
  page,
}) => {
  const nav = page.getByRole("navigation");
  await page.goto(`http://127.0.0.1:${port}`);
  await nav.getByRole("button", { name: "탐색" }).click();
  await page.getByLabel("항목 이름").fill("미리내");
  await page.getByRole("button", { name: "찾기" }).click();
  await page
    .getByRole("list", { name: "항목 목록" })
    .getByRole("button", { name: PROJECT })
    .click();
  await expect(page.getByRole("heading", { name: PROJECT, level: 2 })).toBeVisible();

  // the neighbour graph: a picture with a summary name, the table stays
  await expect(
    page.getByRole("img", { name: /^이웃 그림: 항목 \d+개, 관계 \d+개$/ }),
  ).toBeVisible();
  await expect(page.getByRole("table", { name: "이웃 표" })).toBeVisible();

  // the action history of one fact line opens
  await page
    .getByRole("button", { name: /^이력 보기: / })
    .first()
    .click();
  await expect(page.getByRole("list", { name: "조치 이력" }).first()).toBeVisible();

  const curate = page.getByRole("region", { name: "항목 정리" });
  await expect(curate.getByText("합쳐진 항목이 없습니다.")).toBeVisible();
  await curate.getByLabel("합칠 항목 이름").fill("새별");
  await curate.getByRole("button", { name: "합칠 항목 찾기" }).click();
  await expect(page.getByRole("list", { name: "합칠 항목 후보" })).toBeVisible();
  // X02F-C6: the answer is slow and the button is pressed twice: one request goes out and no refusal shows
  let merges = 0;
  await page.route("**/api/entities/merge", async (route) => {
    merges += 1;
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });
  await page.getByRole("button", { name: `중심 항목에 합치기: ${MEMBER}` }).dblclick();

  const members = page.getByRole("list", { name: "구성원 목록" });
  await expect(members).toContainText(MEMBER);
  expect(merges).toBe(1);
  await expect(curate.getByRole("alert")).toHaveCount(0);

  await page.getByRole("button", { name: `합치기 되돌리기: ${MEMBER}` }).click();
  await expect(page.getByRole("list", { name: "구성원 목록" })).toHaveCount(0);
  await expect(curate.getByText("합쳐진 항목이 없습니다.")).toBeVisible();
});

test("explore-curation.e2e: filter 지식 검토 by status on the server, read more, see the 유형 정의 sections", async ({
  page,
}) => {
  const nav = page.getByRole("navigation");
  await page.goto(`http://127.0.0.1:${port}`);
  await nav.getByRole("button", { name: "지식 검토" }).click();
  const head = page.locator(".pane-head").first();
  // UI01-C8: 지식 검토 is a pane with a 48px head bar that holds the state select
  expect((await head.boundingBox())?.height).toBe(48);
  await expect(head.getByLabel("상태")).toBeVisible();
  const list = page.getByRole("list", { name: "지식 목록" });
  const rows = list.locator("> li"); // one per item; facts and relations are nested lists
  // candidates are the default filter; 57 candidate items exceed the 50 of one page
  await expect(rows).toHaveCount(50);
  await page.getByRole("button", { name: "더 보기" }).click();
  await expect(rows).not.toHaveCount(50);
  await expect(page.getByRole("button", { name: "더 보기" })).toHaveCount(0);

  // nothing is confirmed in the seed: the confirmed filter is empty
  await page.getByLabel("상태").selectOption("verified");
  await expect(rows).toHaveCount(0);
  await page.getByLabel("상태").selectOption("all");
  await expect(rows.first()).toBeVisible();

  await nav.getByRole("button", { name: "유형 정의" }).click();
  await expect(page.getByRole("heading", { name: "유형 정의", level: 1 })).toBeVisible();
  for (const kind of ["항목 종류", "사실 종류", "관계 종류"])
    await expect(page.getByRole("region", { name: kind })).toBeVisible();
  expect((await page.locator(".pane-head").first().boundingBox())?.height).toBe(48); // UI01-C8

  // add an item type: it shows in the 항목 종류 section
  const form = page.getByRole("form", { name: "정의 더하기" });
  await form.locator("select").first().selectOption("item-type");
  await form.getByLabel("이름").fill("Experiment");
  await form.getByRole("button", { name: "적용" }).click();
  await expect(
    page.getByRole("region", { name: "항목 종류" }).getByText("Experiment"),
  ).toBeVisible();
});
