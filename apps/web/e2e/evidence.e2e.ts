// V02-C2 (same file, `target`): untrusted.e2e runs in the browser and in the Electron shell,
// evidence.e2e in the browser only (in the shell v02-flow.e2e opens the same evidence):
// evidence.e2e — Home's Insight is labelled an inference, its three evidence each
// open their source version with the quote marked, matching fixtures/v02-expected.json.
// untrusted.e2e — on the malicious variant the imported <script> never runs (no
// canary attribute on the page), its remote <img> is never requested, the source
// view holds no script or img element, and the text carries the untrusted badge.
// The data directory is seeded before start by the test-build-only seed entry
// (backend/src/v02-seed.e2e.ts: product pipeline + fixture Provider double).
import { test as base, expect, type BrowserType, type Page } from "@playwright/test";
import { launchShell } from "@pki/desktop";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { webConfig } from "../dev/dev-server.ts";
import { freePort, insightItems, openEvidence, remote, ROOT } from "./v02-screens.ts";

type Target = "browser" | "electron";
const test = base.extend<{ target: Target }>({ target: ["browser", { option: true }] });

const SEED = join(ROOT, "backend/src/v02-seed.e2e.ts");

interface Stack {
  page: Page;
  /** Every URL the page requested since it opened. */
  requested: string[];
  stop(): Promise<void>;
}

/** Seeds `set` into a fresh data directory, then opens the screens on `target`. */
async function startStack(set: string, target: Target, chromium: BrowserType): Promise<Stack> {
  const dir = mkdtempSync(join(tmpdir(), "pki-e2e-evidence-"));
  const dataDir = join(dir, "data");
  const seeded = spawnSync(process.execPath, [SEED, "--data-dir", dataDir, "--set", set], {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
  });
  expect(seeded.status).toBe(0);
  // An empty fixtures file: only the seed put sources in this run's DB.
  const fixtures = join(dir, "empty.jsonl");
  writeFileSync(fixtures, "");
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  const requested: string[] = [];
  if (target === "electron") {
    const { app, window } = await launchShell({ userData: join(dir, "user"), dataDir, fixtures });
    window.on("request", (r) => requested.push(r.url()));
    return { page: window, requested, stop: async () => (await app.close(), cleanup()) };
  }
  const port = await freePort();
  const vite = await createServer({
    ...webConfig({ port, fixtures, dataDir }),
    configFile: false,
    logLevel: "warn",
  });
  await vite.listen();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("request", (r) => requested.push(r.url()));
  await page.goto(`http://127.0.0.1:${port}`);
  return {
    page,
    requested,
    async stop() {
      await browser.close();
      await vite.close();
      cleanup();
    },
  };
}

/**
 * UI01-C7: Home is the mockup's composition. The first Insight is open on its own; the two head bars are
 * 48px high and level, the detail pane is right of the list; the chosen row has the accent bar on a white
 * ground; the title is 24px; the action bar stays at the pane's bottom edge while the body scrolls; the main
 * action is filled.
 */
async function homeLooksLikeTheMockup(page: Page) {
  const detail = page.getByRole("region", { name: "Insight 상세" });
  await expect(detail.getByRole("heading", { name: "근거", exact: true })).toBeVisible();
  const box = async (selector: string) =>
    (await page.locator(selector).first().boundingBox()) as NonNullable<
      Awaited<ReturnType<ReturnType<Page["locator"]>["boundingBox"]>>
    >;
  const [listHead, detailHead, list] = [
    await box(".pane-list .pane-head"),
    await box(".pane-detail .pane-head"),
    await box(".pane-list"),
  ];
  expect([listHead.height, detailHead.height]).toEqual([48, 48]);
  expect(detailHead.y).toBe(listHead.y);
  expect(detailHead.x).toBeGreaterThanOrEqual(list.x + list.width);

  const style = (selector: string, property: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), property);
  const row = '.rows .row[aria-current="true"]';
  await expect(page.locator(row)).toHaveCount(1);
  expect(await style(row, "border-left-color")).toBe("rgb(30, 58, 95)");
  expect(await style(row, "background-color")).toBe("rgb(255, 255, 255)");
  expect(await style(".pane-detail .detail-title", "font-size")).toBe("24px");
  expect(await style(".pane-detail .actions .btn-primary", "background-color")).toBe(
    "rgb(30, 58, 95)",
  );

  const barBottomGap = async () => {
    const [pane, bar] = [await box(".pane-detail"), await box(".pane-detail .actions")];
    return pane.y + pane.height - (bar.y + bar.height);
  };
  expect(Math.abs(await barBottomGap())).toBeLessThanOrEqual(1);
  await page.locator(".pane-detail .pane-body").evaluate((e) => (e.scrollTop = e.scrollHeight));
  expect(Math.abs(await barBottomGap())).toBeLessThanOrEqual(1);
  await page.locator(".pane-detail .pane-body").evaluate((e) => (e.scrollTop = 0));
}

test("evidence.e2e: the Insight's three evidence open their source version and span", async ({
  target,
  playwright,
}) => {
  test.skip(
    target !== "browser",
    "in the shell, v02-flow.e2e opens the same evidence (openEvidence, plain) twice",
  );
  const stack = await startStack("plain", target, playwright.chromium);
  try {
    const { page } = stack;
    await page.setViewportSize({ width: 1280, height: 800 });
    await homeLooksLikeTheMockup(page);
    const source = await openEvidence(stack.page, "plain");
    // UI01-C7: at 1280px the opened source sits in the column to the right of the Insight list
    const insights = stack.page.getByRole("list", { name: "Insight 목록" });
    await expect(source).toBeVisible();
    await expect(insights).toBeVisible();
    const [listBox, sourceBox] = [await insights.boundingBox(), await source.boundingBox()];
    expect(sourceBox?.x).toBeGreaterThan((listBox?.x ?? 0) + (listBox?.width ?? 0));
    expect(stack.requested.filter(remote)).toEqual([]);
  } finally {
    await stack.stop();
  }
});

test("insight.e2e: Home shows the Insight's type, fact lines, reasoning and ranking; the type list and the interpret switch", async ({
  target,
  playwright,
}) => {
  test.skip(target !== "browser", "browser only (P01 spec, D36)");
  const stack = await startStack("plain", target, playwright.chromium);
  const { page } = stack;
  try {
    await expect(insightItems(page)).toHaveCount(1);
    const item = insightItems(page).first();
    await expect(item).toContainText("의존 업무 지연");
    // the fact lines, the reason and the ranking are in the detail pane (the first Insight is open)
    const detail = page.getByRole("region", { name: "Insight 상세" });
    const lines = detail.getByRole("list", { name: "사실 줄" }).getByRole("listitem");
    await expect(lines).toHaveCount(3);
    await expect(lines.filter({ hasText: "2026-12-05" })).not.toHaveCount(0);
    await expect(lines.filter({ hasText: "2026-12-10" })).not.toHaveCount(0);
    // the notification mark is not asserted: the fixture double's candidate confidence is not pinned
    await expect(detail).toContainText("코드가 비교해");
    await expect(detail).toContainText(/순위 \d+/);

    await page.getByText("Insight 유형 지원 상태").click();
    const types = page.getByRole("list", { name: "Insight 유형" }).getByRole("listitem");
    await expect(types).toHaveCount(13);
    const similar = types.filter({ hasText: "유사 해결" });
    await expect(similar).toContainText("미지원");
    await expect(similar).toContainText("유사도 검색이 없다");

    // last on purpose: turning the switch on queues an interpretation job that waits without a Provider
    const nav = page.getByRole("navigation");
    await nav.getByRole("button", { name: "설정" }).click();
    const box = page.getByRole("checkbox", { name: "Insight LLM 해석 사용" });
    await expect(box).not.toBeChecked();
    await box.click();
    await nav.getByRole("button", { name: "홈" }).click();
    await nav.getByRole("button", { name: "설정" }).click();
    await expect(box).toBeChecked();
    expect(stack.requested.filter(remote)).toEqual([]);
  } finally {
    await stack.stop();
  }
});

test("untrusted.e2e: imported script never runs and remote resources are never loaded", async ({
  target,
  playwright,
}) => {
  const stack = await startStack("malicious", target, playwright.chromium);
  const { page } = stack;
  try {
    const source = await openEvidence(page, "malicious");
    // the last source opened is the messenger record, which holds a script and an img
    await expect(source).toContainText('<script>document.body.setAttribute("data-pki-canary"');
    await expect(source).toContainText("https://tracker.example.test/pixel.png");
    expect(await source.locator("script, img, iframe, object, embed, link").count()).toBe(0);
    expect(await page.locator("img").count()).toBe(0);
    expect(await page.evaluate(() => document.body.getAttribute("data-pki-canary"))).toBeNull();
    expect(await page.evaluate(() => document.querySelector("[data-pki-canary]"))).toBeNull();
    expect(stack.requested.filter((u) => u.includes("tracker.example.test"))).toEqual([]);
    expect(stack.requested.filter(remote)).toEqual([]);
  } finally {
    await stack.stop();
  }
});
