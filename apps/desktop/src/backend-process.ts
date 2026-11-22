// The shell's side of the backend lifecycle (V01-R4, ARCHITECTURE 3): a fresh token per
// run goes to the backend over the parent-child channel, never argv or the environment
// (other processes of the same user can read both). The backend binds a free loopback
// port itself and reports it back on the same channel, so no port is picked twice.
// A secret goes the same way, only when the backend asks for it just before a call.
import { isBackendReadableSecret, SecretNameSchema, type SecretRead } from "@pki/contracts";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { SecretStore } from "./secret-store.ts";

/** The surface shared by Electron's utilityProcess.fork and Node's fork (tests). */
export interface BackendChild {
  readonly pid: number | undefined;
  postMessage(message: unknown): void;
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
  | "adapter-unregistered";

/** A start the backend refused; `reason` is a fixed class it reported (I04-R7), never its message. */
export class BackendStartError extends Error {
  readonly reason: StartFailureReason | undefined;
  constructor(reason?: StartFailureReason) {
    super("backend failed to start");
    this.reason = reason;
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
      ])
      .optional(),
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
  store: Pick<SecretStore, "read" | "has" | "deleteOthers"> | undefined,
  name: string,
  mode: "read" | "presence" | "prune",
): Promise<SecretRead | { state: SecretRead["state"] }> {
  if (!store || !isBackendReadableSecret(name)) return SECRET_UNAVAILABLE;
  try {
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
   * Only names `isBackendReadableSecret` allows are looked up; a presence request
   * gets the state alone, never the value.
   */
  secrets?: Pick<SecretStore, "read" | "has" | "deleteOthers"> | undefined;
}

export interface Backend {
  url: string;
  token: string;
  pid: number | undefined;
  /** Resolves with the exit code whenever the process ends, asked to or not. */
  exited: Promise<number>;
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
    ...(options.dataDir ? ["--data-dir", options.dataDir] : []),
    ...(options.fixtures ? ["--fixtures", options.fixtures] : []),
    ...(options.scopePolicy !== undefined ? ["--scope-policy", options.scopePolicy] : []),
  ];
  const child = options.fork(options.entry, args, backendEnv(options.env ?? process.env));
  let ended = false;
  const exited = new Promise<number>((resolve) =>
    child.once("exit", (code) => {
      ended = true;
      resolve(code);
    }),
  );

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
      if (message.data.type === "failed") return fail(new BackendStartError(message.data.reason));
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
