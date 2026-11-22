// V02-C4 (E2E part) and V02-C3 (re-import, persistence, `stale.e2e`) in the browser
// and in the Electron shell (same file, `target`; V02-R16, R17, spec "T11이 넘기는 것").
// v02-flow.e2e — the three synthetic sources are imported on the Sources screen, the
// running backend extracts and links them with the per-fixture Provider double, and
// Home shows the one dependency-delay Insight as an inference whose three evidence
// open their source version and span. Importing the same file again stores nothing
// and adds no Insight; after the backend (browser) or the whole app (Electron)
// restarts on the same data directory, the Insight and its evidence are still there.
// stale.e2e — after a source is deleted on the Sources screen, Home no longer shows
// the Insight; in the browser a second page that still holds the evidence open
// tells the source is gone on its next action instead of showing it.
// The Provider double is bound to the running backend by the test-build-only
// preload backend/src/v02-double.hook.e2e.ts: by --import in the dev backend, and in
// the shell through the test main apps/desktop/e2e/double-main.ts and the entry
// backend/src/v02-shell.e2e.ts. No product process gains a switch. Each passing
// flow writes its run record, Provider kind `test-double`, to test-results/v02-flow/.
import { _electron, test as base, expect, type BrowserType, type Page } from "@playwright/test";
import { ELECTRON, shellArgs } from "@pki/desktop";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "vite";
import { webConfig } from "../dev/dev-server.ts";
import {
  fixtureSetText,
  freePort,
  insightItems,
  openEvidence,
  recordTitle,
  remote,
  ROOT,
} from "./v02-screens.ts";

type Target = "browser" | "electron";
const test = base.extend<{ target: Target }>({ target: ["browser", { option: true }] });

/** The Provider the preload binds (backend/src/v02-double.e2e.ts): the record's one source. */
const PROVIDER = {
  kind: "test-double",
  id: "local-model",
  name: "@pki/testkit FakeProvider + fixtureExtraction",
} as const;
/** The dev backend takes the double's preload by --import; Electron starts on the
 * test main that makes the shell fork the double's backend entry. */
const BACKEND_PRELOAD = `--import=${pathToFileURL(join(ROOT, "backend/src/v02-double.hook.e2e.ts")).href}`;
const SHELL_MAIN = join(ROOT, "apps/desktop/e2e/double-main.ts");

interface Stack {
  page: Page;
  requested: string[];
  /** The shell's Electron version; undefined in the browser. */
  electron?: string;
  stop(): Promise<void>;
}

/** Opens the screens on `target` over `dir`'s data directory, the Provider double bound. */
async function startStack(target: Target, dir: string, chromium: BrowserType): Promise<Stack> {
  const dataDir = join(dir, "data");
  // An empty fixtures file: nothing but the screen's import puts sources in this DB.
  const fixtures = join(dir, "empty.jsonl");
  writeFileSync(fixtures, "");
  const requested: string[] = [];
  if (target === "electron") {
    // the shell's switches, after its app folder (which the test main replaces)
    const [, ...switches] = shellArgs({ userData: join(dir, "user"), dataDir, fixtures });
    const app = await _electron.launch({
      executablePath: ELECTRON,
      args: [SHELL_MAIN, ...switches],
    });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    window.on("request", (r) => requested.push(r.url()));
    const electron = await app.evaluate(() => process.versions.electron);
    return { page: window, requested, electron, stop: () => app.close() };
  }
  const port = await freePort();
  let backend: ChildProcess | undefined;
  const vite = await createServer({
    ...webConfig({
      port,
      fixtures,
      dataDir,
      env: { NODE_OPTIONS: BACKEND_PRELOAD },
      onBackend: (child) => (backend = child),
    }),
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
      // the next start reuses the data directory: the old backend must be gone first
      if (backend && backend.exitCode === null && backend.signalCode === null) {
        await once(backend, "exit");
      }
    },
  };
}

const go = (page: Page, screen: "홈" | "원본") =>
  page.getByRole("navigation").getByRole("button", { name: screen }).click();

/** Imports `file` on the Sources screen and checks the summary line. */
async function importFile(page: Page, file: string, received: number, created: number) {
  await go(page, "원본");
  await page.getByLabel("JSONL 파일 가져오기").setInputFiles(file);
  await expect(page.getByRole("status")).toHaveText(
    `변경 ${received}건을 읽어 새 version ${created}건을 저장했습니다. 거부된 줄 0건.`,
  );
}

/** Home rereads its Insights when entered: enter it until the extraction has ended. */
async function awaitInsight(page: Page) {
  await expect(async () => {
    await go(page, "원본");
    await go(page, "홈");
    await expect(insightItems(page)).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
}

/** Counts in the canonical DB, read after the backend has closed it. */
function countRows(dir: string) {
  const db = openBetterSqlite3(join(dir, "data", "pki.sqlite"));
  try {
    const one = (sql: string) => Number(db.all(sql)[0]?.n);
    return {
      sourceVersions: one("SELECT count(*) AS n FROM source_versions"),
      insights: one("SELECT count(*) AS n FROM insights"),
      activeInsights: one("SELECT count(*) AS n FROM insights WHERE state = 'active'"),
      jobsNotDone: one("SELECT count(*) AS n FROM jobs WHERE status <> 'done'"),
      providerCalls: Number(
        db.all("SELECT count(*) AS n FROM provider_calls WHERE provider = ? AND outcome = 'ok'", [
          PROVIDER.id,
        ])[0]?.n,
      ),
      droppedQuotes: one("SELECT coalesce(sum(dropped_quotes), 0) AS n FROM jobs"),
      droppedOther: one("SELECT coalesce(sum(dropped_other), 0) AS n FROM jobs"),
    };
  } finally {
    db.close();
  }
}

const git = (...args: string[]) =>
  spawnSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).stdout.trim();

// two starts of the whole stack and two evidence walks: 30 s is too short with
// the other E2E running beside it (observed in the full run, not alone)
test.describe.configure({ timeout: 90_000 });

let dir: string;
test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-e2e-flow-"));
});
test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("v02-flow.e2e: import → extraction → Insight → evidence, re-import, restart", async ({
  target,
  playwright,
}) => {
  const startedAt = new Date().toISOString();
  const file = join(dir, "v02-plain.jsonl");
  writeFileSync(file, fixtureSetText("plain"));
  const requested: string[] = [];

  let stack = await startStack(target, dir, playwright.chromium);
  try {
    await test.step("import the three sources; Home shows the Insight and its evidence", async () => {
      await importFile(stack.page, file, 3, 3);
      await awaitInsight(stack.page);
      await openEvidence(stack.page, "plain");
    });
    await test.step("import the same file again: nothing new, still one Insight", async () => {
      await importFile(stack.page, file, 3, 0);
      await go(stack.page, "홈");
      await expect(insightItems(stack.page)).toHaveCount(1);
    });
  } finally {
    requested.push(...stack.requested);
    await stack.stop();
  }
  const beforeRestart = countRows(dir);

  stack = await startStack(target, dir, playwright.chromium);
  try {
    await test.step("after the restart the Insight and its evidence are still there", async () => {
      await go(stack.page, "홈");
      await openEvidence(stack.page, "plain");
    });
  } finally {
    requested.push(...stack.requested);
    await stack.stop();
  }
  const afterRestart = countRows(dir);

  // re-import stored no version and called no Provider; one Insight row throughout
  const want = {
    sourceVersions: 3,
    insights: 1,
    activeInsights: 1,
    jobsNotDone: 0,
    providerCalls: 3,
    droppedQuotes: 0,
    droppedOther: 0,
  };
  expect(beforeRestart).toEqual(want);
  expect(afterRestart).toEqual(want);
  expect(requested.filter(remote)).toEqual([]);

  const record = {
    record: "v02-flow.e2e",
    status: "passed",
    provider: PROVIDER,
    target,
    os: `${platform()} ${release()} ${arch()}`,
    node: process.versions.node,
    electron: stack.electron ?? null,
    commit: git("rev-parse", "HEAD"),
    worktreeDirty: git("status", "--porcelain") !== "",
    startedAt,
    finishedAt: new Date().toISOString(),
    steps: ["import", "insight", "evidence", "re-import", "restart", "evidence-after-restart"],
    counts: afterRestart,
  };
  const out = join(ROOT, "test-results", "v02-flow");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `run-record.${target}.json`), `${JSON.stringify(record, null, 2)}\n`);
});

test("stale.e2e: after a source is deleted, Home no longer shows its Insight", async ({
  target,
  playwright,
}) => {
  const file = join(dir, "v02-plain.jsonl");
  writeFileSync(file, fixtureSetText("plain"));
  const messenger = recordTitle("v02-messenger.jsonl");
  const stack = await startStack(target, dir, playwright.chromium);
  const { page } = stack;
  try {
    await importFile(page, file, 3, 3);
    await awaitInsight(page);
    // the browser can hold a second page with the evidence open while the first deletes
    const other = target === "browser" ? await page.context().browser()?.newPage() : undefined;
    if (other) {
      await other.goto(page.url());
      await expect(insightItems(other)).toHaveCount(1);
      await insightItems(other)
        .first()
        .getByRole("button", { name: /근거 보기/ })
        .click();
      await expect(
        other.getByRole("list", { name: "근거 목록" }).getByRole("listitem"),
      ).toHaveCount(3);
    }

    await go(page, "원본");
    await page.getByRole("button", { name: `${messenger} 삭제` }).click();
    await page
      .getByRole("alertdialog", { name: "원본 삭제 확인" })
      .getByRole("button", { name: "지우기" })
      .click();
    await expect(page.getByRole("status")).toHaveText(`「${messenger}」을(를) 지웠습니다.`);
    await go(page, "홈");
    await expect(page.getByText("보여 줄 Insight가 없습니다.")).toBeVisible();
    await expect(insightItems(page)).toHaveCount(0);

    if (other) {
      const evidence = other.getByRole("list", { name: "근거 목록" }).getByRole("listitem");
      await evidence
        .filter({ hasText: messenger })
        .getByRole("button", { name: `원본 보기: ${messenger}` })
        .click();
      await expect(other.getByRole("alert")).toHaveText(
        "이 근거의 원본은 더 이상 없습니다. 삭제되었을 수 있습니다.",
      );
      await expect(evidence.filter({ hasText: messenger })).toHaveCount(0);
      await other.reload();
      await expect(other.getByText("보여 줄 Insight가 없습니다.")).toBeVisible();
    }
  } finally {
    await stack.stop();
  }
});
