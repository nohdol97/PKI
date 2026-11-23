// The shell's side of spawn adapter ⓑ (I02B-R22, D25): the backend (a utility process) asks, the shell
// starts the normalizer host as a utility process and hands each side one end of a message port, so
// the two talk directly. The request is a number: the shell takes no entry file, argument, environment
// or other start option from it, and starts only the bundled host entry the layout names (I02B-C50).
// One host per backend: a new request ends the previous host first, and while one is starting only the
// newest waiting request is kept. When the backend goes, so does its host.
/** What the shell needs of a utility process it started (Electron's, or a fake in tests). */
export interface HostProcess {
  readonly pid: number | undefined;
  postMessage(message: unknown, transfer?: readonly unknown[]): void;
  once(event: "exit", listener: () => void): void;
  kill(): boolean;
  /** Ends the process without asking, for one that ignored kill(). */
  forceKill?(): void;
}

/** The backend's end of the parent channel. */
export interface BackendEnd {
  postMessage(message: unknown, transfer?: readonly unknown[]): void;
}

/** What `utilityProcess.fork` is called with (Electron's, or a fake in tests). */
export type ForkUtility = (
  entry: string,
  args: string[],
  options: { env: Record<string, string>; serviceName: string; stdio: "ignore" },
) => UtilityLike;

/**
 * The shell's broker as the product builds it (main.ts): the host is the bundled entry, started with no
 * argument and an empty environment, whatever a request carries (I02B-C50).
 */
export function createProductNormalizerHostBroker(options: {
  fork: ForkUtility;
  entry: string;
  newChannel: BrokerOptions["newChannel"];
  backend: BackendEnd;
}): NormalizerHostBroker {
  return createNormalizerHostBroker({
    forkHost: () => startNormalizerHostProcess(options.fork, options.entry),
    newChannel: options.newChannel,
    backend: options.backend,
  });
}

/** The part of Electron's `utilityProcess.fork` result the shell uses. */
export interface UtilityLike {
  readonly pid: number | undefined;
  postMessage(message: unknown, transfer?: readonly unknown[]): void;
  once(event: "exit", listener: () => void): unknown;
  kill(): boolean;
}

/**
 * Starts the normalizer host as a utility process: `entry` and `args` are the shell's own (the
 * bundled host file, none), the environment is empty and there are no standard streams. Nothing of
 * what the backend sent reaches this call (I02B-C50).
 */
export function startNormalizerHostProcess(
  fork: ForkUtility,
  entry: string,
  args: readonly string[] = [],
): HostProcess {
  const child = fork(entry, [...args], { env: {}, serviceName: "PKI normalizer", stdio: "ignore" });
  return {
    get pid() {
      return child.pid;
    },
    postMessage: (message, transfer) => child.postMessage(message, transfer),
    once: (_event, listener) => void child.once("exit", listener),
    kill: () => child.kill(),
    forceKill: () => {
      if (child.pid === undefined) return;
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    },
  };
}

export interface NormalizerHostBroker {
  /** The backend asked for a host (`normalizer-host-start`). */
  start(id: number): void;
  /** The backend asked to end its host (`normalizer-host-end`). */
  end(id: number): void;
  /** The backend is gone: end its host. */
  stop(): void;
}

export interface BrokerOptions {
  /** Starts the bundled host entry, with fixed arguments and environment: nothing from a request. */
  forkHost(): HostProcess;
  /** A new message port pair (Electron's `MessageChannelMain`). */
  newChannel(): { port1: unknown; port2: unknown };
  backend: BackendEnd;
  /** After kill(), how long until forceKill() (default 2 s). */
  killTimeoutMs?: number;
}

interface Live {
  id: number;
  host: HostProcess;
  exited: Promise<void>;
  gone: boolean;
  /** The ending in progress, when one is. */
  ending: Promise<boolean> | undefined;
}

export function createNormalizerHostBroker(options: BrokerOptions): NormalizerHostBroker {
  const killAfterMs = options.killTimeoutMs ?? 2_000;
  let live: Live | undefined;
  let busy = false;
  let waiting: number | undefined;
  let stopped = false;

  const tell = (message: unknown, transfer?: readonly unknown[]) => {
    try {
      options.backend.postMessage(message, transfer);
    } catch {
      // the backend is gone; nothing to tell
    }
  };

  /** Waits for `current` to exit for `ms`, with a timer of its own each time. */
  const exitsWithin = (current: Live, ms: number) =>
    Promise.race([
      current.exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), ms).unref()),
    ]);

  /**
   * Ends the host the broker holds and says whether it is gone. The host stays held until its `exit`
   * event, not until the kill is sent: a host that survived kill() and forceKill() (or one that cannot be
   * forced: no pid) is still held, so the next request finds it and no second host is started over it.
   * One ending runs at a time, whoever asked (a request to end, or a start).
   */
  function endLive(): Promise<boolean> {
    const current = live;
    if (current === undefined || current.gone) return Promise.resolve(true);
    current.ending ??= (async () => {
      current.host.kill();
      if (await exitsWithin(current, killAfterMs)) return true;
      current.host.forceKill?.();
      return exitsWithin(current, killAfterMs);
    })().finally(() => {
      // a host that is still there may be ended again by the next request
      current.ending = undefined;
    });
    return current.ending;
  }

  async function serve(id: number) {
    let ports: { port1: unknown; port2: unknown } | undefined;
    try {
      // never two hosts: the next one starts over a host that is gone, or not at all
      if (!(await endLive())) throw new Error("the previous host is still alive");
      if (stopped) return;
      ports = options.newChannel();
      const { port1, port2 } = ports;
      const host = options.forkHost();
      const current: Live = {
        id,
        host,
        gone: false,
        ending: undefined,
        exited: new Promise<void>((resolve) =>
          host.once("exit", () => {
            current.gone = true;
            if (live === current) live = undefined;
            current.ending = undefined;
            // tells the backend which host went; one that was ended on purpose is old news to it
            tell({ type: "normalizer-host-gone", id });
            resolve();
          }),
        ),
      };
      live = current;
      host.postMessage({ type: "port" }, [port1]);
      tell({ type: "normalizer-host", id }, [port2]);
    } catch {
      // the ports of a host that did not start are closed, not left to the garbage collector
      for (const port of [ports?.port1, ports?.port2]) {
        try {
          (port as { close?: () => void } | undefined)?.close?.();
        } catch {
          // already closed
        }
      }
      tell({ type: "normalizer-host-failed", id });
    }
  }

  async function drain(first: number) {
    let id: number | undefined = first;
    while (id !== undefined) {
      await serve(id);
      id = waiting;
      waiting = undefined;
    }
    busy = false;
  }

  return {
    start(id) {
      if (stopped) return;
      if (busy) {
        // a request that was still waiting is replaced by this one: the backend wants one host
        if (waiting !== undefined) tell({ type: "normalizer-host-failed", id: waiting });
        waiting = id;
        return;
      }
      busy = true;
      void drain(id);
    },
    end(id) {
      if (live?.id === id) void endLive();
    },
    stop() {
      stopped = true;
      if (waiting !== undefined) tell({ type: "normalizer-host-failed", id: waiting });
      waiting = undefined;
      void endLive();
    },
  };
}
