// V01-C5 `egress-label.e2e` (V01-R12, R13 display): CLI calls appear as external
// egress on the Activity screen and in Settings, and the words "로컬 추론" appear
// nowhere; Settings shows "데이터베이스 암호화: 적용 안 됨" read from the canonical
// file. The consent screen gives and revokes consent, and the egress policy over
// the same canonical file then decides accordingly: the screen is wired to it.
import { expect, test, type Page, type Request } from "@playwright/test";
import { createCallRecorder, createEgressPolicy, OPENAI_BASE_URL_SETTING } from "@pki/providers";
import { migrate, writeSetting } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { webConfig } from "../dev/dev-server.ts";

/** The backend's CANONICAL_DB_FILE inside the run's data directory. */
const dbFile = (dataDir: string) => join(dataDir, "pki.sqlite");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

/** Writes this run's history with the Broker's history writer, before the backend starts. */
function seedHistory(dataDir: string, requestId: string) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = openBetterSqlite3(dbFile(dataDir));
  migrate(db);
  const recorder = createCallRecorder(db);
  const base = { requestId, taskKind: "connection-test", classification: "synthetic" } as const;
  recorder.record({
    ...base,
    attempt: 1,
    providerId: "claude-code",
    outcome: "ok",
    destination: "vendor:claude-code",
    policyVersion: "pv-e2e",
    durationMs: 9,
  });
  recorder.record({
    ...base,
    attempt: 2,
    providerId: "codex",
    outcome: "blocked",
    reason: "no-consent",
  });
  db.close();
}

/** Asks the egress policy over the run's canonical file, as the Broker would. */
function decideFor(dataDir: string, providerId: "claude-code" | "codex") {
  const db = openBetterSqlite3(dbFile(dataDir));
  try {
    return createEgressPolicy({ db }).decide({
      providerId,
      taskKind: "connection-test",
      classification: "synthetic",
    });
  } finally {
    db.close();
  }
}

function setEndpoint(dataDir: string, url: string) {
  const db = openBetterSqlite3(dbFile(dataDir));
  try {
    writeSetting(db, OPENAI_BASE_URL_SETTING, url);
  } finally {
    db.close();
  }
}

const openScreen = (page: Page, name: string) =>
  page.getByRole("navigation").getByRole("button", { name }).click();

test("CLI calls show as external egress, consent is given and revoked, encryption is shown", async ({
  page,
}) => {
  const dir = mkdtempSync(join(tmpdir(), "pki-e2e-egress-"));
  const dataDir = join(dir, "data");
  const requestId = `e2e-${randomUUID().slice(0, 8)}`;
  seedHistory(dataDir, requestId);
  const port = await freePort();
  const vite = await createServer({
    ...webConfig({ port, dataDir }),
    configFile: false,
    logLevel: "warn",
  });
  await vite.listen();
  try {
    await page.goto(`http://127.0.0.1:${port}`);

    await openScreen(page, "활동");
    const ran = page.getByRole("row", { name: /vendor:claude-code/ });
    await expect(ran).toContainText("claude-code");
    await expect(ran).toContainText("외부 전송");
    await expect(ran).toContainText("pv-e2e");
    const blocked = page.getByRole("row", { name: /no-consent/ });
    await expect(blocked).toContainText("codex");
    await expect(blocked).toContainText("외부 전송");
    await expect(blocked).toContainText("blocked");
    await expect(page.getByText("로컬 추론")).toHaveCount(0);

    await openScreen(page, "설정");
    await expect(page.getByRole("row", { name: /데이터베이스 암호화/ })).toContainText(
      "적용 안 됨",
    );
    await expect(page.getByText(/전송 정책 버전: pv-/)).toBeVisible();
    const codex = page.getByRole("row", { name: /^codex/ });
    await expect(codex).toContainText("외부 전송");
    await expect(codex).toContainText("vendor:codex");
    await expect(codex).toContainText("동의 없음");
    await expect(page.getByRole("row", { name: /openai-compatible/ })).toContainText("미설정");
    await expect(page.getByRole("button", { name: "openai-compatible 동의" })).toBeDisabled();
    expect(decideFor(dataDir, "codex")).toEqual({ allowed: false, reason: "no-consent" });

    // nothing is chosen by default; the button waits for a class
    const grant = page.getByRole("button", { name: "codex 동의", exact: true });
    await expect(page.getByRole("checkbox", { name: "codex 합성 허용" })).not.toBeChecked();
    await expect(grant).toBeDisabled();
    await page.getByRole("checkbox", { name: "codex 합성 허용" }).check();
    await grant.click();
    await expect(codex).toContainText("동의함: 합성");
    expect(decideFor(dataDir, "codex")).toMatchObject({
      allowed: true,
      destination: "vendor:codex",
    });
    expect(decideFor(dataDir, "claude-code")).toEqual({ allowed: false, reason: "no-consent" });

    await page.getByRole("button", { name: "codex 동의 철회" }).click();
    await expect(codex).toContainText("동의 없음");
    expect(decideFor(dataDir, "codex")).toEqual({ allowed: false, reason: "no-consent" });
    await expect(page.getByText("로컬 추론")).toHaveCount(0);

    // the endpoint changes after the screen was shown: the grant is refused, nothing stored.
    // The screen reads the consents more than once while it mounts (React StrictMode runs
    // the effect twice in development), so "one" being on screen does not mean every read
    // has reached the backend. A read that lands after the endpoint changed would show the
    // new endpoint and make the grant succeed. The endpoint is changed only once no read
    // is in flight, so the screen holds "one" whatever the order the reads were served in.
    let reads = 0;
    const isRead = (request: Request) =>
      request.method() === "GET" && new URL(request.url()).pathname === "/api/consents";
    page.on("request", (request) => isRead(request) && reads++);
    page.on("requestfinished", (request) => isRead(request) && reads--);
    page.on("requestfailed", (request) => isRead(request) && reads--);
    setEndpoint(dataDir, "https://one.synthetic.example/v1");
    await page.reload();
    await openScreen(page, "설정");
    const openai = page.getByRole("row", { name: /^openai-compatible/ });
    await expect(openai).toContainText("one.synthetic.example");
    await expect.poll(() => reads).toBe(0);
    setEndpoint(dataDir, "https://two.synthetic.example/v1");
    await page.getByRole("checkbox", { name: "openai-compatible 일반 허용" }).check();
    await page.getByRole("button", { name: "openai-compatible 동의", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("consent-stale");
    await expect(openai).toContainText("two.synthetic.example");
    await expect(openai).toContainText("동의 없음");
  } finally {
    await vite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
