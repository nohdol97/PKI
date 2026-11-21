// V01-C2 `shell.security.e2e`: the Electron screen cannot reach Node, runs no inline
// or remote script, cannot leave app://pki or open windows, and the shell refuses
// IPC that fails its schema and external links that are not https (ADR 0008).
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchShell } from "./launch.ts";

type Pki = Record<string, (...args: unknown[]) => Promise<unknown>>;

let dir: string;
let app: ElectronApplication;
let page: Page;

test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pki-shell-sec-"));
  ({ app, window: page } = await launchShell({
    userData: join(dir, "u"),
    dataDir: join(dir, "d"),
  }));
  await expect(page.getByRole("row", { name: /백엔드/ })).toContainText("준비됨");
});

test.afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the window is sandboxed and isolated from Node", async () => {
  // Electron 45 no longer exposes a window's preferences (getLastWebPreferences), so
  // each setting is shown by its effect; secureWebPreferences pins the values themselves.
  if (process.platform !== "linux") {
    // OS-level sandbox of the renderer, reported on macOS and Windows only.
    const renderers = await app.evaluate(({ app }) =>
      app
        .getAppMetrics()
        .filter((m) => m.type === "Tab")
        .map((m) => m.sandboxed),
    );
    expect(renderers.length).toBeGreaterThan(0);
    expect(renderers.every((s) => s === true)).toBe(true);
  }
  expect(page.url()).toBe("app://pki/");
  const reach = await page.evaluate(() => {
    const g = globalThis as Record<string, unknown>;
    return {
      require: typeof g.require,
      process: typeof g.process,
      module: typeof g.module,
      // contextBridge refuses to run without contextIsolation, so window.pki proves it.
      bridge: typeof g.pki,
    };
  });
  expect(reach).toEqual({
    require: "undefined",
    process: "undefined",
    module: "undefined",
    bridge: "object",
  });
});

test("the CSP blocks inline, eval and remote scripts", async () => {
  const result = await page.evaluate(async () => {
    const violations: string[] = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      violations.push(e.violatedDirective),
    );
    const w = window as unknown as Record<string, unknown>;
    const inline = document.createElement("script");
    inline.textContent = "window.__inlineRan = true";
    document.head.append(inline);
    const remote = document.createElement("script");
    remote.src = "https://example.com/x.js";
    document.head.append(remote);
    // Run after this evaluation returns: DevTools lifts the eval block during its own call.
    const evalRan = await new Promise<boolean>((resolve) =>
      setTimeout(() => {
        try {
          resolve((0, eval)("true") === true);
        } catch {
          resolve(false);
        }
      }),
    );
    await new Promise((r) => setTimeout(r, 300));
    const header = (await fetch("/")).headers.get("content-security-policy");
    return { inline: w.__inlineRan === true, evalRan, violations, header };
  });
  expect(result.inline).toBe(false);
  expect(result.evalRan).toBe(false);
  expect(result.violations).toEqual(expect.arrayContaining(["script-src-elem"]));
  expect(result.violations.length).toBeGreaterThanOrEqual(3);
  expect(result.header).toContain("script-src 'self'");
});

test("the page cannot navigate away or open windows", async () => {
  for (const url of ["https://example.com/", "http://127.0.0.1:1/", "file:///etc/hosts"]) {
    await page.evaluate((u) => void (location.href = u), url);
    await page.waitForTimeout(300);
    expect(page.url(), url).toBe("app://pki/");
  }
  const opened = await page.evaluate(() => [
    window.open("https://example.com/") === null,
    window.open("app://pki/") === null,
  ]);
  expect(opened).toEqual([true, true]);
  await page.waitForTimeout(300);
  expect(app.windows()).toHaveLength(1);
  // Playwright keeps waiting on a navigation the shell cancelled, so locators would
  // hang here; read the document directly: still the app page, still rendered.
  expect(
    await page.evaluate(() => [location.href, document.body.innerText.includes("준비됨")]),
  ).toEqual(["app://pki/", true]);
});

test("every permission request and check is denied", async () => {
  const states = await page.evaluate(async () => ({
    query: (await navigator.permissions.query({ name: "notifications" })).state,
    request: await Notification.requestPermission(),
  }));
  expect(states).toEqual({ query: "denied", request: "denied" });
});

test("IPC that fails the schema is refused", async () => {
  const errors = await page.evaluate(async () => {
    const pki = (window as unknown as { pki: Pki }).pki;
    const calls: [string, unknown[]][] = [
      ["getSession", ["extra"]],
      ["setSecret", ["Bad Name!", "v"]],
      ["setSecret", ["openai-key", 42]],
      ["hasSecret", []],
      ["deleteSecret", [{}]],
      ["openExternal", [42]],
    ];
    return Promise.all(
      calls.map(([name, args]) =>
        pki[name]?.(...args).then(
          () => "accepted",
          (e: unknown) => String(e),
        ),
      ),
    );
  });
  for (const error of errors) expect(error).toContain("invalid-input");
});

async function stubExternal(response: number) {
  await app.evaluate(({ dialog, shell }, response) => {
    const g = globalThis as unknown as { opened: string[]; asked: number };
    g.opened = [];
    g.asked = 0;
    shell.openExternal = async (url: string) => void g.opened.push(url);
    dialog.showMessageBox = (async () => {
      g.asked += 1;
      return { response, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  }, response);
}
const externalState = () =>
  app.evaluate(() => {
    const g = globalThis as unknown as { opened: string[]; asked: number };
    return { opened: g.opened, asked: g.asked };
  });
const openExternal = (url: string) =>
  page.evaluate(
    (u) =>
      (window as unknown as { pki: Pki }).pki.openExternal?.(u).then(
        (r) => JSON.stringify(r),
        (e: unknown) => String(e),
      ),
    url,
  );

test("external links: only https, only after the user confirms", async () => {
  await stubExternal(0);
  for (const url of ["http://example.com/", "javascript:alert(1)", "file:///etc/hosts"]) {
    expect(await openExternal(url)).toContain("invalid-input");
  }
  expect(await externalState()).toEqual({ opened: [], asked: 0 });

  expect(await openExternal("https://example.com/doc")).toBe('{"opened":true}');
  expect(await externalState()).toEqual({ opened: ["https://example.com/doc"], asked: 1 });

  await stubExternal(1);
  expect(await openExternal("https://example.com/doc")).toBe('{"opened":false}');
  expect(await externalState()).toEqual({ opened: [], asked: 1 });
});
