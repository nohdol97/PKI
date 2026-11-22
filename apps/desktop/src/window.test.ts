// Navigation rules for every web contents the shell creates (V01-R4, ADR 0008): the
// page may move only within app://pki, never opens a window, and never embeds a webview.
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { APP_ORIGIN } from "./app-protocol.ts";
import {
  loadScreens,
  lockDown,
  refuseDownloads,
  SCREENS_LOADED,
  secureWebPreferences,
} from "./window.ts";

function fakeContents() {
  const emitter = new EventEmitter();
  let openHandler: ((details: { url: string }) => { action: string }) | undefined;
  const contents = Object.assign(emitter, {
    setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }) {
      openHandler = handler;
    },
  });
  lockDown(contents);
  const fire = (event: string, url?: string) => {
    let prevented = false;
    emitter.emit(event, { preventDefault: () => (prevented = true), url }, url);
    return prevented;
  };
  return { fire, open: (url: string) => openHandler?.({ url }) };
}

describe("lockDown", () => {
  it.each(["will-navigate", "will-redirect", "will-frame-navigate"])(
    "%s: blocks other origins and allows the app's own",
    (event) => {
      const c = fakeContents();
      for (const url of [
        "https://example.com/",
        "http://127.0.0.1:4000/api/status",
        "file:///etc/passwd",
        "app://evil/",
        "javascript:alert(1)",
        "not a url",
      ]) {
        expect(c.fire(event, url), url).toBe(true);
      }
      expect(c.fire(event, `${APP_ORIGIN}/`)).toBe(false);
    },
  );

  it("denies every new window, the app's own pages included", () => {
    const c = fakeContents();
    expect(c.open("https://example.com/")).toEqual({ action: "deny" });
    expect(c.open(`${APP_ORIGIN}/`)).toEqual({ action: "deny" });
  });

  it("refuses webviews", () => {
    expect(fakeContents().fire("will-attach-webview")).toBe(true);
  });
});

describe("secureWebPreferences", () => {
  it("isolates the page from Node and the preload", () => {
    expect(secureWebPreferences("/p/preload.cjs")).toEqual({
      preload: "/p/preload.cjs",
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      devTools: false,
    });
  });
});

describe("refuseDownloads", () => {
  it("cancels every download the session would start (V01-T15)", () => {
    const session = new EventEmitter();
    refuseDownloads(session);
    let prevented = false;
    session.emit("will-download", { preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
  });
});

describe("loadScreens (V01-T15 review D1)", () => {
  /** A window whose load answers `status`, or fails like Chromium's loadURL. */
  function fakeWindow(status: number, fail?: Error) {
    const contents = new EventEmitter();
    const loaded: string[] = [];
    return {
      loaded,
      window: {
        webContents: contents,
        loadURL: async (url: string) => {
          loaded.push(url);
          contents.emit("did-navigate", {}, url, status);
          if (fail) throw fail;
        },
      },
    };
  }

  it("loads the screens and says so on one line", async () => {
    const { window, loaded } = fakeWindow(200);
    const lines: string[] = [];
    await loadScreens(window, "/web", { exists: () => true, log: (l) => lines.push(l) });
    expect(loaded).toEqual([`${APP_ORIGIN}/`]);
    expect(lines).toEqual([SCREENS_LOADED]);
  });

  it("fails before loading when the screens are not in the app folder", async () => {
    const { window, loaded } = fakeWindow(200);
    const seen: string[] = [];
    await expect(
      loadScreens(window, "/web", {
        exists: (p) => (seen.push(p), false),
        log: () => undefined,
      }),
    ).rejects.toThrow(/screens not found/);
    expect(seen).toEqual(["/web/index.html"]);
    expect(loaded).toEqual([]);
  });

  it.each([404, 500, 0])("fails when the page answers %i", async (status) => {
    const { window } = fakeWindow(status);
    const lines: string[] = [];
    await expect(
      loadScreens(window, "/web", { exists: () => true, log: (l) => lines.push(l) }),
    ).rejects.toThrow(/screens answered/);
    expect(lines).toEqual([]);
  });

  it("fails when the load fails", async () => {
    const { window } = fakeWindow(200, new Error("ERR_FAILED (-2)"));
    await expect(
      loadScreens(window, "/web", { exists: () => true, log: () => undefined }),
    ).rejects.toThrow(/ERR_FAILED/);
  });
});
