// V01-C4 `connection-test.e2e` (V01-R21), the T09 part: in Settings, "연결 시험"
// shows the result or the block reason the backend's Broker returned, and the
// background setting starts off and keeps what the user sets. The product binds
// no Provider until V01-T10/T11, and this backend runs unbundled (a production
// build), so the real answer is "no Provider". The unverified-isolation
// confirmation appears only in a development build with an unlisted CLI, which
// the backend's integration test covers (backend/src/cli-gate.test.ts); here the
// screen's side of it runs against answers routed in place of the backend's, and
// the test checks what the screen sends. Choosing between two CLIs is V01-T10's.
import { expect, test, type Page } from "@playwright/test";
import type { ConnectionTestResult } from "@pki/contracts";
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

test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pki-e2e-conn-"));
  port = await freePort();
  vite = await createServer({
    ...webConfig({ port, dataDir: join(dir, "data") }),
    configFile: false,
    logLevel: "warn",
  });
  await vite.listen();
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
  await expect(page.getByRole("status")).toHaveText("결과: 차단: 연결할 Provider가 없음");
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
