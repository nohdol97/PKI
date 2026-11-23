// V01-C1: the four screens show what the backend serves, in the browser and in the
// Electron shell — this same file runs under both Playwright projects (`target`).
// Each run starts the backend on its own synthetic seed and data directory (behind the
// Vite dev server in the browser, as the shell's child process in Electron), so a value
// that does not change with the seed would be fixed in the UI. The two differ only in
// where the screen takes its session from (V01-R3).
// V01-C7 `screens.e2e`(double 구성) (V01-R17, spec "T17이 넘기는 것" 3): the same
// screens test runs again on a backend whose Provider and Embedding implementations
// are replaced by doubles (the preload backend/src/swap-double.hook.e2e.ts; browser
// only, provisional). Since the screens are meant not to change, passing alone would
// not tell the doubles were bound: in that configuration the test also runs a
// connection test that succeeds only through the Provider double and prepares a
// local pack that only the embedder double accepts.
import { test as base, expect, type BrowserType, type Page } from "@playwright/test";
import { launchShell } from "@pki/desktop";
import { migrate } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { sendRaw } from "@pki/testkit";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "vite";
import { DEV_SESSION_PATH } from "../src/api.ts";
import { webConfig } from "../dev/dev-server.ts";

type Target = "browser" | "electron";
/** The product's composition, or the Provider and Embedding replaced by doubles. */
type Config = "product" | "swapped";
const SWAP_PRELOAD = `--import=${pathToFileURL(resolve(import.meta.dirname, "../../../backend/src/swap-double.hook.e2e.ts")).href}`;
const test = base.extend<{ target: Target }>({ target: ["browser", { option: true }] });

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

interface Seed {
  titles: readonly [string, string];
  /** Destination of the one provider call recorded in this run's DB before start. */
  destination: string;
}

/**
 * Nothing writes provider_calls yet (T07/T08), so the run's DB gets one row up front.
 * The file name is the backend's CANONICAL_DB_FILE; a wrong name leaves Activity empty
 * and the run fails.
 */
function seedProviderCall(dataDir: string, destination: string) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = openBetterSqlite3(join(dataDir, "pki.sqlite"));
  migrate(db);
  db.run(
    `INSERT INTO provider_calls (request_id, attempt, provider, destination, task_kind,
       classification, policy_version, outcome, duration_ms, created_at)
     VALUES ('e2e-r1', 1, 'fake', ?, 'connection-test', 'synthetic', 'p1', 'ok', 7,
       '2026-11-21T00:00:00Z')`,
    [destination],
  );
  db.close();
}

interface Stack {
  page: Page;
  dataDir: string;
  stop(): Promise<void>;
}

/** Seeds a fresh data directory and fixtures file, then opens the screens on `target`. */
async function startStack(
  { titles, destination }: Seed,
  target: Target,
  chromium: BrowserType,
  config: Config = "product",
): Promise<Stack> {
  const dir = mkdtempSync(join(tmpdir(), "pki-e2e-"));
  const fixtures = join(dir, "seed.jsonl");
  const dataDir = join(dir, "data");
  seedProviderCall(dataDir, destination);
  writeFileSync(
    fixtures,
    titles
      .map((title, i) => JSON.stringify({ externalId: `e2e-${i}`, title, body: `합성 자료 ${i}` }))
      .join("\n"),
  );
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  if (target === "electron") {
    const { app, window } = await launchShell({ userData: join(dir, "user"), dataDir, fixtures });
    return { page: window, dataDir, stop: async () => (await app.close(), cleanup()) };
  }
  const vite = await startVite(
    fixtures,
    dataDir,
    config === "swapped" ? { NODE_OPTIONS: SWAP_PRELOAD } : undefined,
  );
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(vite.url);
  return {
    page,
    dataDir,
    async stop() {
      await browser.close();
      await vite.close();
      cleanup();
    },
  };
}

async function startVite(fixtures: string, dataDir: string, env?: Record<string, string>) {
  const port = await freePort();
  const vite = await createServer({
    ...webConfig({ port, fixtures, dataDir, ...(env ? { env } : {}) }),
    configFile: false,
    logLevel: "warn",
  });
  await vite.listen();
  return { url: `http://127.0.0.1:${port}`, port, close: () => vite.close() };
}

const run = randomUUID().slice(0, 8);
const seeds: readonly Seed[] = [
  {
    titles: [`합성 등대 점검 알파 ${run}`, `합성 항만 예산 알파 ${run}`],
    destination: `alpha-${run}.synthetic.example`,
  },
  {
    titles: [`합성 등대 점검 베타 ${run}`, `합성 부두 공지 베타 ${run}`],
    destination: `beta-${run}.synthetic.example`,
  },
];

const openScreen = (page: Page, name: string) =>
  page.getByRole("navigation").getByRole("button", { name }).click();

const configs: readonly Config[] = ["product", "swapped"];

for (const config of configs) {
  for (const [index, seed] of seeds.entries()) {
    // the swapped configuration runs on seed 0 only: seed 1 on the product configuration shows seed variance
    if (config === "swapped" && index !== 0) continue;
    const name = config === "product" ? "" : " with the Provider and Embedding swapped";
    test(`screens show seed ${index} from the backend${name}`, async ({ target, playwright }) => {
      test.skip(
        config === "swapped" && target !== "browser",
        "the swapped configuration binds its doubles through the dev backend's preload (browser)",
      );
      test.skip(
        target === "electron" && index === 1,
        "seed variance is a property of the web bundle (browser); the shell run keeps seed 0",
      );
      const { titles } = seed;
      const other = seeds[1 - index] as Seed;
      const stack = await startStack(seed, target, playwright.chromium, config);
      const { page } = stack;
      try {
        await expect(page.getByRole("row", { name: /백엔드/ })).toContainText("준비됨");
        await expect(page.getByRole("row", { name: /벡터 색인/ })).toContainText("사용 불가");
        await frameLooksRight(page, target);
        // The product binds the local embedder (V01-T14); no model is prepared by itself.
        await expect(page.getByRole("row", { name: /Embedding/ })).toContainText(
          "모델 없음, 키워드 검색으로 동작 (로컬 계산)",
        );

        await openScreen(page, "원본");
        for (const kind of ["site-mail", "site-messenger", "site-wiki"]) {
          await expect(page.getByRole("row", { name: new RegExp(kind) })).toContainText(
            "미구현(배포처 후속)",
          );
        }
        await expect(page.getByText("저장된 원본이 없습니다.")).toBeVisible();
        await page.getByRole("button", { name: "fixtures 동기화" }).click();
        for (const title of titles) await expect(page.getByText(title)).toBeVisible();
        for (const title of other.titles) await expect(page.getByText(title)).toHaveCount(0);

        await page.getByRole("searchbox", { name: "검색어" }).fill("등대");
        await page.getByRole("button", { name: "검색" }).click();
        await expect(page.getByText(titles[0])).toBeVisible();
        await expect(page.getByText(titles[1])).toHaveCount(0);

        await openScreen(page, "활동");
        await expect(page.getByRole("row", { name: new RegExp(seed.destination) })).toContainText(
          "connection-test",
        );
        await expect(page.getByText(other.destination)).toHaveCount(0);

        await openScreen(page, "설정");
        await expect(page.getByRole("row", { name: /데이터 폴더/ })).toContainText(stack.dataDir);
        if (config === "swapped") await doublesAnswer(page, stack.dataDir);
      } finally {
        await stack.stop();
      }
    });
  }
}

/**
 * UI01-C6: the shared frame and the bundled font, in the browser and under the shell's CSP:
 * the body is set in Pretendard (the font file was loaded, not just named), menu on the left
 * of the content and the status line under both; in the shell no inline style at all.
 */
async function frameLooksRight(page: Page, target: Target) {
  const frame = await page.evaluate(async () => {
    await document.fonts.load('16px "Pretendard Variable"');
    const box = (selector: string) => {
      const r = (document.querySelector(selector) as Element).getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    const body = getComputedStyle(document.body);
    return {
      family: body.fontFamily,
      background: body.backgroundColor,
      checked: document.fonts.check('16px "Pretendard Variable"'),
      loaded: [...document.fonts].some(
        (f) => f.family.includes("Pretendard Variable") && f.status === "loaded",
      ),
      nav: box("nav"),
      main: box("main"),
      status: box("footer"),
      inlineStyles: document.querySelectorAll("[style], style").length,
    };
  });
  expect(frame.family.startsWith('"Pretendard Variable"')).toBe(true);
  expect(frame.checked && frame.loaded).toBe(true);
  expect(frame.background).toBe("rgb(246, 245, 242)");
  expect(frame.nav.right).toBeLessThanOrEqual(frame.main.left);
  expect(frame.status.top).toBeGreaterThanOrEqual(Math.max(frame.nav.bottom, frame.main.bottom));
  // the dev server injects its stylesheets as <style>, so only the shell's build is checked
  if (target === "electron") expect(frame.inlineStyles).toBe(0);
}

/**
 * The swapped configuration only, from Settings: choosing the Provider double and
 * consenting as a user would, the connection test succeeds (the product's dev backend
 * binds no such Provider), and a local pack prepares (the product's embedder would
 * find no model files there).
 */
async function doublesAnswer(page: Page, dataDir: string) {
  const radio = page.getByRole("group", { name: "기본 Provider" }).getByRole("radio", {
    name: "로컬 모델",
  });
  await radio.click();
  await expect(radio).toBeChecked();
  await page.getByRole("checkbox", { name: "local-model 합성 허용" }).check();
  await page.getByRole("button", { name: "local-model 동의", exact: true }).click();
  await expect(page.getByRole("row", { name: /^local-model/ })).toContainText("동의함: 합성");
  await page.getByRole("button", { name: "연결 시험", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("결과: 성공");

  await openScreen(page, "홈");
  await page.getByRole("textbox", { name: "로컬 팩 폴더" }).fill(join(dataDir, "pack"));
  await page.getByRole("button", { name: "로컬 팩에서 준비" }).click();
  await expect(page.getByRole("row", { name: /Embedding/ })).toContainText("준비됨 (로컬 계산)");
}

test("the proxy path still requires the session token", async ({ target, request }) => {
  test.skip(target !== "browser", "the Vite proxy and /__pki/session exist only in the browser");
  const dir = mkdtempSync(join(tmpdir(), "pki-e2e-"));
  const fixtures = join(dir, "seed.jsonl");
  writeFileSync(fixtures, JSON.stringify({ externalId: "e2e-0", title: "합성", body: "합성" }));
  const stack = await startVite(fixtures, join(dir, "data"));
  try {
    const bare = await request.get(`${stack.url}/api/status`);
    expect(bare.status()).toBe(401);
    expect(await bare.json()).toEqual({ error: "unauthorized" });

    const session = await (await request.get(`${stack.url}${DEV_SESSION_PATH}`)).json();
    const authorized = await request.get(`${stack.url}/api/status`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(authorized.status()).toBe(200);

    // Another local page (Vite allows localhost origins by default) cannot read the session.
    const crossOrigin = await request.get(`${stack.url}${DEV_SESSION_PATH}`, {
      headers: { origin: "http://localhost:3000" },
    });
    expect(crossOrigin.headers()["access-control-allow-origin"]).toBeUndefined();

    // Another host name for this address (DNS rebinding) gets no session.
    const rebound = await sendRaw(stack.port, [
      `GET ${DEV_SESSION_PATH} HTTP/1.1`,
      `Host: evil.example:${stack.port}`,
      "Connection: close",
    ]);
    expect(rebound).toBe(403);
  } finally {
    await stack.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
