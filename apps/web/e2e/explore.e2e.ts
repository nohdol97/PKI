// X02-C3b (R5..R8) in the browser: on 지식 검토 the user approves a candidate fact and sees the state change; on
// 탐색 finds an item by name and chooses it with the keyboard, sees the neighbour and the relation, opens the
// evidence of a fact down to the quoted source, then moves to the neighbour's Wiki page and sees its backlink.
// One browser flow; the shell adds no assertion of its own (not in the electron project's testMatch). The data
// directory is seeded before start with the product's pipeline (backend/src/v02-seed.e2e.ts, set "plain",
// which leaves its facts and relation as candidates and builds the Wiki pages).
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

let dir: string;
let vite: ViteDevServer;
let port: number;

test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pki-e2e-explore-"));
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

test("explore.e2e: approve a candidate, find an item by name, its neighbour, the evidence, the Wiki page with its backlink", async ({
  page,
}) => {
  const nav = page.getByRole("navigation");
  await page.goto(`http://127.0.0.1:${port}`);

  // 지식 검토: the candidate fact is listed; approving it moves it out of the candidates and into 확정
  await nav.getByRole("button", { name: "지식 검토" }).click();
  await expect(page.getByRole("heading", { name: "지식 검토", level: 1 })).toBeVisible();
  const candidates = page.getByRole("list", { name: "지식 목록" });
  const dated = candidates.getByRole("listitem").filter({ hasText: "2026-12-05" });
  await expect(dated.filter({ hasText: "후보" }).first()).toBeVisible();
  await page.getByRole("button", { name: /^승인: 사실 target_date 2026-12-05/ }).click();
  await page.getByLabel("상태").selectOption("verified");
  await expect(
    candidates
      .getByRole("listitem")
      .filter({ hasText: "2026-12-05" })
      .filter({ hasText: "확정" })
      .first(),
  ).toBeVisible();

  // 탐색: search by name and choose the item with the keyboard; its heading takes focus
  await nav.getByRole("button", { name: "탐색" }).click();
  await expect(page.getByRole("heading", { name: "탐색", level: 1 })).toBeVisible();
  await page.getByLabel("항목 이름").fill("미리내");
  await page.keyboard.press("Enter");
  const found = page
    .getByRole("list", { name: "항목 목록" })
    .getByRole("button", { name: PROJECT });
  await expect(found).toBeVisible();
  await found.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: PROJECT, level: 2 })).toBeFocused();
  // UI01-C8: the chosen row is marked, and the item is the detail pane to the right of the list
  await expect(found).toHaveAttribute("aria-current", "true");
  const [listBox, detailBox] = [
    await page.getByRole("list", { name: "항목 목록" }).boundingBox(),
    await page.getByRole("region", { name: "항목 상세" }).boundingBox(),
  ];
  expect(detailBox?.x).toBeGreaterThanOrEqual((listBox?.x ?? 0) + (listBox?.width ?? 0));

  // the neighbour and the relation to it
  const row = page
    .getByRole("table", { name: "이웃 표" })
    .getByRole("row")
    .filter({ hasText: SYSTEM });
  await expect(row).toContainText("DEPENDS_ON");

  // the evidence of the fact: the source opens with the quote marked
  await page.getByRole("button", { name: /^근거 보기: target_date: 2026-12-05/ }).click();
  const source = page.getByRole("region", { name: "근거 원본" });
  await expect(source.locator("mark").first()).toHaveText(CLAIM_QUOTE);

  // the neighbour becomes the centre, and its Wiki page opens with the backlink
  await row.getByRole("button", { name: SYSTEM }).click();
  await expect(page.getByRole("heading", { name: SYSTEM, level: 2 })).toBeFocused();
  await page.getByRole("button", { name: "위키 페이지 열기" }).click();
  await expect(page.getByRole("heading", { name: "위키", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: SYSTEM, level: 2 })).toBeFocused();
  await expect(
    page
      .getByRole("list", { name: "이 페이지를 가리키는 페이지" })
      .getByRole("button", { name: PROJECT, exact: true }),
  ).toBeVisible();
});
