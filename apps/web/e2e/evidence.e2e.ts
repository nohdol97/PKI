// V02-C2 in the browser and in the Electron shell (same file, `target`):
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
import { freePort, openEvidence, remote, ROOT } from "./v02-screens.ts";

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
    await openEvidence(stack.page, "plain");
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
