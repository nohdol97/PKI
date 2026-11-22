// Spawn adapter ⓑ, the backend's side (I02B-R22, D25): in the bundled Electron app the backend is a
// utility process and cannot start the normalizer host itself without the `RunAsNode` fuse, so it asks
// the shell (Electron's main process) over the parent channel. The shell starts the host as a utility
// process and hands over a message port; the backend and the host then talk over that port directly.
// The request carries a number and nothing else: no path, argument or environment (I02B-C50).
//   backend -> shell: { type: "normalizer-host-start", id }   start a host (the previous one is ended first)
//                     { type: "normalizer-host-end", id }     end that host
//   shell -> backend: { type: "normalizer-host", id } + the port   the host is up
//                     { type: "normalizer-host-failed", id }       it could not be started
//                     { type: "normalizer-host-gone", id }         that host process is gone
import type { HostHandle, HostSpawner } from "@pki/document-normalize";

/** The end of a message port the backend holds (Electron's utility-process port). */
export interface HostPort {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  on(event: "close", listener: () => void): void;
  postMessage(message: unknown): void;
  start(): void;
  close(): void;
}

interface Pending {
  resolve(handle: HostHandle): void;
  reject(error: Error): void;
}

export function electronHostChannel(post: (message: unknown) => void) {
  const pending = new Map<number, Pending>();
  const gone = new Map<number, Set<() => void>>();
  let next = 1;

  const spawner: HostSpawner = {
    spawn: () =>
      new Promise<HostHandle>((resolve, reject) => {
        const id = next++;
        pending.set(id, { resolve, reject });
        post({ type: "normalizer-host-start", id });
      }),
  };

  function announceGone(id: number) {
    const listeners = gone.get(id);
    gone.delete(id);
    for (const listener of listeners ?? []) listener();
  }

  function handleFor(id: number, port: HostPort): HostHandle {
    const listeners = new Set<() => void>();
    gone.set(id, listeners);
    port.start();
    port.on("close", () => announceGone(id));
    return {
      post: (message) => port.postMessage(message),
      onMessage: (listener) => port.on("message", (event) => listener(event.data)),
      onGone: (listener) => void listeners.add(listener),
      kill: () => post({ type: "normalizer-host-end", id }),
    };
  }

  return {
    spawner,
    /** True when `data` was the shell's answer about a host (and is consumed). */
    deliver(data: unknown, ports: readonly unknown[] = []): boolean {
      if (typeof data !== "object" || data === null) return false;
      const { type, id, ...rest } = data as Record<string, unknown>;
      if (typeof id !== "number" || Object.keys(rest).length > 0) return false;
      if (type === "normalizer-host") {
        const waiting = pending.get(id);
        pending.delete(id);
        const port = ports[0] as HostPort | undefined;
        if (port === undefined) waiting?.reject(new Error("no port"));
        else waiting?.resolve(handleFor(id, port));
        return true;
      }
      if (type === "normalizer-host-failed") {
        pending.get(id)?.reject(new Error("the shell could not start the host"));
        pending.delete(id);
        return true;
      }
      if (type === "normalizer-host-gone") {
        announceGone(id);
        return true;
      }
      return false;
    },
    /** Ends every host this backend holds (the backend is stopping). */
    close() {
      for (const id of gone.keys()) post({ type: "normalizer-host-end", id });
    },
  };
}
