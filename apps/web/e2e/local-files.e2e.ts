// I02B-C25, C24, C30 (screen half) — the first vertical slice, in the browser and in the Electron shell
// (same file, `target`): a folder with three Markdown files is approved on the Settings screen, the sources
// appear and are extracted by the Provider double, the Insight's evidence carries the Markdown locator, and
// after one file is deleted and the sync runs the source is gone and a tombstone says `source-deleted`.
// Browser: the folder is typed into the development input (the Vite dev server shows it). Electron: the
// button opens the folder dialog, which the test main (apps/desktop/e2e/pick-main.ts) answers; the ticket
// path that follows is the product's, in a source-run shell (build kind `production`).
// The Provider double is bound as v02-flow.e2e.ts does it (v02-double.hook.e2e.ts / double-main.ts).
import { _electron, test as base, expect, type BrowserType, type Page } from "@playwright/test";
import { ELECTRON, shellArgs } from "@pki/desktop";
import { spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "vite";
import { webConfig } from "../dev/dev-server.ts";
import { freePort, ROOT } from "./v02-screens.ts";

type Target = "browser" | "electron";
const test = base.extend<{ target: Target }>({ target: ["browser", { option: true }] });

const BACKEND_PRELOAD = `--import=${pathToFileURL(join(ROOT, "backend/src/v02-double.hook.e2e.ts")).href}`;
const PICK_MAIN = join(ROOT, "apps/desktop/e2e/pick-main.ts");
const FILES = [
  ["mail.md", "v02-mail.jsonl"],
  ["wiki.md", "v02-wiki.jsonl"],
  ["messenger.md", "v02-messenger.jsonl"],
] as const;

const content = (file: string) =>
  (JSON.parse(readFileSync(join(ROOT, "fixtures", file), "utf8").trim()) as { content: string })
    .content;

let dir: string;
const closers: (() => Promise<unknown>)[] = [];
test.beforeEach(() => void (dir = realpathSync(mkdtempSync(join(tmpdir(), "pki-e2e-local-")))));
test.afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

async function ended(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, "exit");
  child.kill();
  await exit;
}

async function startStack(target: Target, docs: string, chromium: BrowserType): Promise<Page> {
  const dataDir = join(dir, "data");
  const fixtures = join(dir, "empty.jsonl");
  writeFileSync(fixtures, "");
  if (target === "electron") {
    const [, ...switches] = shellArgs({ userData: join(dir, "user"), dataDir, fixtures });
    const app = await _electron.launch({
      executablePath: ELECTRON,
      args: [PICK_MAIN, ...switches],
      timeout: 30_000,
      env: { ...process.env, PKI_E2E_PICK_PATH: docs } as Record<string, string>,
    });
    closers.push(() => app.close());
    const window = await app.firstWindow({ timeout: 30_000 });
    await window.waitForLoadState("domcontentloaded");
    return window;
  }
  const port = await freePort();
  const vite = await createServer({
    ...webConfig({
      port,
      fixtures,
      dataDir,
      env: { NODE_OPTIONS: BACKEND_PRELOAD },
      onBackend: (child) => closers.push(() => ended(child)),
    }),
    configFile: false,
    logLevel: "warn",
  });
  closers.push(() => vite.close());
  await vite.listen();
  const browser = await chromium.launch();
  closers.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}`);
  return page;
}

const go = (page: Page, screen: "홈" | "원본" | "설정") =>
  page.getByRole("navigation").getByRole("button", { name: screen }).click();

test.describe.configure({ timeout: 120_000 });

test("local-files.e2e: approve a folder → sources → Insight evidence with a locator → delete → tombstone", async ({
  target,
  playwright,
}) => {
  const docs = join(dir, "docs");
  mkdirSync(docs);
  for (const [name, record] of FILES) {
    const file = join(docs, name);
    writeFileSync(file, content(record));
    // settled: a file written a moment ago is not read in the first pass
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(file, old, old);
  }
  const page = await startStack(target, docs, playwright.chromium);

  await test.step("approve the folder on the Settings screen", async () => {
    await go(page, "설정");
    if (target === "browser") {
      await page.getByLabel("폴더 경로(개발용)").fill(docs);
    } else {
      // a built screen has no path input (C30)
      await expect(page.getByLabel("폴더 경로(개발용)")).toHaveCount(0);
    }
    await page.getByRole("button", { name: "폴더 추가" }).click();
    const table = page.getByRole("table", { name: "로컬 자료 위치" });
    await expect(table).toContainText(docs);
    await expect(table).toContainText("실시간 감시 중");
  });

  await test.step("the files are sources and the Provider double's Insight has Markdown evidence", async () => {
    // The first pass only sees the files: a file is read once two observations at least `settleMs` apart
    // agree (I02B-R15), and the driver that schedules the second pass is T04's. So the second pass is the
    // user's own "동기화" after that time.
    await page.waitForTimeout(2_500);
    await go(page, "원본");
    await page.getByRole("button", { name: "local-files 동기화" }).click();
    // Home rereads when entered: enter it until the sync and the extraction have ended
    // the files also make a new-relation Insight (P01-D24), so the dependency-delay row is picked by its sentence
    const insight = page
      .getByRole("list", { name: "Insight 목록" })
      .locator(":scope > li")
      .filter({ hasText: "의존 업무의 지연" });
    await expect(async () => {
      await go(page, "원본");
      await go(page, "홈");
      await expect(insight).toHaveCount(1, { timeout: 1_000 });
    }).toPass({ timeout: 60_000 });
    const evidence = page.waitForResponse((r) => r.url().endsWith("/api/insights/evidence"));
    await insight.getByRole("button", { name: /근거 보기/ }).click();
    const body = (await (await evidence).json()) as {
      evidence: { quote: string; locator: { format: string; line: number } | null }[];
    };
    expect(body.evidence).toHaveLength(3);
    for (const row of body.evidence) {
      expect(row.quote.length).toBeGreaterThan(0);
      expect(row.locator).toMatchObject({ format: "markdown" });
      expect(row.locator?.line).toBeGreaterThan(0);
    }
  });

  await test.step("delete a file, sync: the source is gone and one tombstone says source-deleted", async () => {
    unlinkSync(join(docs, "wiki.md"));
    await go(page, "원본");
    const rows = page.getByRole("table").last().getByRole("row");
    await expect(rows).toHaveCount(3);
    await page.getByRole("button", { name: "local-files 동기화" }).click();
    await expect(async () => {
      await go(page, "홈");
      await go(page, "원본");
      await expect(rows).toHaveCount(2, { timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
    const tombstones = await page.evaluate(async () => {
      const bridge = (globalThis as { pki?: { getSession(): Promise<{ token: string }> } }).pki;
      const session = bridge
        ? await bridge.getSession()
        : ((await (await fetch("/__pki/session")).json()) as { token: string });
      const res = await fetch("/api/tombstones", {
        headers: { authorization: `Bearer ${session.token}` },
      });
      return (await res.json()) as { tombstones: { reason: string }[] };
    });
    expect(tombstones.tombstones.map((t) => t.reason)).toEqual(["source-deleted"]);
  });

  if (target === "browser") {
    await test.step("C24: everything in the data directory is accounted for", async () => {
      // the backend has closed the database once its process has ended
      for (const close of closers.splice(0).reverse()) await close();
      const check = spawnSync(
        process.execPath,
        [join(ROOT, "backend/src/data-dir-check.e2e.ts"), "--data-dir", join(dir, "data")],
        { encoding: "utf8" },
      );
      expect(check.stdout).toBe("");
      expect(check.status).toBe(0);
    });
  }
});

test("local-files.e2e: pause → resume → revoke through the confirm dialog, the files stay on disk (I02B-T04 C13, C28)", async ({
  target,
  playwright,
}) => {
  test.skip(
    target !== "browser",
    "one browser flow; the Electron shell adds nothing to the lifecycle",
  );
  const docs = join(dir, "docs");
  mkdirSync(docs);
  for (const [name, record] of FILES) {
    const file = join(docs, name);
    writeFileSync(file, content(record));
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(file, old, old);
  }
  const page = await startStack(target, docs, playwright.chromium);
  const table = page.getByRole("table", { name: "로컬 자료 위치" });

  await test.step("approve, then read the files into sources", async () => {
    await go(page, "설정");
    await page.getByLabel("폴더 경로(개발용)").fill(docs);
    await page.getByRole("button", { name: "폴더 추가" }).click();
    await expect(table).toContainText(docs);
    await page.waitForTimeout(2_500);
    await go(page, "원본");
    await page.getByRole("button", { name: "local-files 동기화" }).click();
    await expect(async () => {
      await go(page, "설정");
      await go(page, "원본");
      await expect(page.getByRole("table").last().getByRole("row")).toHaveCount(3, {
        timeout: 1_000,
      });
    }).toPass({ timeout: 30_000 });
    await go(page, "설정");
  });

  await test.step("pause and resume from the row's buttons", async () => {
    await page.getByRole("button", { name: "일시 중지" }).click();
    await expect(table).toContainText("일시 중지");
    await page.getByRole("button", { name: "다시 켜기" }).click();
    await expect(table).toContainText("읽는 중");
  });

  await test.step("revoke: the dialog shows the count and the sentence; confirming removes the location", async () => {
    await page.getByRole("button", { name: "승인 철회" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("지워질 원본 3개");
    await expect(dialog).toContainText("이 폴더의 파일은 디스크에 그대로 남습니다");
    await dialog.getByRole("button", { name: "철회", exact: true }).click();
    await expect(page.getByText("추가한 폴더가 없습니다.")).toBeVisible();
    for (const [name] of FILES)
      expect(readFileSync(join(docs, name), "utf8").length).toBeGreaterThan(0);
    await go(page, "원본");
    // with no source left the screen draws no table but this sentence (the last table is another one)
    await expect(page.getByText("저장된 원본이 없습니다.")).toBeVisible();
  });
});
