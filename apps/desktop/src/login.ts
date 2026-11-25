// The shell's interactive login (I06S-R4, R5, D3): one window on the origin system's own page, no preload
// and a fresh in-memory partition, ended by the page reaching the address that means "logged in". The
// judgement is here and the window's machinery sits behind `LoginHost` (an Electron implementation in
// login-electron.ts, a fake in the tests). The session cookies go from this process straight to the secret
// store: no value is returned to the page, logged, or sent to the backend.
import {
  isConnectorCredentialSecret,
  LOGIN_TIMEOUT_MS,
  LoginSettingsSchema,
  SecretValueSchema,
  type LoginResult,
} from "@pki/contracts";
import { randomBytes } from "node:crypto";
import type { SecretStore } from "./secret-store.ts";

/** One open login window, as the judgement sees it. */
export interface LoginWindow {
  /** Calls `listener` with the address of each navigation of the main frame. */
  onNavigate(listener: (url: string) => void): void;
  /** Calls `listener` once when the user closes the window. */
  onClosed(listener: () => void): void;
  /** The cookies the window's partition would send to `url`, httpOnly ones included. */
  cookies(url: string): Promise<readonly { name: string; value: string }[]>;
  /** Clears everything the partition holds, then closes and destroys the window. */
  dispose(): Promise<void>;
}

/** What opens a login window; `partition` names a fresh in-memory session for this one login. */
export interface LoginHost {
  open(spec: { url: string; partition: string }): LoginWindow;
}

/**
 * The web preferences of a login window: the origin system's page runs with no preload (it must not reach
 * `window.pki`), sandboxed, context-isolated and in the partition of this one login (never the app's own
 * session). Exported so the Electron host and the tests read one definition.
 */
export function loginWebPreferences(partition: string) {
  return {
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
    partition,
  };
}

export interface LoginDeps {
  host: LoginHost;
  /** Only `set`: the login stores one value and reads nothing back. */
  store: Pick<SecretStore, "set">;
  /** A fresh partition name per login; no `persist:` prefix, so nothing outlives the window. */
  newPartition?: () => string;
  /** Provisional (I06S-R5): how long the window may stay open. */
  timeoutMs?: number;
  /** Starts a timer and returns what cancels it (a fake in the tests). */
  startTimer?: (run: () => void, ms: number) => () => void;
}

const freshPartition = () => `pki-login-${randomBytes(12).toString("hex")}`;
const nodeTimer = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

/**
 * One login, from the backend's description (checked again here: a name that is not a Connector credential
 * or an address outside the rule is `invalid`). Resolves with `{ok:true}` once the session is stored, else
 * with the reason and nothing stored. Never throws and never carries a value.
 */
export async function runLogin(settings: unknown, deps: LoginDeps): Promise<LoginResult> {
  const parsed = LoginSettingsSchema.safeParse(settings);
  if (!parsed.success || !isConnectorCredentialSecret(parsed.data.name)) {
    return { ok: false, error: "invalid" };
  }
  const { name, startUrl, doneUrlPrefix, cookies } = parsed.data;
  const { host, store, startTimer = nodeTimer } = deps;
  const partition = (deps.newPartition ?? freshPartition)();

  return new Promise<LoginResult>((resolve) => {
    let finished = false;
    let reached = false;
    let cancelTimer: () => void = () => undefined;
    let window: LoginWindow | undefined;

    const finish = (result: LoginResult) => {
      if (finished) return;
      finished = true;
      cancelTimer();
      // the partition is cleared and the window destroyed before the answer, stored or not
      const closing = window ? window.dispose().catch(() => undefined) : Promise.resolve();
      void closing.then(() => resolve(result));
    };

    const capture = async (url: string) => {
      try {
        const held = await window?.cookies(url);
        const values = cookies.map((cookie) => held?.find((c) => c.name === cookie)?.value);
        if (values.some((value) => value === undefined))
          return finish({ ok: false, error: "no-session" });
        const line = JSON.stringify({
          cookies: Object.fromEntries(cookies.map((cookie, i) => [cookie, values[i]])),
        });
        if (!SecretValueSchema.safeParse(line).success)
          return finish({ ok: false, error: "too-large" });
        const stored = await store.set(name, line);
        finish(stored.ok ? { ok: true } : { ok: false, error: "store-unavailable" });
      } catch {
        finish({ ok: false, error: "store-unavailable" });
      }
    };

    try {
      window = host.open({ url: startUrl, partition });
    } catch {
      return resolve({ ok: false, error: "invalid" });
    }
    window.onNavigate((url) => {
      if (finished || reached || !url.startsWith(doneUrlPrefix)) return;
      reached = true;
      void capture(url);
    });
    window.onClosed(() => finish({ ok: false, error: "cancelled" }));
    cancelTimer = startTimer(
      () => finish({ ok: false, error: "timeout" }),
      deps.timeoutMs ?? LOGIN_TIMEOUT_MS,
    );
  });
}

/** `runLogin`, one at a time: a second call while a window is open answers `busy` (I06S-R5). */
export function createLoginRunner(deps: LoginDeps): (settings: unknown) => Promise<LoginResult> {
  let open = false;
  return async (settings) => {
    if (open) return { ok: false, error: "busy" };
    open = true;
    try {
      return await runLogin(settings, deps);
    } finally {
      open = false;
    }
  };
}
