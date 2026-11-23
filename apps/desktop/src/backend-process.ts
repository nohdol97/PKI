// The shell's side of the backend lifecycle (V01-R4, ARCHITECTURE 3): a fresh token per
// run goes to the backend over the parent-child channel, never argv or the environment
// (other processes of the same user can read both). The backend binds a free loopback
// port itself and reports it back on the same channel, so no port is picked twice.
// A secret goes the same way, only when the backend asks for it just before a call.
import {
  isBackendReadableSecret,
  isConnectorCredentialSecret,
  SecretNameSchema,
  type SecretRead,
} from "@pki/contracts";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { NormalizerHostBroker } from "./normalizer-host.ts";
import type { SecretStore } from "./secret-store.ts";

/** The surface shared by Electron's utilityProcess.fork and Node's fork (tests). */
export interface BackendChild {
  readonly pid: number | undefined;
  /** `transfer`: message ports that go with the message (the normalizer host's, I02B-R22). */
  postMessage(message: unknown, transfer?: readonly unknown[]): void;
  on(event: "message", listener: (message: unknown) => void): void;
  once(event: "exit", listener: (code: number) => void): void;
  kill(): boolean;
  /**
   * Ends the process without asking (POSIX SIGKILL): for one that ignored kill(),
   * e.g. SIGTERM caught or the process stopped with the signal pending (V01-T16).
   */
  forceKill?(): void;
}
export type ForkBackend = (
  entry: string,
  args: string[],
  env: Record<string, string>,
) => BackendChild;

/** What the backend may see of the shell's environment: where the OS keeps user folders. */
export const BACKEND_ENV_KEYS: readonly string[] = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "XDG_DATA_HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "LANG",
];

export function backendEnv(env: Readonly<Record<string, string | undefined>>) {
  return Object.fromEntries(
    BACKEND_ENV_KEYS.flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]])),
  ) as Record<string, string>;
}

export type StartFailureReason =
  | "identity-key-missing"
  | "scope-policy-not-implemented"
  | "scope-policy-invalid"
  | "adapter-unregistered"
  | "ledger-reapply-failed"
  | "ledger-unavailable"
  | "site-registration-invalid";

/** A start the backend refused; `reason` is a fixed class it reported (I04-R7), never its message. */
export class BackendStartError extends Error {
  readonly reason: StartFailureReason | undefined;
  /** With `ledger-reapply-failed`: the ledger line number, never its content. */
  readonly ledgerLine: number | undefined;
  constructor(reason?: StartFailureReason, ledgerLine?: number) {
    super("backend failed to start");
    this.reason = reason;
    this.ledgerLine = ledgerLine;
    this.name = "BackendStartError";
  }
}

const FromBackend = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ready"), port: z.int().min(1).max(65535) }),
  z.strictObject({
    type: z.literal("failed"),
    reason: z
      .enum([
        "identity-key-missing",
        "scope-policy-not-implemented",
        "scope-policy-invalid",
        "adapter-unregistered",
        "ledger-reapply-failed",
        "ledger-unavailable",
        "site-registration-invalid",
      ])
      .optional(),
    line: z.int().positive().optional(),
  }),
  // the backend's requests for its normalizer host (I02B-R22): a number each, nothing else
  z.strictObject({ type: z.literal("normalizer-host-start"), id: z.int().positive() }),
  z.strictObject({ type: z.literal("normalizer-host-end"), id: z.int().positive() }),
  // the answer to a reveal request: the file's path, or null when there is none to show (I02B-R39)
  z.strictObject({
    type: z.literal("reveal-path"),
    id: z.int().positive(),
    path: z.string().min(1).max(4096).nullable(),
  }),
  z.strictObject({
    type: z.literal("secret-request"),
    id: z.int().positive(),
    name: SecretNameSchema,
    mode: z.enum(["read", "presence", "prune"]),
  }),
]);

const SECRET_UNAVAILABLE: SecretRead = { state: "unavailable" };

async function answerSecret(
  store: Pick<SecretStore, "read" | "has" | "deleteOthers" | "available"> | undefined,
  name: string,
  mode: "read" | "presence" | "prune",
): Promise<SecretRead | { state: SecretRead["state"] }> {
  const provider = isBackendReadableSecret(name);
  // a prune keeps a Provider key and deletes other Provider keys only (I06-R4)
  const allowed = provider || (mode !== "prune" && isConnectorCredentialSecret(name));
  if (!store || !allowed) return SECRET_UNAVAILABLE;
  try {
    // without OS protection an empty credential slot is not "missing" but unusable (I06-R4)
    if (!provider && mode === "presence" && !(await store.available())) return SECRET_UNAVAILABLE;
    if (mode === "read") return await store.read(name);
    // prune keeps `name` and answers "missing" once no other key is left
    if (mode === "prune")
      return (await store.deleteOthers(name)).ok ? { state: "missing" } : SECRET_UNAVAILABLE;
    const presence = await store.has(name);
    return presence.ok ? { state: presence.present ? "present" : "missing" } : SECRET_UNAVAILABLE;
  } catch {
    return SECRET_UNAVAILABLE;
  }
}

export interface BackendOptions {
  fork: ForkBackend;
  /** backend/src/shell.ts in a source run, backend/shell.js in the app folder (layout.ts). */
  entry: string;
  /** The screens' origin, the only one the backend accepts. */
  origin: string;
  /** The canonical DB folder (default: the backend's per-user data directory). */
  dataDir?: string | undefined;
  /**
   * The shell's user-data folder, passed as the backend's `--user-data` switch: no location may be or lie in
   * it (I02B-R48). Required, so a caller cannot forget it.
   */
  userData: string;
  /** Synthetic JSONL for the test Connector (source runs only: layout.ts, V01-T15). */
  fixtures?: string | undefined;
  /**
   * The scope policy by name (I04-R14), passed as the backend's `--scope-policy` switch: a setting, not
   * environment passthrough (BACKEND_ENV_KEYS stays the OS folders). None: the backend's default.
   */
  scopePolicy: string | undefined;
  /** The shell's environment; only BACKEND_ENV_KEYS pass. */
  env?: Readonly<Record<string, string | undefined>>;
  /** The run's session token; a restart passes the first start's (V01-T16). Default: fresh. */
  token?: string;
  startTimeoutMs?: number;
  /** After "stop", how long until kill() (default 5 s). */
  stopTimeoutMs?: number;
  /** After kill(), how long until forceKill(), and after that how long stop() still waits (default 2 s each). */
  killTimeoutMs?: number;
  /**
   * Answers the backend's secret requests; without it every answer is "unavailable".
   * Only Provider key names (`isBackendReadableSecret`) and Connector credential names
   * (`isConnectorCredentialSecret`, never for a prune) are looked up; a presence
   * request gets the state alone, never the value.
   */
  secrets?: Pick<SecretStore, "read" | "has" | "deleteOthers" | "available"> | undefined;
  /**
   * Answers the backend's requests to start and end its normalizer host (I02B-R22, adapter ⓑ). Given
   * the backend's channel when it is forked; stopped when the backend exits. Without it the requests
   * are ignored.
   */
  normalizerHost?: ((backend: BackendChild) => NormalizerHostBroker) | undefined;
  /** How long a reveal request waits for the backend's answer (default 5 s). */
  revealTimeoutMs?: number | undefined;
}

export interface Backend {
  url: string;
  token: string;
  pid: number | undefined;
  /** Resolves with the exit code whenever the process ends, asked to or not. */
  exited: Promise<number>;
  /**
   * Hands the backend a path the user picked under a ticket the shell made (I02B-R37), one way, no
   * answer. False when the process has ended.
   */
  registerLocationTicket(input: { ticket: string; kind: "folder"; path: string }): boolean;
  /**
   * Asks the backend where a local source's file is (I02B-R39, over this channel, never HTTP). Resolves
   * undefined when the backend has no path to show, ends, or does not answer in time.
   */
  revealPath(sourceVersionId: number): Promise<string | undefined>;
  /**
   * Asks the backend to close, kills it if it has not ended in time, force-kills it
   * if that is ignored too, and returns within stopTimeoutMs + 2 × killTimeoutMs
   * even if no exit is ever reported.
   */
  stop(): Promise<void>;
}

export async function startBackendProcess(options: BackendOptions): Promise<Backend> {
  const token = options.token ?? randomBytes(32).toString("base64url");
  const args = [
    "--origin",
    options.origin,
    "--user-data",
    options.userData,
    ...(options.dataDir ? ["--data-dir", options.dataDir] : []),
    ...(options.fixtures ? ["--fixtures", options.fixtures] : []),
    ...(options.scopePolicy !== undefined ? ["--scope-policy", options.scopePolicy] : []),
  ];
  const child = options.fork(options.entry, args, backendEnv(options.env ?? process.env));
  const normalizerHost = options.normalizerHost?.(child);
  let ended = false;
  const exited = new Promise<number>((resolve) =>
    child.once("exit", (code) => {
      ended = true;
      // the backend's host does not outlive it
      normalizerHost?.stop();
      resolve(code);
    }),
  );

  const reveals = new Map<number, (path: string | undefined) => void>();
  let revealIds = 0;
  void exited.then(() => reveals.forEach((answer) => answer(undefined)));

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("backend did not start in time"));
    }, options.startTimeoutMs ?? 30_000);
    let settled = false;
    const fail = (why: string | BackendStartError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(typeof why === "string" ? new Error(`backend ${why}`) : why);
    };
    child.on("message", (raw) => {
      const message = FromBackend.safeParse(raw);
      if (!message.success) return fail("sent an unexpected message");
      if (message.data.type === "secret-request") {
        const { id, name, mode } = message.data;
        void answerSecret(options.secrets, name, mode).then((answer) => {
          // the backend may have exited meanwhile; nothing to answer then
          if (!ended) child.postMessage({ type: "secret", id, ...answer });
        });
        return;
      }
      if (message.data.type === "reveal-path") {
        return reveals.get(message.data.id)?.(message.data.path ?? undefined);
      }
      if (message.data.type === "normalizer-host-start") {
        return normalizerHost?.start(message.data.id);
      }
      if (message.data.type === "normalizer-host-end") {
        return normalizerHost?.end(message.data.id);
      }
      if (message.data.type === "failed")
        return fail(new BackendStartError(message.data.reason, message.data.line));
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(message.data.port);
    });
    void exited.then((code) => fail(`exited before it was ready (${code})`));
    child.postMessage({ type: "start", token });
  });

  return {
    url: `http://127.0.0.1:${port}`,
    token,
    pid: child.pid,
    exited,
    registerLocationTicket(input) {
      if (ended) return false;
      child.postMessage({ type: "location-ticket", ...input });
      return true;
    },
    revealPath(sourceVersionId) {
      if (ended) return Promise.resolve(undefined);
      const id = (revealIds += 1);
      return new Promise((resolve) => {
        const timer = setTimeout(() => answer(undefined), options.revealTimeoutMs ?? 5_000);
        const answer = (path: string | undefined) => {
          clearTimeout(timer);
          reveals.delete(id);
          resolve(path);
        };
        reveals.set(id, answer);
        child.postMessage({ type: "reveal-request", id, sourceVersionId });
      });
    },
    async stop() {
      if (ended) return;
      const endsWithin = (ms: number) =>
        Promise.race([
          exited.then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), ms).unref()),
        ]);
      const killAfter = options.killTimeoutMs ?? 2_000;
      child.postMessage({ type: "stop" });
      if (await endsWithin(options.stopTimeoutMs ?? 5_000)) return;
      child.kill();
      if (await endsWithin(killAfter)) return;
      child.forceKill?.();
      await endsWithin(killAfter);
    },
  };
}
