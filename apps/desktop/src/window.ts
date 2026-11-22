// Window settings and navigation rules (V01-R4, ADR 0008). lockDown applies to every
// web contents the app creates: it may move only within app://pki, never opens a
// window (links leave through the bridge's openExternal), and never embeds a webview.
import { onAppOrigin } from "./app-protocol.ts";

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

export function lockDown(contents: LockableContents): void {
  for (const event of ["will-navigate", "will-redirect", "will-frame-navigate"]) {
    contents.on(event, (e, url) => {
      if (!onAppOrigin(e.url ?? url)) e.preventDefault();
    });
  }
  contents.on("will-attach-webview", (e) => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
}
