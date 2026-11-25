// Electron main (V01-R4, ADR 0008). The shell starts and stops the backend (and
// restarts one that exits by itself, a bounded number of times: V01-T16), keeps one
// instance (Electron's lock in userData, and a lock on the data folder itself:
// data-lock.ts), serves the built screens from app://pki (the backend's only allowed
// Origin), gives the page its session through the preload, and blocks everything
// else the page might try: Node, other origins, new windows, permissions. It holds the
// secret store (safeStorage ciphertext in the data directory) and answers the
// backend's requests for a secret over the parent channel.
// Switches of source runs (development and tests): --pki-data-dir, --pki-fixtures
// (layout.ts); the production build has none and refuses to start with a
// debugging switch (debugging.ts). One switch is the installer's, in every build:
// --pki-uninstall-data=keep|delete (data-removal.ts), judged before Electron's lock. Tests move userData with
// Chromium's own --user-data-dir (V01-T15).
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MessageChannelMain,
  nativeImage,
  Notification,
  powerMonitor,
  protocol,
  safeStorage,
  session,
  shell,
  Tray,
  utilityProcess,
} from "electron";
import { dataDirectory } from "@pki/storage";
import { autostartMenuItem } from "./autostart.ts";
import { lockDataDirectory, openDataFolder } from "./data-lock.ts";
import { removeUserData, UNINSTALL_SWITCH } from "./data-removal.ts";
import { url as inspectorUrl } from "node:inspector";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_ORIGIN, APP_SCHEME, createAppHandler } from "./app-protocol.ts";
import { startFailureText } from "./start-failure-text.ts";
import { startBackendProcess, type ForkBackend } from "./backend-process.ts";
import { superviseBackend, type Supervisor } from "./backend-supervisor.ts";
import { BRIDGE, createBridgeHandlers, type BridgeFunction } from "./bridge.ts";
import { createLoginRunner } from "./login.ts";
import { electronLoginHost } from "./login-electron.ts";
import { createSecretStore, electronCipher } from "./secret-store.ts";
import { debuggingRequested } from "./debugging.ts";
import {
  BACKEND_ENTRY,
  NORMALIZER_HOST_ENTRY,
  REFUSE_DEBUGGING,
  scopePolicyName,
  switches,
  WEB_ROOT,
} from "./layout.ts";
import { createNotifier } from "./notifier.ts";
import { createProductNormalizerHostBroker } from "./normalizer-host.ts";
import { loadScreens, lockDown, refuseDownloads, secureWebPreferences } from "./window.ts";

const PRELOAD = fileURLToPath(new URL("./preload.cjs", import.meta.url));
/** In the data directory: per OS user, not roaming (ADR 0010). */
const SECRETS_FILE = "secrets.json";
/** The tray icon: a small embedded image, since the repository holds no icon asset (P02-D12). */
const TRAY_ICON =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAO0lEQVR4nGNgoAXQz3/7HxumSDNRhhDSjNcQYjVjNYRUzRiGjBpABQMojkaqJCRiDcGrmZAhRGkmFQAA31mMKCzj5f4AAAAASUVORK5CYII=";
/** Restarts of a backend that exited by itself, per shell run (V01-T16, provisional). */
const MAX_RESTARTS = 3;

const { dataDir, fixtures } = switches((name) => app.commandLine.getSwitchValue(name) || undefined);

/** Worked out when used, inside the callers' guards: it throws where the OS gives no per-user folder (LKH-R4). */
const resolveDataPath = (): string => dataDir ?? dataDirectory();
/** The folder the shell locked at start (set before run()); the lock itself is held by data-lock.ts until the process ends. */
let dataPath = "";

const forkUtility: ForkBackend = (entry, args, env) => {
  const child = utilityProcess.fork(entry, args, { env, serviceName: "PKI backend" });
  return {
    get pid() {
      return child.pid;
    },
    postMessage: (message, transfer) =>
      child.postMessage(message, transfer as Electron.MessagePortMain[] | undefined),
    on: (_event, listener) => void child.on("message", listener),
    once: (_event, listener) => void child.once("exit", listener),
    kill: () => child.kill(),
    forceKill: () => {
      if (child.pid === undefined) return;
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    },
  };
};

let backend: Supervisor | undefined;
let window: BrowserWindow | undefined;
/** One tray icon while the app runs; none where the platform cannot make one (P02-R12). */
let tray: Tray | undefined;
let quitting = false;
/** A quit was asked for (SIGTERM, the menu), whether or not start-up has finished. */
let quitRequested = false;

/** A toast's click and the tray bring the window to the front; they go nowhere else (P02-D13). */
function bringToFront() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/** The OS toast of the backend's count-only messages; Electron's objects are handed in (notifier.ts). */
const notifier = createNotifier({
  notification: {
    isSupported: () => Notification.isSupported(),
    create: (options) => new Notification(options),
  },
  get tray() {
    return tray;
  },
  focusWindow: bringToFront,
});

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON}`));
    tray.setToolTip("PKI");
    tray.on("click", bringToFront);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "열기", click: bringToFront },
        autostartMenuItem({
          packaged: app.isPackaged,
          get: () => app.getLoginItemSettings().openAtLogin,
          set: (enabled) => app.setLoginItemSettings({ openAtLogin: enabled }),
        }),
        { label: "종료", click: () => app.quit() },
      ]),
    );
  } catch (error) {
    // a platform without a tray keeps the toast and the feed
    console.error(`PKI tray unavailable: ${error instanceof Error ? error.message : error}`);
    tray = undefined;
  }
}

async function run() {
  await app.whenReady();
  createTray();
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, grant) =>
    grant(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  refuseDownloads(session.defaultSession);

  const secrets = createSecretStore({
    file: join(dataPath, SECRETS_FILE),
    cipher: electronCipher(safeStorage, process.platform),
  });
  backend = await superviseBackend({
    start: (token) =>
      startBackendProcess({
        fork: forkUtility,
        entry: BACKEND_ENTRY,
        origin: APP_ORIGIN,
        dataDir,
        // no location may be or lie in the shell's own user-data folder (I02B-R48)
        userData: app.getPath("userData"),
        fixtures,
        // none in a production build (the registration's policy applies), the environment's only in a source run (layout.ts, I05-R15)
        scopePolicy: scopePolicyName(process.env),
        secrets,
        token,
        notify: (message) => notifier.show(message),
        normalizerHost: (backendChild) =>
          // the bundled host entry, no arguments, no environment (I02B-R22, I02B-C50)
          createProductNormalizerHostBroker({
            fork: (entry, args, options) => utilityProcess.fork(entry, args, options),
            entry: NORMALIZER_HOST_ENTRY,
            newChannel: () => new MessageChannelMain(),
            backend: backendChild,
          }),
      }),
    maxRestarts: MAX_RESTARTS,
    // after the last restart /api/ answers 502 until the app is started again
    onGiveUp: (code) => console.error(`PKI backend exited (${code}); not restarted again`),
  });
  const supervisor = backend;
  // the OS woke from sleep: the backend checks its periods now (H02A-R11)
  powerMonitor.on("resume", () => supervisor.resumed());
  protocol.handle(
    APP_SCHEME,
    createAppHandler({ webRoot: WEB_ROOT, backendUrl: () => supervisor.url() }),
  );

  // one login window at a time; the description comes from the backend, the value goes only to the store (I06S-R3, R5)
  const login = createLoginRunner({ host: electronLoginHost(), store: secrets });
  const handlers = createBridgeHandlers({
    session: { baseUrl: "", token: backend.token },
    secrets,
    confirmExternal: async ({ href, hostname }) => {
      const options = {
        type: "question" as const,
        buttons: ["열기", "취소"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        message: `외부 브라우저에서 ${hostname} 주소를 엽니다.`,
        detail: href,
      };
      const answer = window
        ? await dialog.showMessageBox(window, options)
        : await dialog.showMessageBox(options);
      return answer.response === 0;
    },
    openExternal: (href) => shell.openExternal(href),
    pickLocation: async (type) => {
      // a folder, or one file: a JSONL file is picked among .jsonl files (the backend checks what was picked)
      const options =
        type === "folder"
          ? { properties: ["openDirectory" as const] }
          : {
              properties: ["openFile" as const],
              ...(type === "jsonl-file"
                ? { filters: [{ name: "JSONL", extensions: ["jsonl"] }] }
                : {}),
            };
      const picked = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      return picked.canceled ? undefined : picked.filePaths[0];
    },
    registerLocationTicket: (input) => supervisor.registerLocationTicket(input),
    revealPath: (sourceVersionId) => supervisor.revealPath(sourceVersionId),
    openLogin: async (connectorId) => login(await supervisor.loginSettings(connectorId)),
    showInFolder: (path) => shell.showItemInFolder(path),
  });
  for (const name of Object.keys(BRIDGE) as BridgeFunction[]) {
    ipcMain.handle(BRIDGE[name], (event, ...args: unknown[]) =>
      handlers[name](event.senderFrame?.url, args),
    );
  }

  window = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    webPreferences: secureWebPreferences(PRELOAD),
  });
  window.once("ready-to-show", () => window?.show());
  await loadScreens(window, WEB_ROOT);
}

// Must precede app ready: the screens' scheme behaves like https (secure, standard origin).
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

/** Works out and locks the data folder (R04L, LKH-R4); false = do not start. */
function takeDataLock(): boolean {
  const opened = openDataFolder(resolveDataPath);
  if ("line" in opened) {
    console.error(opened.line);
    return false;
  }
  dataPath = opened.dir;
  return true;
}

/** The installer's call (H02A-R6): decide about the data folder, print, exit. No window, no backend. */
function uninstallData(): void {
  // the OS registration is switched off once Electron is ready; no window is made either way
  void app
    .whenReady()
    .then(() => {
      const { code, line } = removeUserData({
        choice: app.commandLine.getSwitchValue(UNINSTALL_SWITCH),
        dir: resolveDataPath,
        lock: lockDataDirectory,
        // a development run never registered anything (H02A-D8)
        disableAutostart: () => {
          if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: false });
        },
      });
      if (line) console.error(line);
      app.exit(code);
    })
    .catch((error: unknown) => {
      // the installer waits on this process: any failure still ends it with a line and code 1 (SLF-R1)
      console.error(`PKI: the uninstall call failed (${(error as Error).message})`);
      app.exit(1);
    });
}

const debugging =
  REFUSE_DEBUGGING &&
  debuggingRequested({
    hasSwitch: (name) => app.commandLine.hasSwitch(name),
    execArgv: process.execArgv,
    nodeOptions: process.env.NODE_OPTIONS,
    inspectorActive: inspectorUrl() !== undefined,
  });

if (debugging) {
  // before the window and the backend exist: nothing to reach through the door
  console.error("PKI: refusing to start with a debugging switch");
  app.exit(1);
} else if (app.commandLine.hasSwitch(UNINSTALL_SWITCH)) {
  // before Electron's lock: a PKI running on the same userData must answer 1, not be "handed over" as 0
  uninstallData();
} else if (!app.requestSingleInstanceLock()) {
  // Electron's lock lives in userData: it only hands focus to the first run.
  app.exit(0);
} else if (!takeDataLock()) {
  app.exit(1);
} else {
  app.on("web-contents-created", (_event, contents) => lockDown(contents));
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.on("before-quit", () => (quitRequested = true));
  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", (event) => {
    if (quitting || !backend) return;
    event.preventDefault();
    quitting = true;
    // stop() sends nothing when no backend is running and resolves at once;
    // a quit issued from inside this will-quit is then dropped, so quit again from a
    // fresh task (the one defence: it covers every stop() that resolves early).
    void backend.stop().finally(() => setImmediate(() => app.quit()));
  });
  run().catch((error: unknown) => {
    // quit while starting (SIGTERM): the backend or the window's load is cut short, not
    // failed, and a modal error box would hold the quit until someone closes it
    // (V01-T15 artifact.shell)
    const why = error instanceof Error ? error.message : error;
    if (quitRequested || window?.isDestroyed()) {
      console.error(`PKI shell start stopped by a quit: ${why}`);
      return;
    }
    console.error(`PKI shell failed to start: ${why}`);
    dialog.showErrorBox("PKI", startFailureText(error));
    app.exit(1);
  });
}
