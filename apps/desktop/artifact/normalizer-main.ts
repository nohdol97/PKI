// The test app's Electron main for the normalizer host's spawn adapter ⓑ (I02B-C50, test code). It is
// bundled with the production bundler settings next to the real host and worker files and started with
// the repository build's Electron binary (the `RunAsNode` fuse is on there, which is why the test also
// checks the host's `process.type`). It runs the shell's real parts, `startBackendProcess` and the
// normalizer host broker, around a stand-in backend (`normalizer-backend.ts`) that asks for hosts the
// way the real backend does, and reports what it sees as lines `T {json}` on stdout. It also lets the
// stand-in ask for a kill from outside the way a test would (`test-kill-host`), and counts live hosts.
import { app, MessageChannelMain, utilityProcess } from "electron";
import { join } from "node:path";
import { startBackendProcess, type BackendChild } from "../src/backend-process.ts";
import {
  createNormalizerHostBroker,
  startNormalizerHostProcess,
  type HostProcess,
} from "../src/normalizer-host.ts";

const appDir = import.meta.dirname;
const scenario =
  process.argv.find((a) => a.startsWith("--scenario="))?.slice("--scenario=".length) ?? "basic";
// the product's own worker for the scenarios that measure it; the test worker for the rest
const PRODUCT_WORKER_SCENARIOS = ["product-worker", "g23"];
const hostArgs = PRODUCT_WORKER_SCENARIOS.includes(scenario)
  ? []
  : ["--worker", join(appDir, "backend", "bomb-worker.js")];
const hostEntry = join(appDir, "backend", "host.js");

const report = (record: object) => console.log(`T ${JSON.stringify(record)}`);
app.dock?.hide();

interface Seen {
  host: HostProcess;
  pid: number | undefined;
}
const seen: Seen[] = [];
const forks: { entry: string; args: string[]; env: Record<string, string> }[] = [];
const alive = (pid: number | undefined): boolean => {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const liveHosts = () => seen.filter((s) => alive(s.host.pid ?? s.pid));
let maxLive = 0;
setInterval(() => {
  // a utility process reports no pid once it has exited: keep the one it had
  for (const s of seen) s.pid ??= s.host.pid;
  maxLive = Math.max(maxLive, liveHosts().length);
}, 5).unref();

const forkHost = (): HostProcess => {
  const host = startNormalizerHostProcess(
    (entry, args, options) => {
      forks.push({ entry, args, env: options.env });
      return utilityProcess.fork(entry, args, options);
    },
    hostEntry,
    hostArgs,
  );
  seen.push({ host, pid: host.pid });
  return host;
};

void app.whenReady().then(async () => {
  let raw: Electron.UtilityProcess | undefined;
  const backend = await startBackendProcess({
    fork: (entry, args, env): BackendChild => {
      const child = utilityProcess.fork(entry, args, { env, serviceName: "PKI backend" });
      raw = child;
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
          if (child.pid !== undefined) process.kill(child.pid, "SIGKILL");
        },
      };
    },
    entry: join(appDir, "backend", "stand-in.js"),
    origin: "app://pki",
    scopePolicy: undefined,
    normalizerHost: (backendChild) =>
      createNormalizerHostBroker({
        forkHost,
        newChannel: () => new MessageChannelMain(),
        backend: backendChild,
      }),
  });
  report({ type: "main", electron: process.versions.electron, node: process.versions.node });

  const finish = async (afterStop: "stop" | "kill-backend") => {
    if (afterStop === "stop") await backend.stop();
    else if (backend.pid !== undefined) process.kill(backend.pid, "SIGKILL");
    await backend.exited;
    // the backend is gone: its host goes with it, within a few seconds
    const deadline = Date.now() + 5_000;
    while (liveHosts().length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    report({ type: "after-backend", how: afterStop, liveHosts: liveHosts().length });
    app.exit(0);
  };

  raw?.on("message", async (message: { type?: string; record?: object }) => {
    if (message.type === "test-log" && message.record) report(message.record);
    else if (message.type === "test-kill-host") {
      // from outside, as a test would: SIGKILL the live host
      const target = liveHosts().at(-1);
      const pid = target?.host.pid;
      if (pid !== undefined) process.kill(pid, "SIGKILL");
      report({ type: "killed", pid: pid ?? null });
    } else if (message.type === "test-hosts-gone") {
      // how long until no host process is left (the stand-in asks after a host was ended)
      const started = Date.now();
      while (liveHosts().length > 0 && Date.now() - started < 5_000) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      report({ type: "hosts-gone", ms: Date.now() - started, live: liveHosts().length });
    } else if (message.type === "test-hosts") {
      report({
        type: "hosts",
        spawned: seen.length,
        pids: seen.map((s) => s.pid ?? s.host.pid ?? null),
        live: liveHosts().map((s) => s.host.pid ?? null),
        maxLive,
        forks,
      });
    } else if (message.type === "test-done") void finish("stop");
    else if (message.type === "test-kill-backend") void finish("kill-backend");
  });
  raw?.postMessage({ type: "test-run", scenario });
});
