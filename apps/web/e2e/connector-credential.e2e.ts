// I06-R14, R17 (I06-C11) on the Sources screen, in the browser: an instance that declared a credential slot
// shows the slot's state and the reason in words; where the shell's preload is (a recording double here, so no
// real store or keychain is touched) the slot takes a value, hands it to the preload under the listed name,
// tells the backend only the instance's ID and clears the field; without the preload no input is drawn.
// The list and the change notice are answered by the test (page.route): the value must appear in neither
// request, nor in the page.
import { CREDENTIAL_RETRY_MIN_MS } from "@pki/contracts";
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
  /** When set, the notice is answered only once this promise settles (a slow backend). */
  hold?: Promise<void>;
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
  await page.route(NOTICE_PATH, async (route: Route) => {
    await backend.hold;
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

/** The credential note of the `mail-1` row: the page's other status (the source list loading) lies outside the table. */
function credentialStatus(page: Page) {
  return page
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: "mail-1", exact: true }) })
    .getByRole("status");
}

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
    // while typing the value is in the field only: not in the DOM's value attribute, not in the page (F2)
    expect((await field.getAttribute("value")) ?? "").not.toContain(CANARY);
    expect(await page.content()).not.toContain(CANARY);
    backend.slot = "present"; // what the backend sees once the shell stored it
    await field.press("Enter"); // the keyboard submits like the button
    await expect(field).toHaveValue("");
    await expect(field).toBeFocused(); // the place is kept for the keyboard (F4)
    await expect(credentialStatus(page)).toContainText("반영했습니다.");
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
    await expect(field).toBeFocused(); // a delete leaves the focus on the field, not on the page body (F4)
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
    await expect(credentialStatus(page)).toContainText("자격 증명을 저장할 수 없습니다");
    await expect(field).toHaveValue("");
    expect(backend.notices).toEqual([]);
    expect(await page.content()).not.toContain(CANARY);
  } finally {
    await stop();
  }
});

test("a value the screen cannot take whole is refused in words, never stored cut or changed (F3)", async ({
  page,
}) => {
  const backend = fresh();
  await recordingPreload(page, true);
  const { show, stop } = await open(page, backend);
  try {
    await show();
    const field = page.getByLabel("mail-1 token 값");
    const status = credentialStatus(page);
    const refused = "한 줄 값만 넣을 수 있습니다";

    // typed or inserted text with a line break
    await field.focus();
    await page.keyboard.insertText("line1\nline2");
    await expect(status).toContainText(refused);
    // empty before the refusal too (the test started with an empty field); I06F-C4 checks that leading characters are kept
    await expect(field).toHaveValue("");

    // a paste with a line break
    const notPrevented = await field.evaluate((input) => {
      const data = new DataTransfer();
      data.setData("text/plain", "-----BEGIN-----\nsynthetic\n-----END-----");
      return input.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    });
    expect(notPrevented).toBe(false); // the paste itself was cancelled, not just answered with the words
    await expect(status).toContainText(refused);
    // empty before the refusal too (the test started with an empty field); I06F-C4 checks that leading characters are kept
    await expect(field).toHaveValue("");

    // longer than the shell takes: refused at submit, not cut to 8192 and not reported as reflected
    await field.fill("x".repeat(9000));
    await field.press("Enter");
    await expect(status).toContainText("8192");
    await expect(status).not.toContainText("반영");
    await expect(field).toHaveValue("");

    expect(await preloadCalls(page)).toEqual([]);
    expect(backend.notices).toEqual([]);

    // exactly the limit is stored whole
    await field.fill("y".repeat(8192));
    await field.press("Enter");
    await expect(status).toContainText("반영했습니다.");
    expect(await preloadCalls(page)).toEqual([["set", NAME, 8192]]);
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
    await expect(credentialStatus(page)).toContainText("곧 반영됩니다.");
    await expect.poll(() => backend.lists).toBe(before + 1); // at once
    await page.clock.fastForward(CREDENTIAL_RETRY_MIN_MS);
    await expect.poll(() => backend.lists).toBe(before + 2); // and after the gap

    backend.rebuild = "skipped";
    await page.getByLabel("mail-1 token 값").fill(CANARY);
    await page.getByRole("button", { name: "mail-1 token 저장" }).click();
    await expect(credentialStatus(page)).toContainText("앱을 다시 시작해야 반영됩니다.");
  } finally {
    await stop();
  }
});

// I06F-C3/C4: the three ways text arrives that a script can see before the field takes it. Each carries a line
// break; each must be cancelled (the event's dispatch returns false) and answered with the fixed words.
const BROKEN = "-----BEGIN-----\nsynthetic\n-----END-----";
const REFUSED = "한 줄 값만 넣을 수 있습니다";

type Way = "keyboard" | "paste" | "drop" | "beforeinput-drop";
const WAYS: readonly Way[] = ["keyboard", "paste", "drop", "beforeinput-drop"];

/** Puts `text` into the field by `way`; true when the page let the event through (did not cancel it). */
async function insert(page: Page, way: Way, text: string): Promise<boolean> {
  const field = page.getByLabel("mail-1 token 값");
  if (way === "keyboard") {
    // the keyboard path is the browser's own insertion; the event is the real beforeinput
    await field.focus();
    await page.keyboard.insertText(text);
    return true;
  }
  return field.evaluate(
    (input, { way, text }) => {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      const event =
        way === "paste"
          ? new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })
          : way === "drop"
            ? new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true })
            : // a drop as the editing layer reports it: no `data`, the text only in `dataTransfer`
              new InputEvent("beforeinput", {
                inputType: "insertFromDrop",
                dataTransfer: data,
                bubbles: true,
                cancelable: true,
              });
      return input.dispatchEvent(event);
    },
    { way, text },
  );
}

for (const way of ["drop", "beforeinput-drop"] as const) {
  test(`I06F-C3 a ${way} with a line break is cancelled and answered in words; without a break it is let through; nothing reaches the preload or the backend`, async ({
    page,
  }) => {
    const backend = fresh();
    await recordingPreload(page, true);
    const { show, stop } = await open(page, backend);
    try {
      await show();
      const status = credentialStatus(page);
      expect(await insert(page, way, "no-break-here"), "without a break").toBe(true);
      await expect(status).toHaveCount(0);
      expect(await insert(page, way, BROKEN), "with a break").toBe(false);
      await expect(status).toContainText(REFUSED);
      expect(await preloadCalls(page)).toEqual([]);
      expect(backend.notices).toEqual([]);
    } finally {
      await stop();
    }
  });
}

for (const way of WAYS.filter((w) => w !== "beforeinput-drop")) {
  test(`I06F-C4 a refused ${way} with a line break leaves what was typed: same value, save still on, Enter stores it`, async ({
    page,
  }) => {
    const backend = fresh();
    await recordingPreload(page, true);
    const { show, stop } = await open(page, backend);
    try {
      await show();
      const field = page.getByLabel("mail-1 token 값");
      await field.fill("abc");
      await insert(page, way, BROKEN);
      await expect(credentialStatus(page)).toContainText(REFUSED);
      await expect(field).toHaveValue("abc");
      await expect(page.getByRole("button", { name: "mail-1 token 저장" })).toBeEnabled();
      await field.press("Enter");
      await expect(credentialStatus(page)).toContainText("반영했습니다.");
      expect(await preloadCalls(page)).toEqual([["set", NAME, 3]]);
    } finally {
      await stop();
    }
  });
}

test("I06F-C5 the focus is not taken back from where the user moved while the notice was pending", async ({
  page,
}) => {
  let release = () => {};
  const backend = fresh({ hold: new Promise<void>((resolve) => (release = resolve)) });
  await recordingPreload(page, true);
  const { show, stop } = await open(page, backend);
  try {
    await show();
    const field = page.getByLabel("mail-1 token 값");
    await field.fill(CANARY);
    await field.press("Enter");
    const other = page.getByRole("button", { name: "plain 동기화" });
    await other.focus();
    release();
    await expect(credentialStatus(page)).toContainText("반영했습니다.");
    await page.waitForTimeout(150); // the refocus, if any, runs just after the words appear
    await expect(other).toBeFocused();
  } finally {
    await stop();
  }
});

test("I06F-C6 KNOWN LIMIT: a value put in by code arrives with its line breaks already removed, so the screen cannot tell and stores it", async ({
  page,
}) => {
  // This records a limit, not a wish: a password field removes CR and LF (the HTML value sanitization) before
  // any script can read the value. The screen has no way to know a break was there; what remains is stored and
  // "반영했습니다." is shown. The length check still holds on this path (R5, R6).
  const backend = fresh();
  await recordingPreload(page, true);
  const { show, stop } = await open(page, backend);
  try {
    await show();
    const field = page.getByLabel("mail-1 token 값");
    // as an autofill does: the browser's own value setter, then an input event
    const put = (value: string) =>
      field.evaluate((input: HTMLInputElement, value) => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        set?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return input.value;
      }, value);
    const seen = await put("ab\ncd\r\nef");
    expect(seen).not.toMatch(/[\r\n]/); // 1
    expect(seen).toBe("abcdef"); // measured in Chromium: the breaks are removed, not turned into spaces
    await field.press("Enter");
    await expect(credentialStatus(page)).toContainText("반영했습니다."); // 2
    expect(await preloadCalls(page)).toEqual([["set", NAME, seen.length]]);

    await put("z".repeat(8193));
    await field.press("Enter");
    await expect(credentialStatus(page)).toContainText("8192"); // 3
    expect(await preloadCalls(page)).toEqual([["set", NAME, seen.length]]);
  } finally {
    await stop();
  }
});
