// Shell entry (V01-R4): the Electron shell starts this file as a utility process. The
// session token arrives as the first message on the parent channel, never in argv or
// the environment; the port the server bound goes back the same way. Under Node's
// fork (tests) the IPC channel carries the same messages. Secrets come the same way:
// a Provider asks just before a call (`secret-request`) and the shell answers
// (`secret`); nothing of them is kept here.
// `--origin` is the screens' origin (app://pki); `--data-dir` and `--fixtures` as in dev.ts.
import { dataDirectory } from "@pki/storage";
import { parseArgs } from "node:util";
import { bootBackend } from "./boot.ts";
import { channelSecrets } from "./secret-sources.ts";
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
    // Node fork: end with the parent.
    process.once("disconnect", () => process.exit(0));
    return { onMessage: (l) => process.on("message", l), post: (m) => process.send?.(m) };
  }
  throw new Error("the shell entry needs a parent channel");
}

const { values } = parseArgs({
  options: {
    origin: { type: "string", multiple: true, default: [] },
    "data-dir": { type: "string" },
    fixtures: { type: "string" },
  },
});

const channel = parentChannel();
const secrets = channelSecrets((message) => channel.post(message));
let running: { server: RunningServer; close(): void } | undefined;

async function start(token: string) {
  const dataDir = values["data-dir"] ?? dataDirectory();
  const { server, db } = await bootBackend({
    dataDir,
    fixtures: values.fixtures,
    token,
    allowedOrigins: values.origin,
    secrets: secrets.source,
  });
  running = { server, close: () => db.close() };
  return server.port;
}

async function stop() {
  // Open connections must not keep the shell waiting; it kills the process if this hangs.
  await Promise.race([running?.server.close(), new Promise((r) => setTimeout(r, 2_000))]);
  running?.close();
  process.exit(0);
}

let starting = false;
const failed = (error?: unknown) => {
  if (error !== undefined) {
    console.error(`backend start failed: ${error instanceof Error ? error.name : typeof error}`);
  }
  channel.post({ type: "failed" });
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
