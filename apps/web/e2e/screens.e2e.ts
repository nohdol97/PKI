// V01-C1 (browser half): the four screens show what the dev backend serves. Each run
// starts the dev backend on its own synthetic seed and data directory behind the Vite
// dev server, so a value that does not change with the seed would be fixed in the UI.
import { expect, test, type Page } from "@playwright/test";
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

async function startStack({ titles, destination }: Seed) {
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
  const port = await freePort();
  const vite = await createServer({
    ...webConfig({ port, fixtures, dataDir }),
    configFile: false,
    logLevel: "warn",
  });
  await vite.listen();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    dataDir,
    async stop() {
      await vite.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
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
  test(`screens show seed ${index} from the backend`, async ({ page }) => {
    const { titles } = seed;
    const other = seeds[1 - index] as Seed;
    const stack = await startStack(seed);
    try {
      await page.goto(stack.url);

      await expect(page.getByRole("row", { name: /백엔드/ })).toContainText("준비됨");
      await expect(page.getByRole("row", { name: /벡터 색인/ })).toContainText("사용 불가");

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

test("the proxy path still requires the session token", async ({ request }) => {
  const stack = await startStack(seeds[0] as Seed);
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
    await stack.stop();
  }
});
