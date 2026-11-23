// V01-C4 API-key path, the screen (V01-R11, review A-F3/B-B1): Settings saves the
// OpenAI-compatible endpoint and model, shows the API key by presence only, and asks
// for the key again once the endpoint's host changes — the key is bound to the host it
// was entered for. Runs in the browser (development key from the environment) and in
// Electron (the shell's store; no key is saved there, so the real keychain is never
// touched: a presence check of a key that is not stored does not ask the OS).
import { test as base, expect, type BrowserType, type Page } from "@playwright/test";
import { launchShell } from "@pki/desktop";
import { openaiKeySecretName } from "@pki/providers";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
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

const DEV_KEY = `sk-e2e-dev-${randomUUID().slice(0, 8)}`;

async function open(
  target: Target,
  dir: string,
  chromium: BrowserType,
): Promise<{ page: Page; stop(): Promise<void> }> {
  const dataDir = join(dir, "data");
  if (target === "electron") {
    const { app, window } = await launchShell({ userData: join(dir, "user"), dataDir });
    return { page: window, stop: () => app.close() };
  }
  const port = await freePort();
  const vite = await createServer({
    ...webConfig({
      port,
      dataDir,
      env: {
        PKI_DEV_OPENAI_API_KEY_HOST: "one.synthetic.example",
        PKI_DEV_OPENAI_API_KEY: DEV_KEY,
      },
    }),
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

async function saveEndpoint(page: Page, url: string) {
  await page.getByLabel("주소", { exact: true }).fill(url);
  await page.getByLabel("모델", { exact: true }).fill("synthetic-model");
  await page.getByRole("button", { name: "주소 저장" }).click();
}

test("Settings saves the endpoint, shows the key by presence, and asks again for a new host", async ({
  target,
  playwright,
}) => {
  const dir = mkdtempSync(join(tmpdir(), "pki-e2e-provider-"));
  const { page, stop } = await open(target, dir, playwright.chromium);
  try {
    await page.getByRole("navigation").getByRole("button", { name: "설정" }).click();
    const keyRow = page.getByRole("row", { name: /API 키/ });
    await expect(keyRow).toContainText("주소를 먼저 저장하세요");

    await saveEndpoint(page, "https://one.synthetic.example/v1");
    if (target === "browser") {
      // the development key is set for this host
      await expect(keyRow).toContainText("저장됨 (one.synthetic.example에만 보냄)");
      await expect(page.getByText(/PKI_DEV_OPENAI_API_KEY_HOST/)).toBeVisible();
      await expect(page.getByLabel(/API 키/)).toHaveCount(0);
    } else {
      // the shell's store answers for this host's key: none yet, entry offered
      await expect(keyRow).toContainText("없음 — one.synthetic.example에 쓸 키를 입력하세요");
      await expect(page.getByLabel("one.synthetic.example에 쓸 API 키")).toBeEnabled();
      await expect(page.getByRole("button", { name: "키 저장" })).toBeDisabled();
    }

    await saveEndpoint(page, "https://two.synthetic.example/v1");
    await expect(keyRow).toContainText("없음 — two.synthetic.example에 쓸 키를 입력하세요");
    if (target === "electron") {
      await expect(page.getByLabel("two.synthetic.example에 쓸 API 키")).toBeVisible();
    }
    // the page never holds the key's value
    expect(await page.content()).not.toContain(DEV_KEY);
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// review N2: the key leaves the page as soon as it is handed to the preload. The
// browser stands in a recording preload (no real store, no keychain).
async function recordingPreload(page: Page) {
  await page.addInitScript(() => {
    const calls: unknown[] = [];
    Object.assign(window, {
      pkiCalls: calls,
      pki: {
        getSession: () => fetch("/__pki/session").then((r) => r.json()),
        // records the length only: the value stays out of the page's state
        setSecret: async (name: string, value: string) => (
          calls.push(["set", name, value.length]),
          { ok: true }
        ),
        deleteSecret: async (name: string) => (calls.push(["delete", name]), { ok: true }),
      },
    });
  });
}
const preloadCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { pkiCalls: unknown[] }).pkiCalls);

test("the key field hands the key to the preload under the host's name, then clears", async ({
  target,
  playwright,
}) => {
  test.skip(target !== "browser", "the Electron preload would reach the real keychain");
  const dir = mkdtempSync(join(tmpdir(), "pki-e2e-provider-key-"));
  const { page, stop } = await open(target, dir, playwright.chromium);
  try {
    await recordingPreload(page);
    await page.reload();
    await page.getByRole("navigation").getByRole("button", { name: "설정" }).click();
    await saveEndpoint(page, "https://one.synthetic.example/v1");
    const field = page.getByLabel("one.synthetic.example에 쓸 API 키");
    await field.fill("sk-e2e-typed");
    // I06F-C7 ①: while typing, the key is in the field only: not in the DOM's value attribute, not in the page
    expect((await field.getAttribute("value")) ?? "").not.toContain("sk-e2e-typed");
    expect(await page.content()).not.toContain("sk-e2e-typed");
    await page.getByRole("button", { name: "키 저장" }).click();
    await expect(field).toHaveValue("");
    expect(await preloadCalls(page)).toEqual([
      ["set", openaiKeySecretName("one.synthetic.example"), "sk-e2e-typed".length],
    ]);
    expect(await page.content()).not.toContain("sk-e2e-typed");
    // I06F-C12: a key typed for one host is gone when another host is saved, and is not sent anywhere
    await field.fill("sk-e2e-stale");
    await saveEndpoint(page, "https://two.synthetic.example/v1");
    const next = page.getByLabel("two.synthetic.example에 쓸 API 키");
    await expect(next).toHaveValue("");
    await expect(page.getByRole("button", { name: "키 저장" })).toBeDisabled();
    expect(await preloadCalls(page)).toEqual([
      ["set", openaiKeySecretName("one.synthetic.example"), "sk-e2e-typed".length],
    ]);
    expect(await page.content()).not.toContain("sk-e2e-stale");
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// I06F-C8: the key field refuses what the Sources screen's slot refuses, in the same words, in the alert place
// (not as "OS 보호 저장소"), and never asks the preload.
test("the key field refuses a pasted line break and a key over the limit in words, without asking the preload", async ({
  target,
  playwright,
}) => {
  test.skip(target !== "browser", "the Electron preload would reach the real keychain");
  const dir = mkdtempSync(join(tmpdir(), "pki-e2e-provider-refuse-"));
  const { page, stop } = await open(target, dir, playwright.chromium);
  try {
    await recordingPreload(page);
    await page.reload();
    await page.getByRole("navigation").getByRole("button", { name: "설정" }).click();
    await saveEndpoint(page, "https://one.synthetic.example/v1");
    const field = page.getByLabel("one.synthetic.example에 쓸 API 키");
    const alert = page.getByRole("alert");

    // C8 ①: a paste with a line break is cancelled, and what was typed stays
    await field.fill("abc");
    const letThrough = await field.evaluate((input) => {
      const data = new DataTransfer();
      data.setData("text/plain", "line1\nline2");
      return input.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    });
    expect(letThrough).toBe(false);
    await expect(alert).toContainText("한 줄 값만 넣을 수 있습니다");
    await expect(field).toHaveValue("abc");

    // C8 ②: over the limit is refused as the limit, never as the store's failure
    await field.fill("x".repeat(8193));
    await field.press("Enter");
    await expect(alert).toContainText("8192");
    await expect(alert).not.toContainText("OS 보호 저장소");
    await expect(field).toHaveValue("");

    // C8 ③
    expect(await preloadCalls(page)).toEqual([]);
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
