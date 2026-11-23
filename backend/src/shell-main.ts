// The shell entry's body (V01-R4, I05-R1): `runShell(site)`. The Electron shell starts an entry file
// as a utility process: the public `shell.ts` with the empty registration, or a fork's own with its
// registration; either calls this. The session token arrives as the first message on the parent
// channel, never in argv or the environment; the port the server bound goes back the same way. Under
// Node's fork (tests) the IPC channel carries the same messages. Secrets come the same way:
// a Provider asks just before a call (`secret-request`) and the shell answers
// (`secret`); nothing of them is kept here.
// `--origin` is the screens' origin (app://pki); a source run also takes `--data-dir`
// and `--fixtures` as in dev.ts, the production build neither (shell-options.ts).
import { startFailureLine, startFailureReport } from "./start-failure.ts";
import { dataDirectory } from "@pki/storage";
import type { LLMProvider } from "@pki/contracts";
import { bootBackend, closeProviders } from "./boot.ts";
import { electronHostChannel } from "./normalizer-host-electron.ts";
import { channelSecrets } from "./secret-sources.ts";
import { locationTicket, type ApprovalTickets } from "./local-locations.ts";
import { shellOptions } from "./shell-options.ts";
import type { RunningServer } from "./server.ts";
import type { SiteRegistration } from "./site-registration.ts";

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
  /** `ports`: message ports that came with the message (the shell hands the normalizer host's over). */
  onMessage(listener: (data: unknown, ports: readonly unknown[]) => void): void;
  post(message: unknown): void;
}

interface ParentPort {
  on(event: "message", listener: (event: { data: unknown; ports?: unknown[] }) => void): void;
  postMessage(message: unknown): void;
}

function parentChannel(onDisconnect: () => void): Channel {
  const port = (process as { parentPort?: ParentPort }).parentPort;
  if (port) {
    return {
      onMessage: (l) => port.on("message", (e) => l(e.data, e.ports ?? [])),
      post: (m) => port.postMessage(m),
    };
  }
  if (process.send) {
    // Node fork: end with the parent, ending running CLI trees first (stop, V01-T10).
    process.once("disconnect", onDisconnect);
    return {
      onMessage: (l) => process.on("message", (m) => l(m, [])),
      post: (m) => process.send?.(m),
    };
  }
  throw new Error("the shell entry needs a parent channel");
}

/** Runs the backend process with `site` (the fork's registration, or `publicSite`) until the shell stops it. */
export async function runShell(site: SiteRegistration): Promise<void> {
  const options = shellOptions();

  const channel = parentChannel(() => void stop());
  const secrets = channelSecrets((message) => channel.post(message));
  // the shell starts the normalizer host for this backend when asked (I02B-R22, adapter ⓑ)
  const normalizerHosts = electronHostChannel((message) => channel.post(message));
  let running:
    {
      server: RunningServer;
      providers: readonly LLMProvider[];
      tickets: ApprovalTickets;
      close(): void;
    }
    | undefined;

  async function start(token: string) {
    const dataDir = options.dataDir ?? dataDirectory();
    const { server, db, providers, tickets } = await bootBackend({
      dataDir,
      connectors: options.connectors,
      site,
      token,
      allowedOrigins: options.origins,
      secrets: secrets.source,
      scopePolicy: options.scopePolicy,
      // the normalizer host is started by the shell for a utility process (I02B-R22, adapter ⓑ)
      // and the shell's user-data folder is no place for a location (I02B-R48)
      localFiles: {
        shellHost: normalizerHosts.spawner,
        ...(options.userData ? { excluded: [options.userData] } : {}),
      },
    });
    running = { server, providers, tickets, close: () => db.close() };
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
    normalizerHosts.close();
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

  channel.onMessage((data, ports) => {
    if (secrets.deliver(data)) return;
    if (normalizerHosts.deliver(data, ports)) return;
    // a path the user picked, under a ticket the shell made; dropped while no backend runs (I02B-R37)
    const picked = locationTicket(data);
    if (picked) return void running?.tickets.register(picked);
    const message = parse(data);
    if (message?.type === "stop") return void stop();
    if (starting) return; // one start per process; later messages are ignored
    // A malformed start is not echoed: it may still carry the token.
    if (message?.type !== "start") return failed();
    starting = true;
    start(message.token).then((port) => channel.post({ type: "ready", port }), failed);
  });
}
