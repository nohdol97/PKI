// Runs one CLI process as a tree the caller can end (V01-R9): no shell, an argument
// array, stdin written then closed (or none), output capped, and a kill that
// reaches the children and grandchildren even when the CLI ignores SIGTERM.
// POSIX: the child leads a new process group; ending it sends SIGTERM to the
// group, then SIGKILL after a grace period. When the CLI exits by itself the
// group is sent SIGKILL too, so nothing it left behind keeps running.
// Known gap: a grandchild that leaves the group (setsid) is not reached.
// Windows: `taskkill /PID <pid> /T /F` (unverified: never run, A04).
import { spawn } from "node:child_process";
import { join } from "node:path";

export interface TreeRun {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  /** Written to stdin, which is then closed; undefined gives no stdin at all. */
  stdin: string | undefined;
  maxOutputBytes: number;
  killGraceMs: number;
}

export interface TreeResult {
  exitCode: number | null;
  stdout: string;
  /** Read only to be dropped: never copied into an error, a result or a log. */
  stderr: string;
  /** Ended by `kill` (timeout, abort or cancel) rather than by itself. */
  killed: boolean;
  overflow: boolean;
  /** The process could not start (e.g. the executable is gone). */
  spawnFailed: boolean;
}

export interface TreeHandle {
  readonly done: Promise<TreeResult>;
  /** Ends the whole tree; resolves when the process has exited. */
  kill(): Promise<void>;
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // the group is already gone
  }
}

function taskkill(pid: number): Promise<void> {
  const root = process.env.SystemRoot ?? "C:\\Windows";
  return new Promise((resolve) => {
    const child = spawn(join(root, "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => resolve());
    child.once("exit", () => resolve());
  });
}

export function runTree(run: TreeRun): TreeHandle {
  const windows = process.platform === "win32";
  const child = spawn(run.executable, [...run.args], {
    cwd: run.cwd,
    env: run.env,
    shell: false,
    detached: !windows, // a new process group to signal as a whole
    windowsHide: true,
    stdio: [run.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  let killed = false;
  let overflow = false;
  let exited = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  let size = 0;

  const exit = new Promise<void>((resolve) => {
    child.once("error", () => resolve()); // never started: nothing to wait for
    child.once("exit", () => {
      exited = true;
      clearTimeout(graceTimer);
      // whatever the CLI left in its group goes with it
      if (!windows && child.pid !== undefined) signalGroup(child.pid, "SIGKILL");
      // a descendant outside the group may hold the pipes open: stop waiting for it
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, 1_000).unref();
      resolve();
    });
  });

  let ending = false;
  const endTree = async (): Promise<void> => {
    if (child.pid === undefined || exited || ending) return;
    ending = true;
    if (windows) {
      await taskkill(child.pid);
      return;
    }
    signalGroup(child.pid, "SIGTERM");
    graceTimer = setTimeout(() => {
      if (child.pid !== undefined) signalGroup(child.pid, "SIGKILL");
    }, run.killGraceMs);
  };

  const kill = async (): Promise<void> => {
    killed = true;
    await endTree();
    await exit;
  };

  for (const name of ["stdout", "stderr"] as const) {
    child[name]?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > run.maxOutputBytes) {
        if (!overflow) {
          overflow = true;
          void kill();
        }
        return;
      }
      chunks[name].push(chunk);
    });
  }

  const done = new Promise<TreeResult>((resolve) => {
    const result = (exitCode: number | null, spawnFailed: boolean): TreeResult => ({
      exitCode,
      stdout: Buffer.concat(chunks.stdout).toString("utf8"),
      stderr: Buffer.concat(chunks.stderr).toString("utf8"),
      killed,
      overflow,
      spawnFailed,
    });
    child.once("error", () => {
      exited = true;
      resolve(result(null, true));
    });
    // "close": the process exited and its output pipes closed (the group kill on
    // exit ends any grandchild still holding them)
    child.once("close", (code) => resolve(result(code, false)));
  });

  if (run.stdin !== undefined && child.stdin) {
    child.stdin.on("error", () => undefined); // a CLI that exits early closes its stdin
    child.stdin.end(run.stdin);
  }
  return { done, kill };
}
