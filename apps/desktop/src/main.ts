// Electron main (V01-R4, ADR 0008). The shell starts and stops the backend (and
// restarts one that exits by itself, a bounded number of times: V01-T16), keeps one
// instance, serves the built screens from app://pki (the backend's only allowed
// Origin), gives the page its session through the preload, and blocks everything
// else the page might try: Node, other origins, new windows, permissions. It holds the
// secret store (safeStorage ciphertext in the data directory) and answers the
// backend's requests for a secret over the parent channel.
// Switches of source runs (development and tests): --pki-data-dir, --pki-fixtures
// (layout.ts); the production build has none and refuses to start with a
// debugging switch (debugging.ts). Tests move userData with
// Chromium's own --user-data-dir (V01-T15).
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  safeStorage,
  session,
  shell,
  utilityProcess,
} from "electron";
import { dataDirectory } from "@pki/storage";
import { url as inspectorUrl } from "node:inspector";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_ORIGIN, APP_SCHEME, createAppHandler } from "./app-protocol.ts";
import { startBackendProcess, type ForkBackend } from "./backend-process.ts";
import { superviseBackend, type Supervisor } from "./backend-supervisor.ts";
import { BRIDGE, createBridgeHandlers, type BridgeFunction } from "./bridge.ts";
import { createSecretStore, electronCipher } from "./secret-store.ts";
import { debuggingRequested } from "./debugging.ts";
import { BACKEND_ENTRY, REFUSE_DEBUGGING, switches, WEB_ROOT } from "./layout.ts";
import { lockDown, refuseDownloads, secureWebPreferences } from "./window.ts";

const PRELOAD = fileURLToPath(new URL("./preload.cjs", import.meta.url));
/** In the data directory: per OS user, not roaming (ADR 0010). */
const SECRETS_FILE = "secrets.json";
/** Restarts of a backend that exited by itself, per shell run (V01-T16, provisional). */
const MAX_RESTARTS = 3;

const { dataDir, fixtures } = switches((name) => app.commandLine.getSwitchValue(name) || undefined);

const forkUtility: ForkBackend = (entry, args, env) => {
  const child = utilityProcess.fork(entry, args, { env, serviceName: "PKI backend" });
  return {
    get pid() {
      return child.pid;
    },
    postMessage: (message) => child.postMessage(message),
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
let quitting = false;

async function run() {
  await app.whenReady();
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, grant) =>
    grant(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  refuseDownloads(session.defaultSession);

  const secrets = createSecretStore({
    file: join(dataDir ?? dataDirectory(), SECRETS_FILE),
    cipher: electronCipher(safeStorage, process.platform),
  });
  backend = await superviseBackend({
    start: (token) =>
      startBackendProcess({
        fork: forkUtility,
        entry: BACKEND_ENTRY,
        origin: APP_ORIGIN,
        dataDir,
        fixtures,
        secrets,
        token,
      }),
    maxRestarts: MAX_RESTARTS,
    // after the last restart /api/ answers 502 until the app is started again
    onGiveUp: (code) => console.error(`PKI backend exited (${code}); not restarted again`),
  });
  const supervisor = backend;
  protocol.handle(
    APP_SCHEME,
    createAppHandler({ webRoot: WEB_ROOT, backendUrl: () => supervisor.url() }),
  );

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
  await window.loadURL(`${APP_ORIGIN}/`);
}

// Must precede app ready: the screens' scheme behaves like https (secure, standard origin).
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

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
} else if (!app.requestSingleInstanceLock()) {
  // The single-instance lock lives in userData (Chromium's --user-data-dir moves both).
  app.exit(0);
} else {
  app.on("web-contents-created", (_event, contents) => lockDown(contents));
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
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
    console.error(`PKI shell failed to start: ${error instanceof Error ? error.message : error}`);
    dialog.showErrorBox("PKI", "앱을 시작하지 못했습니다.");
    app.exit(1);
  });
}
