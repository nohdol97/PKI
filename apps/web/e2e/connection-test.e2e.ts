// V01-C4 `connection-test.e2e` (V01-R21), the T09 part: in Settings, "연결 시험"
// shows the result or the block reason the backend's Broker returned, and the
// background setting starts off and keeps what the user sets. The product binds the
// OpenAI-compatible Provider (V01-T11) and no endpoint is set here, so the real
// answer is the egress decision's "no destination". The unverified-isolation
// confirmation appears only in a development build with an unlisted CLI, which
// the backend's integration test covers (backend/src/cli-gate.test.ts); here the
// screen's side of it runs against answers routed in place of the backend's, and
// the test checks what the screen sends. The T10 part: with the fake CLIs on the
// backend's PATH (never a real CLI), "Provider 확인" finds both, the user picks
// the default, and the next connection test goes to that Provider (its blocked
// attempt in Activity names it: there is no consent here).
import { expect, test, type Page } from "@playwright/test";
import type { ConnectionTestResult } from "@pki/contracts";
import { installFakeCli } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { webConfig } from "../dev/dev-server.ts";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

const openSettings = (page: Page) =>
  page.getByRole("navigation").getByRole("button", { name: "설정" }).click();

let dir: string;
let vite: ViteDevServer;
let port: number;

/** The dev server and its backend; `env` replaces the backend's environment variables. */
async function startVite(env?: Record<string, string>) {
  port = await freePort();
  vite = await createServer({
    ...webConfig({ port, dataDir: join(dir, "data"), ...(env ? { env } : {}) }),
    configFile: false,
    logLevel: "warn",
  });
  await vite.listen();
}

test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pki-e2e-conn-"));
  await startVite();
});
test.afterEach(async () => {
  await vite.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the connection test shows the backend's block reason; background starts off", async ({
  page,
}) => {
  await page.goto(`http://127.0.0.1:${port}`);
  await openSettings(page);
  await page.getByRole("button", { name: "연결 시험", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("결과: 차단: 기본 Provider가 정해지지 않음");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);

  const background = page.getByRole("checkbox", { name: "CLI 백그라운드 실행 허용" });
  await expect(background).not.toBeChecked();
  // the box shows the saved value: it turns on when the backend answers, not on the click
  await background.click();
  await expect(background).toBeChecked();
  await page.reload();
  await openSettings(page);
  await expect(background).toBeChecked();
  await background.click();
  await expect(background).not.toBeChecked();
  await page.reload();
  await openSettings(page);
  await expect(background).not.toBeChecked();
});

test("an unverified CLI needs a confirmation for each call, sent with that call only", async ({
  page,
}) => {
  const sent: unknown[] = [];
  const answer = (body: { acknowledgeUnverified: boolean }): ConnectionTestResult =>
    body.acknowledgeUnverified
      ? { outcome: "ok", reason: null, isolation: "unverified" }
      : { outcome: "blocked", reason: "unverified-ack-required", isolation: null };
  await page.route("**/api/connection-test", async (route) => {
    const body = route.request().postDataJSON() as { acknowledgeUnverified: boolean };
    sent.push(body);
    await route.fulfill({ json: answer(body) });
  });
  await page.goto(`http://127.0.0.1:${port}`);
  await openSettings(page);
  const start = page.getByRole("button", { name: "연결 시험", exact: true });

  await start.click();
  const dialog = page.getByRole("alertdialog", { name: "격리 미검증" });
  await expect(dialog).toContainText("이번 한 번만");
  await expect(start).toBeDisabled();
  await dialog.getByRole("button", { name: "취소" }).click();
  await expect(dialog).toHaveCount(0);
  expect(sent).toEqual([{ acknowledgeUnverified: false }]);

  await start.click();
  await page.getByRole("button", { name: "이번 한 번 실행" }).click();
  await expect(page.getByRole("status")).toHaveText("결과: 성공(격리 미검증)");
  expect(sent).toEqual([
    { acknowledgeUnverified: false },
    { acknowledgeUnverified: false },
    { acknowledgeUnverified: true },
  ]);

  // the confirmation is not kept: the next test starts unconfirmed and asks again
  await start.click();
  await expect(dialog).toBeVisible();
  expect(sent.at(-1)).toEqual({ acknowledgeUnverified: false });
});

test("with both CLIs found, the user picks the default and the next test goes to it", async ({
  page,
}) => {
  const fake = installFakeCli({ auth: "logged-in" }, dir);
  await vite.close();
  await startVite({ PATH: fake.bin });
  await page.goto(`http://127.0.0.1:${port}`);
  await openSettings(page);
  const chooser = page.getByRole("group", { name: "기본 Provider" });
  const claude = chooser.getByRole("radio", { name: "Claude Code" });
  const codex = chooser.getByRole("radio", { name: "Codex CLI" });
  await expect(claude).not.toBeChecked();
  await expect(codex).not.toBeChecked();

  await page.getByRole("button", { name: "Provider 확인" }).click();
  await expect(
    page.getByText("Claude Code: 설치됨(2.1.3), 로그인 상태를 알 수 없음"),
  ).toBeVisible();
  await expect(page.getByText("Codex CLI: 설치됨(2.1.3), 로그인됨")).toBeVisible();

  const start = page.getByRole("button", { name: "연결 시험", exact: true });
  const activityProviders = async () => {
    await page.getByRole("navigation").getByRole("button", { name: "활동" }).click();
    const cells = page.getByRole("row").locator("td:nth-child(2)");
    await expect(cells.first()).toBeVisible();
    const names = await cells.allTextContents();
    await openSettings(page);
    return names.sort();
  };

  await codex.click(); // checked when the backend answers, not on the click
  await expect(codex).toBeChecked();
  await start.click();
  await expect(page.getByRole("status")).toHaveText("결과: 차단: 외부 전송 동의 없음");
  expect(await activityProviders()).toEqual(["codex"]);

  await claude.click();
  await expect(claude).toBeChecked();
  await start.click();
  await expect(page.getByRole("status")).toHaveText("결과: 차단: 외부 전송 동의 없음");
  expect(await activityProviders()).toEqual(["claude-code", "codex"]);

  // the choice is the backend's: a reload shows it
  await page.reload();
  await openSettings(page);
  await expect(claude).toBeChecked();
  expect(fake.modelCalls()).toBe(0);
  expect(await fake.leftovers()).toEqual([]);
  fake.dispose();
});

test("a connection test the default CLI cannot serve shows how to install it", async ({ page }) => {
  // the backend's answer when the default CLI is not installed (backend/src/providers-api.test.ts)
  await page.route("**/api/connection-test", (route) =>
    route.fulfill({
      json: {
        outcome: "blocked",
        reason: "cli-not-verified",
        isolation: null,
        providerCheck: {
          providerId: "claude-code",
          installed: false,
          version: null,
          authentication: "unknown",
        },
      } satisfies ConnectionTestResult,
    }),
  );
  await page.goto(`http://127.0.0.1:${port}`);
  await openSettings(page);
  await page.getByRole("button", { name: "연결 시험", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(
    "결과: 차단: 격리가 검증된 CLI 조합(버전·OS·인자 프로필)이 아님",
  );
  await expect(page.getByText("Claude Code: 설치되어 있지 않음. 설치:")).toBeVisible();
});
