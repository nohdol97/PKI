// A11Y-C1..C4 in the browser: every menu screen (with its data shown) and the opened evidence source are scanned
// with axe (WCAG 2.1 A/AA tags) and must have no serious/critical violation outside the exception list; one
// keyboard-only flow reaches the evidence source. Two seeded stacks (A11Y-D4): k02-seed for ten screens plus the
// evidence view and the keyboard flow, p02-seed for 알림. The browser project only (not in the electron testMatch).
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { webConfig } from "../dev/dev-server.ts";
import { freePort, ROOT } from "./v02-screens.ts";

const K02_SEED = join(ROOT, "backend/src/k02-seed.e2e.ts");
const P02_SEED = join(ROOT, "backend/src/p02-seed.e2e.ts");
const PROJECT = "미리내 프로젝트";
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

// The four screens drawn by the files another session holds (A11Y-R4); only these may carry an exception.
const HELD_SCREENS = ["홈", "알림", "위키", "점검"];
type ScanException = { screen: string; rule: string; selector: string; reason: string };
const EXCEPTIONS: ScanException[] = [];

// The ten screens of stack A and the readiness hint that shows the screen's data; 알림 is scanned on stack B.
const STACK_A: { name: string; ready: (page: Page) => Locator }[] = [
  {
    name: "홈",
    ready: (p) => p.getByRole("list", { name: "Insight 목록" }).getByRole("listitem").first(),
  },
  {
    name: "원본",
    ready: (p) => p.getByRole("button", { name: /삭제$/ }).first(),
  },
  {
    name: "위키",
    ready: (p) => p.getByRole("list", { name: "프로젝트" }).getByRole("button").first(),
  },
  {
    name: "점검",
    ready: (p) => p.getByRole("list", { name: "목표일이 지난 업무" }).getByRole("listitem").first(),
  },
  { name: "질문", ready: (p) => p.getByRole("heading", { name: "질문", level: 1 }) },
  {
    name: "탐색",
    ready: (p) => p.getByRole("list", { name: "항목 목록" }).getByRole("button").first(),
  },
  {
    name: "지식 검토",
    ready: (p) => p.getByRole("list", { name: "지식 목록" }).getByRole("listitem").first(),
  },
  {
    name: "유형 정의",
    ready: (p) => p.getByRole("region", { name: "항목 종류" }).getByRole("listitem").first(),
  },
  {
    name: "활동",
    ready: (p) => p.getByRole("list", { name: "상태별 작업 수" }),
  },
  {
    name: "설정",
    ready: (p) => p.getByRole("group", { name: "기본 Provider" }).getByRole("radio").first(),
  },
];
const STACK_B = [
  {
    name: "알림",
    ready: (p: Page) => p.getByRole("list", { name: "알림 피드" }).getByRole("listitem").first(),
  },
];
const MENU_LENGTH = STACK_A.length + STACK_B.length;

async function startStack(seed: string, args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "pki-e2e-a11y-"));
  const dataDir = join(dir, "data");
  const seeded = spawnSync(process.execPath, [seed, "--data-dir", dataDir, ...args], {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
  });
  expect(seeded.status).toBe(0);
  writeFileSync(join(dir, "empty.jsonl"), "");
  const port = await freePort();
  const vite = await createServer({
    ...webConfig({ port, dataDir, fixtures: join(dir, "empty.jsonl") }),
    configFile: false,
    logLevel: "warn",
  });
  await vite.listen();
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      await vite.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

type Found = { screen: string; rule: string; impact: string; selector: string; help: string };

// Scan the shown screen; returns the serious/critical findings that no exception covers, and records which
// exceptions matched. moderate/minor findings are printed for the leftover table, they do not fail.
async function scan(page: Page, screen: string, matched: Set<ScanException>): Promise<Found[]> {
  await page.evaluate(() => document.fonts.ready);
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(result.passes.length, `${screen}: no rule passed — an empty screen`).toBeGreaterThan(0);
  console.log(
    `A11Y-SCAN ${screen} passes=${result.passes.length} violations=${result.violations.length} incomplete=${result.incomplete.map((i) => i.id).join(",") || "-"}`,
  );
  const all: Found[] = result.violations.flatMap((v) =>
    v.nodes.map((n) => ({
      screen,
      rule: v.id,
      impact: v.impact ?? "unknown",
      selector: n.target.join(" "),
      help: v.helpUrl,
    })),
  );
  for (const f of all.filter((x) => x.impact !== "serious" && x.impact !== "critical")) {
    console.log(`A11Y-LEFTOVER ${f.screen} ${f.impact} ${f.rule} ${f.selector}`);
  }
  return all
    .filter((f) => f.impact === "serious" || f.impact === "critical")
    .filter((f) => {
      const ex = EXCEPTIONS.find(
        (e) => e.screen === f.screen && e.rule === f.rule && e.selector === f.selector,
      );
      if (ex) matched.add(ex);
      return !ex;
    });
}

const describeFound = (found: Found[]) =>
  found.map((f) => `${f.screen} | ${f.impact} | ${f.rule} | ${f.selector} | ${f.help}`);

// Counts the `/api/` requests that are out, from the call on: a screen's secondary reads (connector list,
// the activity sections, the eight settings sections) go out on their own requests after its readiness hint.
function trackApiRequests(page: Page): () => number {
  let out = 0;
  const isApi = (url: string) => new URL(url).pathname.startsWith("/api/");
  page.on("request", (r) => void (isApi(r.url()) && (out += 1)));
  page.on("requestfinished", (r) => void (isApi(r.url()) && (out -= 1)));
  page.on("requestfailed", (r) => void (isApi(r.url()) && (out -= 1)));
  return () => out;
}

async function scanScreens(
  page: Page,
  screens: { name: string; ready: (p: Page) => Locator }[],
  matched: Set<ScanException>,
  apiOut: () => number,
) {
  const nav = page.getByRole("navigation");
  const leftover: Found[] = [];
  for (const s of screens) {
    // the name starts with the screen's: the 알림 button also carries its unread count
    await nav.getByRole("button", { name: new RegExp(`^${s.name}`) }).click();
    await expect(s.ready(page)).toBeVisible();
    await expect.poll(apiOut, { message: `${s.name}: /api/ requests still out` }).toBe(0);
    leftover.push(...(await scan(page, s.name, matched)));
  }
  return leftover;
}

test("a11y.e2e: the exception list is well formed and the menu has exactly the scanned screens", async () => {
  for (const e of EXCEPTIONS) {
    expect(HELD_SCREENS).toContain(e.screen);
    expect([e.rule, e.selector, e.reason].every((v) => v.trim().length > 0)).toBe(true);
  }
});

test("a11y.e2e: ten screens and the opened evidence source have no serious or critical violation", async ({
  page,
}) => {
  test.setTimeout(240_000); // eleven scans on one stack; each axe run is slow on a loaded machine
  const stack = await startStack(K02_SEED, []);
  try {
    const matched = new Set<ScanException>();
    const apiOut = trackApiRequests(page);
    await page.goto(stack.url);
    await expect(page.getByRole("navigation").getByRole("button")).toHaveCount(MENU_LENGTH);
    const leftover = await scanScreens(page, STACK_A, matched, apiOut);

    // C2: the evidence source of a fact, opened from 탐색
    const nav = page.getByRole("navigation");
    await nav.getByRole("button", { name: "탐색", exact: true }).click();
    await page.getByLabel("항목 이름").fill("미리내");
    await page.keyboard.press("Enter");
    await page
      .getByRole("list", { name: "항목 목록" })
      .getByRole("button", { name: PROJECT })
      .click();
    await page.getByRole("button", { name: /^근거 보기: target_date: 2026-12-05/ }).click();
    await expect(
      page.getByRole("region", { name: "근거 원본" }).locator("mark").first(),
    ).toBeVisible();
    leftover.push(...(await scan(page, "탐색 근거", matched)));

    const stale = EXCEPTIONS.filter(
      (e) => STACK_A.some((s) => s.name === e.screen) && !matched.has(e),
    );
    expect(describeFound(leftover)).toEqual([]);
    expect(stale, "exceptions that match no reported violation").toEqual([]);
  } finally {
    await stack.close();
  }
});

test("a11y.e2e: 알림 has no serious or critical violation", async ({ page }) => {
  test.setTimeout(120_000);
  const stack = await startStack(P02_SEED, []);
  try {
    const matched = new Set<ScanException>();
    const apiOut = trackApiRequests(page);
    await page.goto(stack.url);
    const leftover = await scanScreens(page, STACK_B, matched, apiOut);
    const stale = EXCEPTIONS.filter((e) => e.screen === "알림" && !matched.has(e));
    expect(describeFound(leftover)).toEqual([]);
    expect(stale, "exceptions that match no reported violation").toEqual([]);
  } finally {
    await stack.close();
  }
});

// HOC-C1: the outline steps down one level at a time on the four screens #308 named; one rule only (HOC-D3).
async function headingOrderViolations(
  page: Page,
  screens: { name: string; ready: (p: Page) => Locator }[],
  apiOut: () => number,
) {
  const nav = page.getByRole("navigation");
  const found: string[] = [];
  for (const s of screens) {
    await nav.getByRole("button", { name: new RegExp(`^${s.name}`) }).click();
    await expect(s.ready(page)).toBeVisible();
    await expect.poll(apiOut, { message: `${s.name}: /api/ requests still out` }).toBe(0);
    found.push(...(await scanHeadingOrder(page, s.name)));
    if (s.name === "알림") found.push(...(await notificationsDeepHeadingOrder(page, apiOut)));
  }
  return found;
}

async function scanHeadingOrder(page: Page, name: string) {
  const result = await new AxeBuilder({ page }).withRules(["heading-order"]).analyze();
  expect(result.passes.length, `${name}: heading-order did not run`).toBeGreaterThan(0);
  return result.violations.flatMap((v) =>
    v.nodes.map((n) => `${name} | ${v.id} | ${n.target.join(" ")}`),
  );
}

// UIF-R5: the timeline's day headings and an opened digest's heading sit below the screen's `h1`, so they are scanned too.
async function notificationsDeepHeadingOrder(page: Page, apiOut: () => number) {
  const found: string[] = [];
  const tabs = page.getByRole("group", { name: "알림 보기" });
  await tabs.getByRole("button", { name: "타임라인" }).click();
  await expect(page.getByRole("list", { name: /알림 타임라인/ }).first()).toBeVisible();
  await expect.poll(apiOut, { message: "알림 타임라인: /api/ requests still out" }).toBe(0);
  found.push(...(await scanHeadingOrder(page, "알림 타임라인")));
  await tabs.getByRole("button", { name: "요약", exact: true }).click();
  await page
    .getByRole("button", { name: /내용 보기: 매일 요약/ })
    .first()
    .click();
  await expect(page.getByRole("list", { name: "요약 내용" })).toBeVisible();
  await expect.poll(apiOut, { message: "알림 요약 내용: /api/ requests still out" }).toBe(0);
  found.push(...(await scanHeadingOrder(page, "알림 요약 내용")));
  return found;
}

test("a11y.e2e: heading-order holds on 홈, 위키, 점검 and 알림", async ({ page }) => {
  test.setTimeout(240_000);
  const byName = (name: string) => [...STACK_A, ...STACK_B].filter((s) => s.name === name);
  const a = await startStack(K02_SEED, []);
  try {
    const apiOut = trackApiRequests(page);
    await page.goto(a.url);
    const screens = ["홈", "위키", "점검"].flatMap(byName);
    expect(await headingOrderViolations(page, screens, apiOut)).toEqual([]);
  } finally {
    await a.close();
  }
  const b = await startStack(P02_SEED, []);
  try {
    const apiOut = trackApiRequests(page);
    await page.goto(b.url);
    expect(await headingOrderViolations(page, byName("알림"), apiOut)).toEqual([]);
  } finally {
    await b.close();
  }
});

// C4: only the keyboard — no click, no focus() call. Tab until the wanted control has focus (bounded), then act.
async function tabTo(page: Page, target: Locator, max = 60) {
  for (let i = 0; i < max; i += 1) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Tab did not reach the control within ${max} presses`);
}

test("a11y.e2e: keyboard only — menu, 탐색, an item, and the evidence source heading takes focus", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const stack = await startStack(K02_SEED, []);
  try {
    await page.goto(stack.url);
    const nav = page.getByRole("navigation");
    await expect(nav.getByRole("button", { name: "탐색", exact: true })).toBeVisible();
    await tabTo(page, nav.getByRole("button", { name: "탐색", exact: true }));
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "탐색", level: 1 })).toBeVisible();

    await tabTo(page, page.getByLabel("항목 이름"));
    await page.keyboard.type("미리내");
    await page.keyboard.press("Enter");
    const found = page
      .getByRole("list", { name: "항목 목록" })
      .getByRole("button", { name: PROJECT });
    await expect(found).toBeVisible();
    await tabTo(page, found);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: PROJECT, level: 2 })).toBeFocused();

    await tabTo(page, page.getByRole("button", { name: /^근거 보기: target_date: 2026-12-05/ }));
    await page.keyboard.press("Enter");
    const source = page.getByRole("region", { name: "근거 원본" });
    await expect(source.locator("mark").first()).toBeVisible();
    await expect(source.getByRole("heading", { level: 3 })).toBeFocused();
  } finally {
    await stack.close();
  }
});
