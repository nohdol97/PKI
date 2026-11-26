// Window settings and navigation rules (V01-R4, ADR 0008). lockDown applies to every
// web contents the app creates but a login window's (lockDownUnlessLogin, I06S-R4): it may move only within app://pki, never opens a
// window (links leave through the bridge's openExternal), and never embeds a webview.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { APP_ORIGIN, onAppOrigin } from "./app-protocol.ts";

export function secureWebPreferences(preload: string) {
  return {
    preload,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: false,
    // no developer tools, in any run (V01-T15): the screens are debugged in the browser
    devTools: false,
  };
}

interface DownloadSession {
  on(event: "will-download", listener: (event: { preventDefault(): void }) => void): unknown;
}

/** The shell downloads nothing: every download a page would start is cancelled (V01-T15). */
export function refuseDownloads(session: DownloadSession): void {
  session.on("will-download", (event) => event.preventDefault());
}

interface Preventable {
  preventDefault(): void;
  url?: string;
}

/** The parts of Electron's WebContents this needs. */
export interface LockableContents {
  on(event: string, listener: (event: Preventable, url?: unknown) => void): unknown;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): void;
}

/** The sessions of login windows (I06S-R4): marked by the shell before the window exists, never by a page. */
const loginSessions = new WeakSet<object>();
export const markLoginSession = (session: object): void => void loginSessions.add(session);

/**
 * `lockDown` for every web contents the app creates except a login window's: that one must follow the origin
 * system's own pages off app://, and holds its own rules (login-electron.ts: no preload, http(s) only, no new
 * windows, downloads or permissions). Which contents it is comes from the session the shell marked.
 */
export function lockDownUnlessLogin(contents: LockableContents & { session: object }): void {
  if (!loginSessions.has(contents.session)) lockDown(contents);
}

export function lockDown(contents: LockableContents): void {
  for (const event of ["will-navigate", "will-redirect", "will-frame-navigate"]) {
    contents.on(event, (e, url) => {
      if (!onAppOrigin(e.url ?? url)) e.preventDefault();
    });
  }
  contents.on("will-attach-webview", (e) => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
}

/** One line on stdout once the screens are up: what the artifact checks wait for. */
export const SCREENS_LOADED = "PKI: screens loaded";

interface LoadableWindow {
  webContents: {
    once(
      event: "did-navigate",
      listener: (event: unknown, url: string, httpResponseCode: number) => void,
    ): unknown;
  };
  loadURL(url: string): Promise<void>;
}

/**
 * Loads the screens from `webRoot` into `window` (V01-T15 review D1). A start whose
 * screens are not in the app folder, whose page answers other than 2xx, or whose
 * load fails is a failed start, not a blank window: each rejects.
 */
export async function loadScreens(
  window: LoadableWindow,
  webRoot: string,
  io: { exists?: (path: string) => boolean; log?: (line: string) => void } = {},
): Promise<void> {
  const { exists = existsSync, log = (line: string) => console.log(line) } = io;
  const index = join(webRoot, "index.html");
  if (!exists(index)) throw new Error(`screens not found: ${index}`);
  let status = 0;
  window.webContents.once("did-navigate", (_event, _url, code) => (status = code));
  await window.loadURL(`${APP_ORIGIN}/`);
  if (status < 200 || status > 299) throw new Error(`screens answered ${status}`);
  log(SCREENS_LOADED);
}
