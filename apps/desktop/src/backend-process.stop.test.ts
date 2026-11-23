// V01-T16: the shell's stop has a time limit end to end. A backend that ignores the
// stop message gets the graceful kill after `stopTimeoutMs`; one that ignores that
// too (SIGTERM caught, or a stopped process with the signal pending) is force-killed
// after `killTimeoutMs`; and stop() returns even if no exit is ever reported, so a
// quit never hangs on the backend.
import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startBackendProcess, type BackendChild, type ForkBackend } from "./backend-process.ts";

// Answers start with ready, then ignores stop and SIGTERM: only SIGKILL ends it.
const STUBBORN = `
process.on("SIGTERM", () => undefined);
process.on("message", (m) => {
  if (m && m.type === "start") process.send({ type: "ready", port: 4000 });
});
setInterval(() => undefined, 1000);
`;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let dir: string;
let pids: number[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-stop-"));
  pids = [];
});
afterEach(() => {
  for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

const nodeFork: ForkBackend = (entry, args, env) => {
  const child = fork(entry, args, {
    env,
    execArgv: [],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  if (child.pid) pids.push(child.pid);
  return {
    get pid() {
      return child.pid;
    },
    postMessage: (message) => void child.send(message as object),
    on: (event, listener) => void child.on(event, listener),
    once: (event, listener) => void child.once(event, (code: number | null) => listener(code ?? 1)),
    kill: () => child.kill(),
    forceKill: () => void child.kill("SIGKILL"),
  };
};

describe("backend stop time limit", () => {
  it("force-kills a backend that ignores stop and SIGTERM, within the limits", async () => {
    const entry = join(dir, "stubborn.mjs");
    writeFileSync(entry, STUBBORN);
    const backend = await startBackendProcess({
      fork: nodeFork,
      entry,
      origin: "app://pki",
      userData: "/u",
      scopePolicy: undefined,
      stopTimeoutMs: 300,
      killTimeoutMs: 300,
    });
    const pid = backend.pid ?? 0;
    const began = Date.now();
    await backend.stop();
    expect(Date.now() - began).toBeLessThan(3_000);
    expect(alive(pid)).toBe(false);
  });

  it("returns even when no exit is ever reported", async () => {
    const forced: string[] = [];
    let onMessage: (m: unknown) => void = () => undefined;
    const child: BackendChild = {
      pid: undefined,
      postMessage: (m) => {
        if ((m as { type?: string }).type === "start") {
          queueMicrotask(() => onMessage({ type: "ready", port: 4000 }));
        }
      },
      on: (_e, l) => void (onMessage = l),
      once: () => undefined, // never exits
      kill: () => (forced.push("kill"), true),
      forceKill: () => void forced.push("force"),
    };
    const backend = await startBackendProcess({
      fork: () => child,
      entry: "unused",
      origin: "app://pki",
      userData: "/u",
      scopePolicy: undefined,
      stopTimeoutMs: 50,
      killTimeoutMs: 50,
    });
    const began = Date.now();
    await backend.stop();
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(forced).toEqual(["kill", "force"]);
  });

  it("starts a restart with the run's token when given one (V01-T16)", async () => {
    const posted: unknown[] = [];
    let onMessage: (m: unknown) => void = () => undefined;
    const child: BackendChild = {
      pid: undefined,
      postMessage: (m) => {
        posted.push(m);
        if ((m as { type?: string }).type === "start") {
          queueMicrotask(() => onMessage({ type: "ready", port: 4000 }));
        }
      },
      on: (_e, l) => void (onMessage = l),
      once: (_e, l) => void (exit = l),
      kill: () => (exit(0), true),
    };
    let exit: (code: number) => void = () => undefined;
    const token = "t".repeat(43);
    const backend = await startBackendProcess({
      fork: () => child,
      entry: "unused",
      origin: "app://pki",
      userData: "/u",
      scopePolicy: undefined,
      token,
    });
    expect(backend.token).toBe(token);
    expect(posted[0]).toEqual({ type: "start", token });
  });
});
