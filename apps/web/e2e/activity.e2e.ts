// I03-C3 `activity.e2e` (I03-R23): the Activity screen's job area on a backend started over a
// data directory that holds jobs in every state the screen words, in the browser and in the
// Electron shell (`target`, as screens.e2e). First test: what the screen shows (counts, hold
// reasons, next run, a period's merged count and pause, a projection's rebuild, the budget, the
// queue warning, the invalidation count, a sync's stale-tombstone and blocked counts and the
// missed-deletions mark). Second: what the user does (cancel, try again, discard after being
// asked, run a period now, turn it off and on, change it, ask for a rebuild) and that the screen
// reflects each. Rows are written before the backend starts; none of them is a kind the runner has a
// handler for unless the test means it to run (`e2e-idle` has none, so it stays where it is put).
import { test as base, expect, type BrowserType, type Locator, type Page } from "@playwright/test";
import { launchShell } from "@pki/desktop";
import {
  createSchedule,
  migrate,
  registerConnectorInstance,
  registerJob,
  saveSourceRecord,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

/** Filler rows: unfinished jobs of no kind the runner has, enough to pass 90% of the 1000 cap. */
const FILLER = 900;
/** The rows the screen is checked on; ids follow the filler. */
const ID = {
  syncDone: FILLER + 1,
  cleanupDone: FILLER + 2,
  retryMe: FILLER + 3,
  discardMe: FILLER + 4,
  cancelMe: FILLER + 5,
  rebuildDead: FILLER + 6,
  rebuildHeld: FILLER + 7,
  lineage: FILLER + 8,
  syncHeld: FILLER + 9,
  queued: FILLER + 10,
} as const;
const SCHEDULE = { cleanup: 1, sync: 2 } as const;

/** A sourceless job written in `status`; its other columns are what the rows of a real run hold. */
function row(
  db: SqlDriver,
  job: Parameters<typeof registerJob>[1],
  status: string,
  extra: { reason?: string; counts?: object } = {},
): number {
  const r = registerJob(db, job);
  if (!r.registered) throw new Error("not registered");
  const ended = ["succeeded", "cancelled", "dead_letter", "superseded"].includes(status);
  db.run(
    `UPDATE jobs SET status = ?, reason = ?, result_counts = ?, finished_at = ?,
       policy_fingerprint = ? WHERE id = ?`,
    [
      status,
      extra.reason ?? null,
      extra.counts ? JSON.stringify(extra.counts) : null,
      ended ? Date.now() : null,
      status === "held" ? "pf-e2e" : null, // a held job with a stamp is not put back by a start
      r.job.id,
    ],
  );
  return r.job.id;
}

function seedJobs(dataDir: string) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = openBetterSqlite3(join(dataDir, "pki.sqlite"));
  migrate(db);
  const now = new Date();
  registerConnectorInstance(db, "mail-1", "test-fixtures");
  saveSourceRecord(db, "mail-1", { externalId: "e1", title: "합성 제목", body: "합성 본문" });
  db.run(
    "INSERT INTO invalidations (change_seq, source_id, change_kind, at) VALUES (1, 1, 'new-version', ?)",
    [now.toISOString()],
  );
  const far = Date.parse("2100-01-01T00:00:00Z");
  const period = (p: object) => JSON.stringify(p);
  createSchedule(db, {
    kind: "maintenance",
    target: "",
    period: period({ kind: "daily", at: { hour: 3, minute: 0 } }),
    zone: "UTC",
    nextDue: far,
    at: now.getTime(),
  });
  createSchedule(db, {
    kind: "connector-sync",
    target: "mail-1",
    period: period({ kind: "hourly" }),
    zone: "UTC",
    nextDue: far,
    at: now.getTime(),
  });
  db.run(
    "UPDATE schedules SET coalesced_count = 3, held_coalesced_count = 2, skipped_count = 7 WHERE id = ?",
    [SCHEDULE.sync],
  );
  db.transaction(() => {
    for (let i = 0; i < FILLER; i++) {
      row(db, { kind: "e2e-idle", target: `filler-${i}`, at: now }, "held", {
        reason: "no-consent",
      });
    }
  });
  const ids = {
    syncDone: row(db, { kind: "connector-sync", target: "mail-1", at: now }, "succeeded", {
      counts: {
        received: 5,
        created: 3,
        staleTombstone: 2,
        blocked: 1,
        rescanned: 1,
        deletionsMayBeMissed: 1,
      },
    }),
    cleanupDone: row(db, { kind: "maintenance", at: now }, "succeeded", { counts: { purged: 4 } }),
    retryMe: row(db, { kind: "e2e-idle", target: "retry-me", at: now }, "dead_letter", {
      reason: "handler-error",
    }),
    discardMe: row(db, { kind: "e2e-idle", target: "discard-me", at: now }, "dead_letter", {
      reason: "handler-error",
    }),
    cancelMe: row(db, { kind: "e2e-idle", target: "cancel-me", at: now }, "held", {
      reason: "no-consent",
    }),
    rebuildDead: row(db, { kind: "projection-rebuild", target: "engine", at: now }, "dead_letter", {
      reason: "projection-error",
    }),
    rebuildHeld: row(db, { kind: "projection-rebuild", target: "engine", at: now }, "held", {
      reason: "no-consent",
    }),
    lineage: row(
      db,
      { kind: "extract", target: "lineage-retry:1", sourceId: 1, fenceVersion: 1, at: now },
      "superseded",
      { reason: "lineage-covered" },
    ),
    syncHeld: row(
      db,
      {
        kind: "connector-sync",
        target: "mail-1",
        schedule: { id: SCHEDULE.sync, slot: now.getTime() },
        at: now,
      },
      "held",
      { reason: "connector-unavailable" },
    ),
    queued: row(
      db,
      { kind: "e2e-idle", target: "queued-a", at: new Date(now.getTime() + 30 * 60_000) },
      "queued",
    ),
  };
  for (const [name, id] of Object.entries(ids)) {
    if (ID[name as keyof typeof ID] !== id) throw new Error(`seed id ${name}: ${id}`);
  }
  db.close();
}

async function startStack(dir: string, target: Target, chromium: BrowserType) {
  const fixtures = join(dir, "seed.jsonl");
  const dataDir = join(dir, "data");
  writeFileSync(fixtures, JSON.stringify({ externalId: "g-0", title: "합성", body: "합성 자료" }));
  seedJobs(dataDir);
  if (target === "electron") {
    const { app, window } = await launchShell({ userData: join(dir, "user"), dataDir, fixtures });
    return { page: window, stop: () => app.close() };
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
  await page.goto(`http://127.0.0.1:${port}`);
  return {
    page,
    async stop() {
      await browser.close();
      await vite.close();
    },
  };
}

const openActivity = (page: Page) =>
  page.getByRole("navigation").getByRole("button", { name: "활동" }).click();
const jobRow = (page: Page, id: number): Locator =>
  page
    .getByRole("table", { name: "작업 목록" })
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: String(id), exact: true }) });
const scheduleRow = (page: Page, id: number): Locator =>
  page
    .getByRole("table", { name: "주기 목록" })
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: String(id), exact: true }) });

test("the job area shows counts, reasons, next run, periods, projections, budget, the queue warning, invalidations and a sync's counts", async ({
  target,
  playwright,
}) => {
  const dir = mkdtempSync(join(tmpdir(), "pki-e2e-activity-"));
  const stack = await startStack(dir, target, playwright.chromium);
  const { page } = stack;
  try {
    if (target === "browser") {
      // I04-T09's count is not in the API of this base: a stub adds it to the real answer
      await page.route("**/api/status", async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as { invalidations: object };
        await route.fulfill({
          response,
          json: { ...body, invalidations: { ...body.invalidations, scopePolicyDrops: 4 } },
        });
      });
    }
    await openActivity(page);
    await expect(page.getByRole("heading", { name: "작업", exact: true })).toBeVisible();
    const counts = page.getByRole("list", { name: "상태별 작업 수" });
    await expect(counts.getByRole("listitem").filter({ hasText: /^보류 90\d$/ })).toHaveCount(1);
    await expect(counts.getByText("포기 3", { exact: true })).toBeVisible();
    await expect(counts.getByText("대기 1", { exact: true })).toBeVisible();
    // 900 held fillers and the open rows pass 90% of the cap
    await expect(page.getByRole("alert").filter({ hasText: "끝나지 않은 작업이" })).toBeVisible();
    await expect(page.getByText(/최근 \d+분 동안 Provider 호출 0 \/ \d+회/)).toBeVisible();

    await expect(jobRow(page, ID.cancelMe)).toContainText("Provider 전송 동의가 없음 (no-consent)");
    await expect(jobRow(page, ID.queued)).toContainText(/\d{4}-\d\d-\d\dT[\d:.]+Z/);
    await expect(jobRow(page, ID.lineage)).toContainText("추출되지 않은 version");
    const sync = jobRow(page, ID.syncDone);
    await expect(sync).toContainText("지연된 삭제(적용 안 됨) 2건");
    await expect(sync).toContainText("막힘 1건");
    await expect(sync).toContainText("만료된 동안 지워진 원본을 놓쳤을 수 있음");
    await expect(jobRow(page, ID.cleanupDone)).toContainText("정리한 기록 4건");

    const paused = scheduleRow(page, SCHEDULE.sync);
    await expect(paused).toContainText(
      "멈춤(보류: 수집기를 초기화하지 못해 실행할 수 없음 (connector-unavailable))",
    );
    await expect(paused.getByRole("cell", { name: "5", exact: true })).toBeVisible();
    await expect(paused.getByRole("cell", { name: "7", exact: true })).toBeVisible();

    await expect(
      page
        .getByRole("list", { name: "투영 상태" })
        .getByText(/engine: 재구축 반복 중\(투영 사용 불가\)/),
    ).toBeVisible();
    await expect(
      page.getByText(
        target === "browser"
          ? "최근 무효화 기록 1건, 범위 정책으로 빠진 항목 4건"
          : "최근 무효화 기록 1건",
        { exact: true },
      ),
    ).toBeVisible();
  } finally {
    await stack.stop();
  }
});

test("the user's actions reach the jobs and the screen shows them", async ({
  target,
  playwright,
}) => {
  const dir = mkdtempSync(join(tmpdir(), "pki-e2e-activity-"));
  const stack = await startStack(dir, target, playwright.chromium);
  const { page } = stack;
  const message = page.getByRole("status");
  try {
    await openActivity(page);

    await jobRow(page, ID.cancelMe)
      .getByRole("button", { name: `작업 ${ID.cancelMe} 취소` })
      .click();
    await expect(message).toHaveText("취소했습니다.");
    await expect(jobRow(page, ID.cancelMe)).toContainText("취소됨");

    await jobRow(page, ID.retryMe)
      .getByRole("button", { name: `작업 ${ID.retryMe} 다시 시도` })
      .click();
    await expect(message).toHaveText("다시 대기열에 넣었습니다.");
    await expect(jobRow(page, ID.retryMe)).toContainText("대기");
    await expect(jobRow(page, ID.retryMe)).toContainText("0 / 5");

    // a discard is asked first; "취소" in the question leaves the job as it was
    const ask = page.getByRole("alertdialog", { name: "작업 버리기 확인" });
    await jobRow(page, ID.rebuildDead)
      .getByRole("button", { name: `작업 ${ID.rebuildDead} 버리기` })
      .click();
    await expect(ask).toContainText(`작업 ${ID.rebuildDead}번`);
    await ask.getByRole("button", { name: "취소" }).click();
    await expect(ask).toHaveCount(0);
    await expect(jobRow(page, ID.rebuildDead)).toContainText("포기");
    await jobRow(page, ID.discardMe)
      .getByRole("button", { name: `작업 ${ID.discardMe} 버리기` })
      .click();
    await ask.getByRole("button", { name: "버리기" }).click();
    await expect(message).toHaveText("버렸습니다.");
    await expect(jobRow(page, ID.discardMe)).toContainText("취소됨");

    const cleanup = scheduleRow(page, SCHEDULE.cleanup);
    await cleanup.getByRole("button", { name: `주기 ${SCHEDULE.cleanup} 지금 실행` }).click();
    await expect(message).toHaveText("지금 실행하도록 등록했습니다.");
    // the cleanup handler runs it: a new row that counted what it purged
    await expect(
      page
        .getByRole("table", { name: "작업 목록" })
        .getByRole("row")
        .filter({ hasText: /정리.*정리한 기록 \d+건/ })
        .first(),
    ).toBeVisible();

    await cleanup.getByRole("button", { name: `주기 ${SCHEDULE.cleanup} 끄기` }).click();
    await expect(message).toHaveText("반영했습니다.");
    await expect(cleanup).toContainText("꺼짐");
    await cleanup.getByRole("button", { name: `주기 ${SCHEDULE.cleanup} 다시 켜기` }).click();
    await expect(cleanup).toContainText("켜짐");

    const form = page.getByRole("form", { name: `주기 ${SCHEDULE.cleanup} 바꾸기` });
    await form
      .getByRole("combobox", { name: `주기 ${SCHEDULE.cleanup} 종류` })
      .selectOption("weekly");
    await form.getByRole("combobox", { name: `주기 ${SCHEDULE.cleanup} 요일` }).selectOption("1");
    await form.getByLabel(`주기 ${SCHEDULE.cleanup} 시각`).fill("02:30");
    await form.getByRole("button", { name: "주기 바꾸기" }).click();
    await expect(cleanup).toContainText("매주 월요일 02:30");

    // an open rebuild exists: the ask is answered, not duplicated
    await page.getByRole("button", { name: "투영 engine 재구축" }).click();
    await expect(message).toHaveText("이 투영의 재구축이 이미 진행 중이거나 대기 중입니다.");
  } finally {
    await stack.stop();
  }
});
