// V01-T16 / R5, C3, C6: the degraded states on screen, in the browser and in the
// Electron shell (`target`, as screens.e2e). The product as it ships already runs
// without an embedding model and without a vector index; the backend's PATH here
// holds no CLI, or only the fake CLI (never a real one). Home names what does not
// work and how to fix it, and the stored sources still list and search. Every
// prepare request the page sends is recorded: opening and cancelling the download
// approval sends none, and approving it (browser only, answered by a stub in place
// of the backend so nothing is downloaded) sends exactly the download source.
// "네트워크 없음" has no screen state of its own (nothing probes the network); the
// failures it causes are in backend/src/degraded.test.ts.
import { test as base, expect, type BrowserType, type Page } from "@playwright/test";
import { launchShell } from "@pki/desktop";
import { installFakeCli } from "@pki/testkit";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
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

const run = randomUUID().slice(0, 8);
const TITLES = [`합성 등대 점검 ${run}`, `합성 부두 공지 ${run}`] as const;

/** The screens over a backend whose PATH is `path`, on a fresh data directory. */
async function startStack(dir: string, path: string, target: Target, chromium: BrowserType) {
  const fixtures = join(dir, "seed.jsonl");
  const dataDir = join(dir, "data");
  writeFileSync(
    fixtures,
    TITLES.map((title, i) =>
      JSON.stringify({ externalId: `g-${i}`, title, body: "합성 자료" }),
    ).join("\n"),
  );
  if (target === "electron") {
    const { app, window } = await launchShell({
      userData: join(dir, "user"),
      dataDir,
      fixtures,
      env: { PATH: path },
    });
    return { page: window, stop: () => app.close() };
  }
  const port = await freePort();
  const vite = await createServer({
    ...webConfig({ port, fixtures, dataDir, env: { PATH: path } }),
    configFile: false,
    logLevel: "warn",
  });
  await vite.listen();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}`);
  return {
    page,
    async stop() {
      await browser.close();
      await vite.close();
    },
  };
}

/** The bodies of the prepare requests the page sends from now on. */
function prepareRequests(page: Page): unknown[] {
  const bodies: unknown[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/embedding/prepare") {
      bodies.push(request.postDataJSON());
    }
  });
  return bodies;
}

const openScreen = (page: Page, name: string) =>
  page.getByRole("navigation").getByRole("button", { name }).click();

async function chooseDefault(page: Page, name: string) {
  await openScreen(page, "설정");
  const radio = page.getByRole("radio", { name });
  await radio.click();
  await expect(radio).toBeChecked();
  await openScreen(page, "홈");
}

/** What every degraded state keeps (V01-R5): the stored list and keyword search. */
async function explorationWorks(page: Page) {
  await openScreen(page, "원본");
  await page.getByRole("button", { name: "fixtures 동기화" }).click();
  for (const title of TITLES) await expect(page.getByText(title)).toBeVisible();
  await page.getByRole("searchbox", { name: "검색어" }).fill("부두");
  await page.getByRole("button", { name: "검색" }).click();
  await expect(page.getByText(TITLES[1])).toBeVisible();
  await expect(page.getByText(TITLES[0])).toHaveCount(0);
}

test("no CLI, no model, no vector index: Home says so and guides; sources still list and search", async ({
  target,
  playwright,
}) => {
  const dir = mkdtempSync(join(tmpdir(), "pki-e2e-degraded-"));
  const noCli = join(dir, "no-cli");
  mkdirSync(noCli);
  const stack = await startStack(dir, noCli, target, playwright.chromium);
  const { page } = stack;
  const prepared = prepareRequests(page);
  try {
    const row = (name: RegExp) => page.getByRole("row", { name });
    await expect(row(/백엔드/)).toContainText("준비됨");
    await expect(row(/Provider/)).toContainText("기본 Provider가 정해지지 않음");
    await expect(row(/Embedding/)).toContainText("모델 없음, 키워드 검색으로 동작 (로컬 계산)");
    await expect(row(/벡터 색인/)).toContainText(
      "사용 불가: 이 빌드에는 벡터 색인이 없음, 키워드 검색으로 동작",
    );

    // CLI 없음: the chosen default CLI is missing, and Home shows how to install it
    await chooseDefault(page, "Claude Code");
    await expect(row(/Provider/)).toContainText("Claude Code: 설치되어 있지 않음");
    await expect(page.getByText(/^설치: https:\/\/code\.claude\.com/)).toBeVisible();

    // 모델 없음: a pack folder that is not there leaves the model unavailable, with why
    await page.getByRole("textbox", { name: "로컬 팩 폴더" }).fill(join(dir, "no-pack"));
    await page.getByRole("button", { name: "로컬 팩에서 준비" }).click();
    await expect(row(/Embedding/)).toContainText(
      "사용 불가: 모델 파일이 없음, 키워드 검색으로 동작 (로컬 계산)",
    );
    expect(prepared).toEqual([{ source: { kind: "local-pack", path: join(dir, "no-pack") } }]);
    // the download asks first, naming where from and how much; opening and
    // cancelling it sends nothing
    await page.getByRole("button", { name: "모델 내려받기…" }).click();
    const approval = page.getByRole("alertdialog", { name: "모델 내려받기" });
    await expect(approval).toContainText("huggingface.co");
    await expect(approval).toContainText("586 MB");
    await approval.getByRole("button", { name: "취소" }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await page.getByRole("button", { name: "모델 내려받기…" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "취소" }).click();
    expect(prepared).toHaveLength(1);

    await explorationWorks(page);
  } finally {
    await stack.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("전송 거부: an installed default without consent is shown blocked; sources still list and search", async ({
  target,
  playwright,
}) => {
  const dir = mkdtempSync(join(tmpdir(), "pki-e2e-degraded-"));
  const fake = installFakeCli({ auth: "logged-in" }, dir);
  const stack = await startStack(dir, fake.bin, target, playwright.chromium);
  const { page } = stack;
  try {
    await chooseDefault(page, "Codex CLI");
    await expect(page.getByRole("row", { name: /Provider/ })).toContainText(
      "Codex CLI: 전송이 막힘(외부 전송 동의 없음)",
    );
    await explorationWorks(page);
    expect(fake.modelCalls()).toBe(0);
  } finally {
    await stack.stop();
    expect(await fake.leftovers()).toEqual([]);
    fake.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approving the download sends exactly the download source, once", async ({
  target,
  playwright,
}) => {
  // page.route intercepts the browser's http requests; in Electron the app:// scheme
  // would reach the real backend and start a real download, so the approval runs here only
  test.skip(target !== "browser", "the approval is stubbed through the browser's http route");
  const dir = mkdtempSync(join(tmpdir(), "pki-e2e-degraded-"));
  const noCli = join(dir, "no-cli");
  mkdirSync(noCli);
  const stack = await startStack(dir, noCli, target, playwright.chromium);
  const { page } = stack;
  const prepared = prepareRequests(page);
  // answered here: the request never reaches the backend, so nothing is downloaded
  await page.route("**/api/embedding/prepare", (route) =>
    route.fulfill({ json: { embedding: { state: "model-missing", egress: "local" } } }),
  );
  try {
    await page.getByRole("button", { name: "모델 내려받기…" }).click();
    expect(prepared).toEqual([]);
    await page
      .getByRole("alertdialog", { name: "모델 내려받기" })
      .getByRole("button", { name: "내려받기 승인" })
      .click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect.poll(() => prepared.length).toBe(1);
    expect(prepared).toEqual([{ source: { kind: "download" } }]);
  } finally {
    await stack.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
