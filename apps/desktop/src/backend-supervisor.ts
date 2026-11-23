// Keeps the shell's backend running (V01-T16): a backend that exits by itself is
// started again, at most `maxRestarts` times per shell run, with the run's token, so
// the page's session stays valid. Each start binds a port of its own and `url()`
// names only the backend that is running now: between an exit and the next ready,
// and after giving up, there is none, and nothing is forwarded (a freed loopback
// port can be taken by any local process, T06 handoff 3). A quit stops whatever is
// running or still starting, and starts nothing more.
import { randomBytes } from "node:crypto";
import type { Backend } from "./backend-process.ts";

export interface SupervisorOptions {
  /** Starts one backend process with the run's token (startBackendProcess). */
  start(token: string): Promise<Backend>;
  /** Restarts allowed per shell run, failed starts included. */
  maxRestarts: number;
  /** Called once when a backend exits and no restart is left; its exit code. */
  onGiveUp?(code: number): void;
}

export interface Supervisor {
  token: string;
  /** The running backend's address, or undefined while none is running. */
  url(): string | undefined;
  /** Forwards a picked path and its ticket to the running backend; false when none is running. */
  registerLocationTicket(input: Parameters<Backend["registerLocationTicket"]>[0]): boolean;
  /** Asks the running backend where a local source's file is; undefined when none is running or none to show. */
  revealPath(sourceVersionId: number): Promise<string | undefined>;
  /** Tells the running backend the OS woke from sleep; nothing when none is running. */
  resumed(): void;
  /** Stops the backend (or the one starting) and restarts nothing after it. */
  stop(): Promise<void>;
}

/** Starts the first backend; rejects if that one fails (the shell then reports and exits). */
export async function superviseBackend(options: SupervisorOptions): Promise<Supervisor> {
  const token = randomBytes(32).toString("base64url");
  let restarts = 0;
  let stopping = false;
  let running: Backend | undefined;
  let starting: Promise<void> | undefined;

  const watch = (backend: Backend) => {
    running = backend;
    void backend.exited.then((code) => {
      if (running === backend) running = undefined;
      if (!stopping) restart(code);
    });
  };

  const restart = (code: number) => {
    if (restarts >= options.maxRestarts) return options.onGiveUp?.(code);
    restarts += 1;
    starting = options.start(token).then(
      (backend) => {
        starting = undefined;
        // a quit that came while it started stops it in stop() below
        watch(backend);
      },
      () => {
        starting = undefined;
        if (!stopping) restart(code);
      },
    );
  };

  watch(await options.start(token));
  return {
    token,
    url: () => running?.url,
    registerLocationTicket: (input) => running?.registerLocationTicket(input) ?? false,
    revealPath: async (sourceVersionId) => running?.revealPath(sourceVersionId),
    resumed: () => running?.resumed(),
    async stop() {
      stopping = true;
      await starting;
      const backend = running;
      running = undefined;
      await backend?.stop();
    },
  };
}
