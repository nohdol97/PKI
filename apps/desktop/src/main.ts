// Electron main (V01-R4, ADR 0008). The shell starts and stops the backend, keeps one
// instance, serves the built screens from app://pki (the backend's only allowed
// Origin), gives the page its session through the preload, and blocks everything
// else the page might try: Node, other origins, new windows, permissions.
// Switches (development and tests): --pki-user-data, --pki-data-dir, --pki-fixtures.
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  session,
  shell,
  utilityProcess,
} from "electron";
import { fileURLToPath } from "node:url";
import { APP_ORIGIN, APP_SCHEME, createAppHandler } from "./app-protocol.ts";
import { startBackendProcess, type Backend, type ForkBackend } from "./backend-process.ts";
import { BRIDGE, createBridgeHandlers, type BridgeFunction } from "./bridge.ts";
import { lockDown, secureWebPreferences } from "./window.ts";

const WEB_ROOT = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const BACKEND_ENTRY = fileURLToPath(new URL("../../../backend/src/shell.ts", import.meta.url));
const PRELOAD = fileURLToPath(new URL("./preload.cjs", import.meta.url));

const option = (name: string) => app.commandLine.getSwitchValue(name) || undefined;

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
  };
};

let backend: Backend | undefined;
let window: BrowserWindow | undefined;
let backendAlive = false;
let quitting = false;

async function run() {
  await app.whenReady();
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, grant) =>
    grant(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);

  backend = await startBackendProcess({
    fork: forkUtility,
    entry: BACKEND_ENTRY,
    origin: APP_ORIGIN,
    dataDir: option("pki-data-dir"),
    fixtures: option("pki-fixtures"),
  });
  backendAlive = true;
  void backend.exited.then((code) => {
    backendAlive = false;
    // Restarting a dead backend is T16; until then /api/ answers 502 (app-protocol.ts).
    if (!quitting) console.error(`PKI backend exited (${code})`);
  });
  protocol.handle(
    APP_SCHEME,
    createAppHandler({
      webRoot: WEB_ROOT,
      backendUrl: backend.url,
      backendAlive: () => backendAlive,
    }),
  );

  const handlers = createBridgeHandlers({
    session: { baseUrl: "", token: backend.token },
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

// The single-instance lock lives in userData, so the switch must come first.
const userData = option("pki-user-data");
if (userData) app.setPath("userData", userData);

if (!app.requestSingleInstanceLock()) {
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
    // stop() sends nothing to a backend that has already exited and resolves at once;
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
