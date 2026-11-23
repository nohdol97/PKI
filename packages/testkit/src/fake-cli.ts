// Fake CLI executables for the CLI Providers' tests (V01-T10): a `claude` and a
// `codex` on a temporary folder meant to be the whole PATH. Each is a shell
// wrapper running fake-cli-main.ts with this Node; see that file for what they
// emulate. POSIX only (the wrappers are /bin/sh scripts).
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FakeCliMode = "ok" | "fail-echo" | "garbage" | "hang" | "stubborn" | "flood";

export interface FakeCliConfig {
  /** What a model call does: answer (default), fail echoing stdin after `marker`, print non-JSON, hang, ignore SIGTERM and leave a grandchild, or flood a stream with 2 MiB then do the same. */
  mode?: FakeCliMode;
  /** The bare version; the printed line wraps it as each CLI does. */
  version?: string;
  /** Printed instead of the wrapped version line. */
  versionOutput?: string;
  /** The version query answers, fails, prints its version but exits 1, or hangs ignoring SIGTERM with a grandchild. */
  versionMode?: "ok" | "fail" | "print-and-fail" | "hang";
  /** `codex login status`. */
  auth?: "logged-in" | "logged-out";
  /** The structured output of a model call; default a value of the schema's required fields. */
  output?: unknown;
  marker?: string;
  /** "flood": the stream that gets 2 MiB before the CLI hangs like "stubborn". Default stdout. */
  floodStream?: "stdout" | "stderr";
  /** A model call that answers also leaves a grandchild running. */
  leaveGrandchild?: boolean;
  /**
   * Waits this long before recording anything, as a Node process slow to start does. A SIGTERM inside the
   * wait ends it with no record. Default: no wait.
   */
  startDelayMs?: number;
}

export interface FakeCliRun {
  kind: "version" | "auth" | "model" | "rejected";
  name: string;
  args: string[];
  cwd: string;
  envNames: string[];
  env: Record<string, string>;
  pid: number;
  stdinBytes?: number;
}

export interface FakeCli {
  /** The folder holding `claude` and `codex`: use it as PATH. */
  readonly bin: string;
  /** Absolute path of one fake executable. */
  path(name: "claude" | "codex"): string;
  configure(config: FakeCliConfig): void;
  /** Forgets the runs and PIDs recorded so far. */
  reset(): void;
  runs(): FakeCliRun[];
  modelCalls(name?: "claude" | "codex"): number;
  /** PIDs a "stubborn" or `leaveGrandchild` run left: the CLI process and its grandchild. */
  spawned(): { child: number; grandchild: number }[];
  /**
   * Leak check: waits up to `waitMs` for every process this fake started (each run and
   * each grandchild) to end, then kills the ones still there and returns their PIDs.
   * A test that leaves none gets []; the host keeps nothing either way.
   */
  leftovers(waitMs?: number): Promise<number[]>;
  /** Removes the fake's folder, after killing anything it left. */
  dispose(): void;
}

const MAIN = join(import.meta.dirname, "fake-cli-main.ts");
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export function installFakeCli(config: FakeCliConfig = {}, parent = tmpdir()): FakeCli {
  // by its real path: the Providers report the real path of what they found
  const root = realpathSync(mkdtempSync(join(parent, "pki-fake-cli-")));
  const bin = join(root, "bin");
  const state = join(root, "state");
  mkdirSync(bin);
  mkdirSync(state);
  const configure = (next: FakeCliConfig) =>
    writeFileSync(join(state, "config.json"), JSON.stringify({ version: "2.1.3", ...next }));
  configure(config);
  for (const name of ["claude", "codex"]) {
    const file = join(bin, name);
    writeFileSync(
      file,
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(MAIN)} ${quote(state)} ${name} "$@"\n`,
    );
    chmodSync(file, 0o755);
  }
  const lines = (file: string) => {
    try {
      return readFileSync(join(state, file), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as unknown);
    } catch {
      return [];
    }
  };
  const runs = () => lines("calls.jsonl") as FakeCliRun[];
  const spawned = () => lines("pids.jsonl") as { child: number; grandchild: number }[];
  /** Every PID this fake started: its runs and their grandchildren. */
  const started = () => [
    ...new Set([...runs().map((r) => r.pid), ...spawned().flatMap((s) => [s.child, s.grandchild])]),
  ];
  return {
    bin,
    path: (name) => join(bin, name),
    configure,
    reset: () => {
      rmSync(join(state, "calls.jsonl"), { force: true });
      rmSync(join(state, "pids.jsonl"), { force: true });
    },
    runs,
    modelCalls: (name) =>
      runs().filter((r) => r.kind === "model" && (name === undefined || r.name === name)).length,
    spawned,
    leftovers: async (waitMs = 3_000) => {
      const ours = () => started().filter((pid) => isFake(pid, state));
      const end = Date.now() + waitMs;
      while (ours().length > 0 && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const alive = ours();
      for (const pid of alive) kill(pid);
      return alive;
    },
    dispose: () => {
      for (const pid of started().filter((p) => isFake(p, state))) kill(pid);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Whether a process is still there (a zombie of this process counts as gone once reaped). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether `pid` is alive and is one of this fake's processes: its command line names
 * this fake's state directory (each run's and each grandchild's does). A recorded PID
 * the OS has since reused for another process is not ours, and is never killed.
 */
function isFake(pid: number, state: string): boolean {
  if (!processAlive(pid)) return false;
  try {
    const command = execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
    });
    return command.includes(state);
  } catch {
    return false; // gone meanwhile
  }
}

/** SIGKILL to one verified process; never to a group. */
function kill(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // gone already
  }
}
