// Spawn adapter ⓐ (I02B-R22): the normalizer host as a `child_process.fork` child, for a backend that
// runs as plain Node (browser development mode, tests). The host entry is this package's `host.ts`.
// `hostFile` and `args` are the tests' seam (a test host with a test worker, a host whose main thread is
// stuck). The host gets an empty environment and no standard streams: nothing of a document reaches a
// log or a process option.
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { HostHandle, HostSpawner } from "./isolated.ts";

const HOST_FILE = fileURLToPath(new URL("./host.ts", import.meta.url));

export function createForkSpawner(
  options: { hostFile?: string; args?: string[] } = {},
): HostSpawner {
  return {
    spawn: () =>
      new Promise<HostHandle>((resolve, reject) => {
        const child = fork(options.hostFile ?? HOST_FILE, options.args ?? [], {
          // the parent's own flags (a test runner's loaders) do not belong to the host
          execArgv: [],
          env: {},
          // binary-safe messages: the job carries the file's bytes
          serialization: "advanced",
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        child.once("error", reject);
        child.once("spawn", () => {
          child.removeListener("error", reject);
          resolve({
            pid: child.pid,
            post: (message) => {
              if (child.connected) child.send(message as never);
            },
            onMessage: (listener) => void child.on("message", listener),
            onGone: (listener) => {
              child.once("exit", listener);
              child.on("error", listener);
            },
            kill: () => void child.kill("SIGKILL"),
          });
        });
      }),
  };
}
