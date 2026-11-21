// V01-C1: the four screens show what the backend serves, in the browser and in the
// Electron shell — this same file runs under both Playwright projects (`target`).
// Each run starts the backend on its own synthetic seed and data directory (behind the
// Vite dev server in the browser, as the shell's child process in Electron), so a value
// that does not change with the seed would be fixed in the UI. The two differ only in
// where the screen takes its session from (V01-R3).
import { test as base, expect, type BrowserType, type Page } from "@playwright/test";
import { launchShell } from "@pki/desktop";
import { migrate } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { sendRaw } from "@pki/testkit";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { DEV_SESSION_PATH } from "../src/api.ts";
import { webConfig } from "../dev/dev-server.ts";

type Target = "browser" | "electron";
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
  const vite = await startVite(fixtures, dataDir);
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

async function startVite(fixtures: string, dataDir: string) {
  const port = await freePort();
  const vite = await createServer({
    ...webConfig({ port, fixtures, dataDir }),
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

for (const [index, seed] of seeds.entries()) {
  test(`screens show seed ${index} from the backend`, async ({ target, playwright }) => {
    const { titles } = seed;
    const other = seeds[1 - index] as Seed;
    const stack = await startStack(seed, target, playwright.chromium);
    const { page } = stack;
    try {
      await expect(page.getByRole("row", { name: /백엔드/ })).toContainText("준비됨");
      await expect(page.getByRole("row", { name: /벡터 색인/ })).toContainText("사용 불가");
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
    } finally {
      await stack.stop();
    }
  });
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
