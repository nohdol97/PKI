// H01-C1d (R15, R16) — the Settings screen in the browser: the backup folder is set, an encrypted backup is made
// and listed, the file is looked at with its passphrase and the restore is confirmed ("다시 시작하면 적용"), then
// cancelled and gone. Vite dev server and the dev backend on a temp data folder; the folder is typed into the
// development input (the Electron shell's picker takes the ticket path of local-files.e2e.ts).
import { test, expect, type Page } from "@playwright/test";
import { type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { webConfig } from "../dev/dev-server.ts";
import { freePort } from "./v02-screens.ts";

const PASSPHRASE = "e2e passphrase for the backup";

let dir: string;
const closers: (() => Promise<unknown>)[] = [];
test.beforeEach(() => void (dir = realpathSync(mkdtempSync(join(tmpdir(), "pki-e2e-backup-")))));
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

test.describe.configure({ timeout: 120_000 });

test("backup.e2e: set the folder → make a backup → it is listed → look at it → confirm the restore → cancel it", async ({
  playwright,
}) => {
  const backups = join(dir, "backups");
  mkdirSync(backups);
  const fixtures = join(dir, "empty.jsonl");
  writeFileSync(fixtures, "");
  const port = await freePort();
  const vite = await createServer({
    ...webConfig({
      port,
      fixtures,
      dataDir: join(dir, "data"),
      onBackend: (child) => closers.push(() => ended(child)),
    }),
    configFile: false,
    logLevel: "warn",
  });
  closers.push(() => vite.close());
  await vite.listen();
  const browser = await playwright.chromium.launch();
  closers.push(() => browser.close());
  const page: Page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}`);
  await page.getByRole("navigation").getByRole("button", { name: "설정" }).click();

  const section = page.getByRole("region", { name: "백업·복원" });
  await test.step("the five warnings are on the screen before anything is done", async () => {
    const warnings = section.getByRole("list", { name: "백업 전에 알아 둘 것" });
    await expect(warnings).toContainText("암호구를 잃으면");
    await expect(warnings).toContainText("비밀 값");
    await expect(warnings).toContainText("다시 시작");
    await expect(warnings).toContainText("이전 version");
    await expect(warnings).toContainText("먼저 백업");
  });

  await test.step("set the folder; a backup needs the passphrase typed twice", async () => {
    await expect(section.getByRole("button", { name: "백업 만들기" })).toBeDisabled();
    await section.getByLabel("백업 폴더 경로(개발용)").fill(backups);
    await section.getByRole("button", { name: "폴더 정하기" }).click();
    await expect(section).toContainText(backups);
    await section.getByLabel("암호구", { exact: true }).fill(PASSPHRASE);
    await section.getByLabel("암호구 확인").fill("something else entirely");
    await expect(section.getByRole("button", { name: "백업 만들기" })).toBeDisabled();
    await section.getByLabel("암호구 확인").fill(PASSPHRASE);
    await expect(section.getByRole("button", { name: "백업 만들기" })).toBeEnabled();
  });

  await test.step("the backup is made and listed; the passphrase fields are emptied", async () => {
    await section.getByRole("button", { name: "백업 만들기" }).click();
    const table = section.getByRole("table", { name: "백업 파일" });
    await expect(table).toContainText(".pkibak", { timeout: 60_000 });
    await expect(section.getByLabel("암호구", { exact: true })).toHaveValue("");
    expect(readdirSync(backups).filter((n) => n.endsWith(".pkibak"))).toHaveLength(1);
  });

  await test.step("look at the file; a wrong passphrase is told in words", async () => {
    await section.getByRole("button", { name: "살펴보기" }).click();
    await section.getByLabel("이 백업의 암호구").fill("not the passphrase at all");
    await section.getByRole("button", { name: "열어 보기" }).click();
    await expect(section.getByRole("alert")).toContainText("암호구가 맞지 않습니다", {
      timeout: 60_000,
    });
    await section.getByLabel("이 백업의 암호구").fill(PASSPHRASE);
    await section.getByRole("button", { name: "열어 보기" }).click();
    await expect(section.getByLabel("살펴본 결과")).toContainText("이 설치의 백업", {
      timeout: 60_000,
    });
  });

  await test.step("confirm the restore: it waits for the next start; cancel removes it", async () => {
    await section.getByRole("button", { name: "이 백업으로 복원" }).click();
    await expect(section.getByRole("status").filter({ hasText: "다시 시작하면 적용" })).toBeVisible(
      {
        timeout: 60_000,
      },
    );
    await section.getByRole("button", { name: "복원 취소" }).click();
    await expect(section.getByText("다시 시작하면 적용")).toHaveCount(0);
    await expect(section.getByRole("status")).toContainText("복원을 취소했습니다");
  });
});
