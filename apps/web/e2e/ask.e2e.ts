// X01-C2c (R11) in the browser: on the 질문 screen the user asks, sees the hits (a stale mark, related
// knowledge) and the answer's sentences with their quotes; with no Provider chosen the same question shows the
// hits and the "답을 만들 수 없음" notice. One browser flow (not in the electron project's testMatch). The data
// directory is seeded before start (backend/src/x01-ask-seed.e2e.ts); the Provider double is bound to the dev
// backend by the test-build-only preload backend/src/x01-ask.hook.e2e.ts, and not bound in the second run.
import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { webConfig } from "../dev/dev-server.ts";
import { freePort, ROOT } from "./v02-screens.ts";

const SEED = join(ROOT, "backend/src/x01-ask-seed.e2e.ts");
const PRELOAD = `--import=${pathToFileURL(join(ROOT, "backend/src/x01-ask.hook.e2e.ts")).href}`;
const QUESTION = "배포일";
const TITLE = "배포일 안내";
const QUOTE = "물결 프로젝트의 배포일은 12월 17일로 바뀌었다";

let dir: string;
let vite: ViteDevServer | undefined;

async function start(env?: Record<string, string>) {
  const dataDir = join(dir, "data");
  const seeded = spawnSync(process.execPath, [SEED, "--data-dir", dataDir], {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
  });
  expect(seeded.status).toBe(0);
  // An empty fixtures file: only the seed put sources in this run's DB.
  writeFileSync(join(dir, "empty.jsonl"), "");
  const port = await freePort();
  vite = await createServer({
    ...webConfig({ port, dataDir, fixtures: join(dir, "empty.jsonl"), ...(env ? { env } : {}) }),
    configFile: false,
    logLevel: "warn",
  });
  await vite.listen();
  return port;
}
test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-e2e-ask-"));
});
test.afterEach(async () => {
  await vite?.close();
  vite = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function ask(page: Page, port: number) {
  await page.goto(`http://127.0.0.1:${port}`);
  await page.getByRole("navigation").getByRole("button", { name: "질문" }).click();
  await expect(page.getByRole("heading", { name: "질문", level: 1 })).toBeVisible();
  await page.getByLabel("질문 입력").fill(QUESTION);
  await page.getByRole("button", { name: "질문하기" }).click();
}

test("ask.e2e: the hits, then the answer's sentences with their quotes and the related knowledge", async ({
  page,
}) => {
  await ask(page, await start({ NODE_OPTIONS: PRELOAD }));

  const hits = page.getByRole("list", { name: "적중 목록" }).getByRole("listitem");
  await expect(hits.filter({ hasText: TITLE }).first()).toBeVisible();
  await expect(page.getByRole("list", { name: "관련 지식" }).first()).toContainText(
    "물결 프로젝트",
  );
  await expect(page.getByText("낡음", { exact: true }).first()).toBeVisible();

  const sentences = page.getByRole("list", { name: "답 문장" }).getByRole("listitem");
  await expect(sentences.first()).toBeVisible();
  await expect(sentences.filter({ hasText: QUOTE })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "취소" })).toHaveCount(0);
});

test("ask.e2e: with no Provider chosen the hits show and the answer cannot be made", async ({
  page,
}) => {
  await ask(page, await start());

  await expect(
    page
      .getByRole("list", { name: "적중 목록" })
      .getByRole("listitem")
      .filter({ hasText: TITLE })
      .first(),
  ).toBeVisible();
  await expect(page.getByText(/답을 만들 수 없음/)).toBeVisible();
  await expect(page.getByRole("list", { name: "답 문장" })).toHaveCount(0);
});

// The acknowledgement is consent for one call: ticked once, the next question carries none (X01 contract).
test("ask.e2e: the unverified-isolation acknowledgement applies to one question only", async ({
  page,
}) => {
  const bodies: Record<string, unknown>[] = [];
  const blocked = [
    { type: "route", route: { keyword: { status: "used" } } },
    { type: "hits", hits: [], notes: [] },
    { type: "answer", status: "blocked", reason: "unverified-ack-required" },
    { type: "done", sentences: 0, dropped: 0, insufficient: false },
  ];
  await page.route("**/api/ask", async (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: blocked.map((e) => JSON.stringify(e)).join("\n") + "\n",
    });
  });
  await ask(page, await start());

  const ack = page.getByLabel(/격리 미검증 경고를 확인했습니다/);
  await ack.check(); // shown because the first answer was blocked
  await page.getByRole("button", { name: "질문하기" }).click();
  await expect.poll(() => bodies.length).toBe(2);
  await expect(ack).toBeVisible(); // blocked again; not ticked for this one
  await page.getByRole("button", { name: "질문하기" }).click();
  await expect.poll(() => bodies.length).toBe(3);

  expect(bodies[0]).not.toHaveProperty("acknowledgeUnverified");
  expect(bodies[1]).toHaveProperty("acknowledgeUnverified", true);
  expect(bodies[2]).not.toHaveProperty("acknowledgeUnverified");
});
