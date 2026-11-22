// I06-R14, R17 (I06-C11) on the Sources screen, in the browser: an instance that declared a credential slot
// shows the slot's state and the reason in words; where the shell's preload is (a recording double here, so no
// real store or keychain is touched) the slot takes a value, hands it to the preload under the listed name,
// tells the backend only the instance's ID and clears the field; without the preload no input is drawn.
// The list and the change notice are answered by the test (page.route): the value must appear in neither
// request, nor in the page.
import { expect, test as base, type Page, type Route } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { webConfig } from "../dev/dev-server.ts";

const test = base;
const NAME = `connector.${"c".repeat(32)}.token`;
const CANARY = "synthetic-e2e-credential-0001";
const NOTICE_PATH = "**/api/connectors/credentials-changed";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

type Slot = "missing" | "present";
interface Backend {
  /** The slot's state the list reports. */
  slot: Slot;
  /** What the next notice answers. */
  rebuild: "done" | "queued" | "skipped";
  lists: number;
  notices: { url: string; body: string }[];
}

/** Answers the list and the change notice; every request body is kept for the search for the value. */
async function stubBackend(page: Page, backend: Backend) {
  const summary = () => ({
    id: "mail-1",
    kind: "fork",
    state: backend.slot === "present" ? "ready" : "unavailable",
    ...(backend.slot === "present" ? {} : { reason: "credential-missing" }),
    credentials: [{ slot: "token", name: NAME, state: backend.slot }],
  });
  await page.route("**/api/connectors", (route: Route) => {
    backend.lists++;
    return route.fulfill({
      json: { connectors: [summary(), { id: "plain", kind: "fork", state: "ready" }] },
    });
  });
  await page.route(NOTICE_PATH, (route: Route) => {
    backend.notices.push({
      url: route.request().url(),
      body: route.request().postData() ?? "",
    });
    return route.fulfill({ json: { summary: summary(), rebuild: backend.rebuild } });
  });
}

/** A preload that records what the page hands it (the value's length only: it stays out of the page's state). */
async function recordingPreload(page: Page, setOk: boolean) {
  await page.addInitScript((ok: boolean) => {
    const calls: unknown[] = [];
    Object.assign(window, {
      pkiCalls: calls,
      pki: {
        getSession: () => fetch("/__pki/session").then((r) => r.json()),
        setSecret: async (name: string, value: string) => (
          calls.push(["set", name, value.length]),
          ok ? { ok: true } : { ok: false, error: "unavailable" }
        ),
        deleteSecret: async (name: string) => (calls.push(["delete", name]), { ok: true }),
      },
    });
  }, setOk);
}
const preloadCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { pkiCalls: unknown[] }).pkiCalls);

async function open(page: Page, backend: Backend) {
  const dir = mkdtempSync(join(tmpdir(), "pki-e2e-credential-"));
  const port = await freePort();
  const vite = await createServer({
    ...webConfig({ port, dataDir: join(dir, "data") }),
    configFile: false,
    logLevel: "warn",
  });
  await vite.listen();
  await stubBackend(page, backend);
  return {
    async show() {
      await page.goto(`http://127.0.0.1:${port}`);
      await page.getByRole("navigation").getByRole("button", { name: "원본" }).click();
    },
    async stop() {
      await vite.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const fresh = (over: Partial<Backend> = {}): Backend => ({
  slot: "missing",
  rebuild: "done",
  lists: 0,
  notices: [],
  ...over,
});

test("without the preload the slot and the reason are shown, and no input is drawn", async ({
  page,
}) => {
  const { show, stop } = await open(page, fresh());
  try {
    await show();
    const row = page.getByRole("row", { name: /mail-1/ });
    await expect(row).toContainText("자격 증명이 없습니다. 아래에 값을 입력하세요.");
    await expect(page.getByRole("list", { name: "mail-1 자격 증명" })).toContainText("token: 없음");
    await expect(row).toContainText("이 실행에는 저장소가 없습니다");
    await expect(page.getByLabel("mail-1 token 값")).toHaveCount(0);
    await expect(page.getByRole("row", { name: /plain/ })).not.toContainText("자격 증명");
  } finally {
    await stop();
  }
});

test("a value typed into the slot goes to the preload under the listed name, the notice carries the ID only, and the field clears", async ({
  page,
}) => {
  const backend = fresh();
  await recordingPreload(page, true);
  const { show, stop } = await open(page, backend);
  try {
    await show();
    const field = page.getByLabel("mail-1 token 값");
    const save = page.getByRole("button", { name: "mail-1 token 저장" });
    await expect(field).toHaveAttribute("type", "password");
    await expect(field).toHaveAttribute("autocomplete", "off");
    await expect(save).toBeDisabled(); // nothing typed
    await expect(page.getByRole("button", { name: "mail-1 token 삭제" })).toHaveCount(0);

    await field.fill(CANARY);
    backend.slot = "present"; // what the backend sees once the shell stored it
    await field.press("Enter"); // the keyboard submits like the button
    await expect(field).toHaveValue("");
    await expect(page.getByRole("status")).toContainText("반영했습니다.");
    expect(await preloadCalls(page)).toEqual([["set", NAME, CANARY.length]]);
    expect(backend.notices).toHaveLength(1);
    expect(backend.notices[0]?.url).toContain("/api/connectors/credentials-changed");
    expect(JSON.parse(backend.notices[0]?.body ?? "")).toEqual({ connectorId: "mail-1" });
    await expect(page.getByRole("list", { name: "mail-1 자격 증명" })).toContainText(
      "token: 저장됨",
    );
    expect(await page.content()).not.toContain(CANARY);
    expect(JSON.stringify(backend.notices)).not.toContain(CANARY);

    // the stored value can be deleted, by the keyboard too, and the same notice follows
    const remove = page.getByRole("button", { name: "mail-1 token 삭제" });
    await remove.focus();
    backend.slot = "missing";
    await page.keyboard.press("Enter");
    await expect(page.getByRole("list", { name: "mail-1 자격 증명" })).toContainText("token: 없음");
    expect(await preloadCalls(page)).toEqual([
      ["set", NAME, CANARY.length],
      ["delete", NAME],
    ]);
    expect(backend.notices).toHaveLength(2);
  } finally {
    await stop();
  }
});

test("a store the shell refuses is said so and gives no notice, and the field still clears", async ({
  page,
}) => {
  const backend = fresh();
  await recordingPreload(page, false);
  const { show, stop } = await open(page, backend);
  try {
    await show();
    const field = page.getByLabel("mail-1 token 값");
    await field.fill(CANARY);
    await page.getByRole("button", { name: "mail-1 token 저장" }).click();
    await expect(page.getByRole("status")).toContainText("자격 증명을 저장할 수 없습니다");
    await expect(field).toHaveValue("");
    expect(backend.notices).toEqual([]);
    expect(await page.content()).not.toContain(CANARY);
  } finally {
    await stop();
  }
});

test("a queued notice says it will be reflected soon and reads the list again after the gap; a skipped one asks for a restart", async ({
  page,
}) => {
  const backend = fresh({ rebuild: "queued" });
  await recordingPreload(page, true);
  await page.clock.install();
  const { show, stop } = await open(page, backend);
  try {
    await show();
    await expect(page.getByLabel("mail-1 token 값")).toBeVisible();
    const before = backend.lists;
    await page.getByLabel("mail-1 token 값").fill(CANARY);
    await page.getByRole("button", { name: "mail-1 token 저장" }).click();
    await expect(page.getByRole("status")).toContainText("곧 반영됩니다.");
    await expect.poll(() => backend.lists).toBe(before + 1); // at once
    await page.clock.fastForward(30_000);
    await expect.poll(() => backend.lists).toBe(before + 2); // and after the gap

    backend.rebuild = "skipped";
    await page.getByLabel("mail-1 token 값").fill(CANARY);
    await page.getByRole("button", { name: "mail-1 token 저장" }).click();
    await expect(page.getByRole("status")).toContainText("앱을 다시 시작해야 반영됩니다.");
  } finally {
    await stop();
  }
});
