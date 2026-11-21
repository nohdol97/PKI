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

const FromBackend = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ready"), port: z.int().min(1).max(65535) }),
  z.strictObject({ type: z.literal("failed") }),
  z.strictObject({
    type: z.literal("secret-request"),
    id: z.int().positive(),
    name: SecretNameSchema,
    mode: z.enum(["read", "presence"]),
  }),
]);

const SECRET_UNAVAILABLE: SecretRead = { state: "unavailable" };

async function answerSecret(
  store: Pick<SecretStore, "read" | "has"> | undefined,
  name: string,
  mode: "read" | "presence",
): Promise<SecretRead | { state: SecretRead["state"] }> {
  if (!store || !isBackendReadableSecret(name)) return SECRET_UNAVAILABLE;
  try {
    if (mode === "read") return await store.read(name);
    const presence = await store.has(name);
    return presence.ok ? { state: presence.present ? "present" : "missing" } : SECRET_UNAVAILABLE;
  } catch {
    return SECRET_UNAVAILABLE;
  }
}

export interface BackendOptions {
  fork: ForkBackend;
  /** backend/src/shell.ts */
  entry: string;
  /** The screens' origin, the only one the backend accepts. */
  origin: string;
  /** The canonical DB folder (default: the backend's per-user data directory). */
  dataDir?: string | undefined;
  /** Synthetic JSONL for the test Connector (development and tests; T15 removes it). */
  fixtures?: string | undefined;
  /** The shell's environment; only BACKEND_ENV_KEYS pass. */
  env?: Readonly<Record<string, string | undefined>>;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  /**
   * Answers the backend's secret requests; without it every answer is "unavailable".
   * Only names `isBackendReadableSecret` allows are looked up; a presence request
   * gets the state alone, never the value.
   */
  secrets?: Pick<SecretStore, "read" | "has"> | undefined;
}

export interface Backend {
  url: string;
  token: string;
  pid: number | undefined;
  /** Resolves with the exit code whenever the process ends, asked to or not. */
  exited: Promise<number>;
  /** Asks the backend to close, and kills it if it has not ended in time. */
  stop(): Promise<void>;
}

export async function startBackendProcess(options: BackendOptions): Promise<Backend> {
  const token = randomBytes(32).toString("base64url");
  const args = [
    "--origin",
    options.origin,
    ...(options.dataDir ? ["--data-dir", options.dataDir] : []),
    ...(options.fixtures ? ["--fixtures", options.fixtures] : []),
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
    const fail = (why: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(new Error(`backend ${why}`));
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
      if (message.data.type === "failed") return fail("failed to start");
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
      child.postMessage({ type: "stop" });
      const timeout = new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), options.stopTimeoutMs ?? 5_000).unref(),
      );
      if ((await Promise.race([exited, timeout])) === "timeout") {
        child.kill();
        await exited;
      }
    },
  };
}
