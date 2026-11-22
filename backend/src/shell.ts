// Shell entry (V01-R4): the Electron shell starts this file as a utility process. The
// session token arrives as the first message on the parent channel, never in argv or
// the environment; the port the server bound goes back the same way. Under Node's
// fork (tests) the IPC channel carries the same messages. Secrets come the same way:
// a Provider asks just before a call (`secret-request`) and the shell answers
// (`secret`); nothing of them is kept here.
// `--origin` is the screens' origin (app://pki); a source run also takes `--data-dir`
// and `--fixtures` as in dev.ts, the production build neither (shell-options.ts).
import { startFailureLine, startFailureReport } from "./start-failure.ts";
import { dataDirectory } from "@pki/storage";
import type { LLMProvider } from "@pki/contracts";
import { bootBackend, closeProviders } from "./boot.ts";
import { channelSecrets } from "./secret-sources.ts";
import { shellOptions } from "./shell-options.ts";
import type { RunningServer } from "./server.ts";

type ToBackend = { type: "start"; token: string } | { type: "stop" };

/** The shell's two messages, exactly; anything else is undefined. */
function parse(data: unknown): ToBackend | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const keys = Object.keys(data).sort().join(",");
  const { type, token } = data as { type?: unknown; token?: unknown };
  if (type === "stop" && keys === "type") return { type };
  const tokenOk = typeof token === "string" && token.length >= 32 && token.length <= 512;
  if (type === "start" && keys === "token,type" && tokenOk) return { type, token };
  return undefined;
}

interface Channel {
  onMessage(listener: (data: unknown) => void): void;
  post(message: unknown): void;
}

interface ParentPort {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

function parentChannel(): Channel {
  const port = (process as { parentPort?: ParentPort }).parentPort;
  if (port) {
    return {
      onMessage: (l) => port.on("message", (e) => l(e.data)),
      post: (m) => port.postMessage(m),
    };
  }
  if (process.send) {
    // Node fork: end with the parent, ending running CLI trees first (stop, V01-T10).
    process.once("disconnect", () => void stop());
    return { onMessage: (l) => process.on("message", l), post: (m) => process.send?.(m) };
  }
  throw new Error("the shell entry needs a parent channel");
}

const options = shellOptions();

const channel = parentChannel();
const secrets = channelSecrets((message) => channel.post(message));
let running:
  { server: RunningServer; providers: readonly LLMProvider[]; close(): void } | undefined;

async function start(token: string) {
  const dataDir = options.dataDir ?? dataDirectory();
  const { server, db, providers } = await bootBackend({
    dataDir,
    connectors: options.connectors,
    token,
    allowedOrigins: options.origins,
    secrets: secrets.source,
    scopePolicy: options.scopePolicy,
  });
  running = { server, providers, close: () => db.close() };
  return server.port;
}

let stopping: Promise<never> | undefined;

/** Once, whoever asks (the shell's "stop", then the parent going away). */
function stop(): Promise<never> {
  stopping ??= stopOnce();
  return stopping;
}

async function stopOnce(): Promise<never> {
  // Running CLI trees sit in their own process groups: end them (SIGTERM, then SIGKILL
  // after 2 s) while the server closes, within the shell's 5 s stop limit (V01-T10).
  // Open connections must not keep the shell waiting; it kills the process if this hangs.
  // A failing close is not a reason to leave the CLI trees running.
  const closed = running?.server.close().catch(() => undefined);
  await Promise.all([
    closeProviders(running?.providers ?? [], 3_000),
    Promise.race([closed, new Promise((r) => setTimeout(r, 2_000))]),
  ]);
  running?.close();
  process.exit(0);
}

let starting = false;
const failed = (error?: unknown) => {
  if (error !== undefined) {
    console.error(startFailureLine(error));
  }
  channel.post(startFailureReport(error));
  process.exit(1);
};

channel.onMessage((data) => {
  if (secrets.deliver(data)) return;
  const message = parse(data);
  if (message?.type === "stop") return void stop();
  if (starting) return; // one start per process; later messages are ignored
  // A malformed start is not echoed: it may still carry the token.
  if (message?.type !== "start") return failed();
  starting = true;
  start(message.token).then((port) => channel.post({ type: "ready", port }), failed);
});
