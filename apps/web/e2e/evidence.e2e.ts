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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { webConfig } from "../dev/dev-server.ts";

type Target = "browser" | "electron";
const test = base.extend<{ target: Target }>({ target: ["browser", { option: true }] });

const ROOT = resolve(import.meta.dirname, "../../..");
const SEED = join(ROOT, "backend/src/v02-seed.e2e.ts");
interface Evidence {
  record_id: string;
  version: number;
  quote: string;
}
const expected = JSON.parse(readFileSync(join(ROOT, "fixtures/v02-expected.json"), "utf8")) as {
  sets: Record<string, { insights: { evidence: Evidence[] }[] }>;
};
const titleOf = new Map(
  ["v02-mail.jsonl", "v02-wiki.jsonl", "v02-messenger.jsonl", "v02-malicious.jsonl"].flatMap(
    (file) =>
      readFileSync(join(ROOT, "fixtures", file), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { id: string; title: string })
        .map((r) => [r.id, r.title] as const),
  ),
);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

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

/** A request that would leave this machine: http(s) to anything but loopback. */
const remote = (url: string) => {
  const { protocol, hostname } = new URL(url);
  return (protocol === "http:" || protocol === "https:") && hostname !== "127.0.0.1";
};

/** Opens the one Insight's evidence by keyboard, checks each source span, returns the source view. */
async function openEvidence(page: Page, set: string) {
  const insights = page.getByRole("list", { name: "Insight 목록" }).getByRole("listitem");
  await expect(insights).toHaveCount(1);
  const insight = insights.first();
  await expect(insight.getByText("추론", { exact: true })).toBeVisible();
  await expect(insight).toContainText("확정 사실이 아닙니다");
  await expect(page.getByText("확정", { exact: true })).toHaveCount(0);

  const open = insight.getByRole("button", { name: /근거 보기/ });
  await open.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "근거", exact: true })).toBeFocused();
  const list = page.getByRole("list", { name: "근거 목록" }).getByRole("listitem");
  const want = expected.sets[set]?.insights[0]?.evidence ?? [];
  await expect(list).toHaveCount(want.length);
  expect(want).toHaveLength(3);

  const source = page.getByRole("region", { name: "원본 보기" });
  for (const evidence of want) {
    const title = titleOf.get(evidence.record_id) as string;
    const item = list.filter({ hasText: title });
    await expect(item).toContainText(`version ${evidence.version}`);
    await expect(item).toContainText(evidence.quote);
    await item.getByRole("button", { name: `원본 보기: ${title}` }).press("Enter");
    await expect(source.getByRole("heading", { name: title })).toBeVisible();
    await expect(source.getByRole("heading", { name: "원본 보기" })).toBeFocused();
    await expect(source).toContainText(`version ${evidence.version}`);
    await expect(source.getByText("가져온 자료(신뢰하지 않음)")).toBeVisible();
    await expect(source.locator("mark")).toHaveText(evidence.quote);
    // long lines wrap: the stylesheet loads under the shell's CSP too
    await expect(source.locator("pre")).toHaveCSS("white-space", "pre-wrap");
  }
  // reopening the same evidence moves focus to the source heading again
  const last = titleOf.get(want[want.length - 1]?.record_id ?? "") as string;
  const reopen = list.filter({ hasText: last }).getByRole("button", { name: `원본 보기: ${last}` });
  await reopen.focus();
  await page.keyboard.press("Enter");
  await expect(source.getByRole("heading", { name: "원본 보기" })).toBeFocused();
  return source;
}

test("evidence.e2e: the Insight's three evidence open their source version and span", async ({
  target,
  playwright,
}) => {
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
