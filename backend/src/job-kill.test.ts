// I03-R24, C1: the backend killed mid-job (SIGKILL) and started again. The backend
// runs as a child process (job-kill.child.ts under vitest.job-kill.config.ts, a test
// build with a one-second lease and the `test-effect` kind) in its own process
// group; the test kills it where the run log shows the paused job ran, and checks
// that nothing of the group is left. The run log shows how often a job ran, the
// effect rows how often its result stayed: C1 holds only if a job ran twice and
// its effect stayed once. POSIX only: the rig kills and probes a process group
// (`process.kill(-pid)`), which Windows does not have, so there it is skipped
// with that reason until S19/R04 adapts it; SIGKILL on Windows is unverified (S19).
import { cancelJob, readJob, registerJob, type SqlDriver } from "@pki/storage";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCanonicalDb } from "./composition.ts";
import { readRunLog, readTestEffects, TEST_EFFECT_JOB_KIND, writePauseLog } from "./test-effect.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const VITEST = join(ROOT, "node_modules", "vitest", "vitest.mjs");
const CHILD_CONFIG = join(ROOT, "vitest.job-kill.config.ts");
const LEASE_MS = 1000;
const WAIT_MS = 30_000;

let dir: string;
let dataDir: string;
let runLog: string;
let live: ChildProcess[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-job-kill-"));
  dataDir = join(dir, "data");
  runLog = join(dir, "runs.log");
  writeFileSync(runLog, "");
});

afterEach(() => {
  for (const child of live) killGroup(child);
  live = [];
  rmSync(dir, { recursive: true, force: true });
});

function killGroup(child: ChildProcess): void {
  try {
    process.kill(-(child.pid as number), "SIGKILL");
  } catch {
    // the group is gone
  }
}

/** Whether any process of the child's group is still there. */
function groupAlive(child: ChildProcess): boolean {
  try {
    process.kill(-(child.pid as number), 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function until(what: string, check: () => boolean, child?: ChildProcess): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!check()) {
    if (child && child.exitCode !== null) throw new Error(`the backend exited waiting for ${what}`);
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface Backend {
  child: ChildProcess;
}

/** Starts the backend; `pause` lists the targets whose test-effect jobs wait to be killed. */
/** Skipped on Windows: the rig needs POSIX process groups (S19, R04 adapt it). */
const posixOnly = describe.skipIf(process.platform === "win32");

/**
 * Starts the backend; `pause` lists the targets whose test-effect jobs wait to be
 * killed before their result, `pauseInWrite` those that stop inside the result
 * transaction.
 */
async function start(
  pause: readonly string[] = [],
  pauseInWrite: readonly string[] = [],
): Promise<Backend> {
  const ready = join(dir, `ready-${live.length}`);
  const child = spawn(process.execPath, [VITEST, "run", "--config", CHILD_CONFIG, "--root", ROOT], {
    cwd: ROOT,
    detached: true, // its own process group: what it leaves behind is found below
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      TMPDIR: dir,
      PKI_KILL_DATA_DIR: dataDir,
      PKI_KILL_RUN_LOG: runLog,
      PKI_KILL_PAUSE: pause.join(","),
      PKI_KILL_PAUSE_WRITE: pauseInWrite.join(","),
      PKI_KILL_LEASE_MS: String(LEASE_MS),
      PKI_KILL_READY: ready,
    },
  });
  live.push(child);
  let err = "";
  child.stderr?.on("data", (chunk: Buffer) => (err += chunk.toString()));
  const backend = { child };
  try {
    await until("the backend to start", () => existsSync(ready), child);
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${err}`, { cause: error });
  }
  return backend;
}

/** SIGKILL, then nothing of the backend's process group may be left. */
async function kill(backend: Backend): Promise<void> {
  const { child } = backend;
  expect(groupAlive(child)).toBe(true); // the probe below sees a live group
  const exited = new Promise<void>((r) =>
    child.exitCode !== null ? r() : child.once("exit", () => r()),
  );
  child.kill("SIGKILL");
  await exited;
  expect(child.signalCode).toBe("SIGKILL");
  await new Promise((r) => setTimeout(r, 100));
  const leftover = groupAlive(child);
  killGroup(child);
  expect(leftover).toBe(false);
}

const runs = () => readRunLog(readFileSync(runLog, "utf8"));
const runsOf = (jobId: number) => runs().filter((r) => r.jobId === jobId);

function withDb<T>(fn: (db: SqlDriver) => T): T {
  const db = openCanonicalDb(dataDir);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Registers one test-effect job per target, in order, due now (the child's clock). */
function register(...targets: string[]): number[] {
  return withDb((db) =>
    targets.map((target) => {
      const r = registerJob(db, { kind: TEST_EFFECT_JOB_KIND, target, at: new Date() });
      if (!r.registered) throw new Error("expected a new job");
      return r.job.id;
    }),
  );
}

const statuses = (ids: readonly number[]) =>
  withDb((db) => ids.map((id) => readJob(db, id)?.status));

posixOnly("kill.resume (I03-R24, C1)", () => {
  it("finishes three jobs after a kill in the middle of one: three effects, the killed job ran twice", async () => {
    const [a, b, c] = register("a", "b", "c") as [number, number, number];
    const first = await start(["b"]);
    await until("job b to run", () => runsOf(b).length === 1, first.child);
    await kill(first);

    const second = await start();
    await until(
      "every job to finish",
      () => statuses([a, b, c]).every((s) => s === "succeeded"),
      second.child,
    );
    await kill(second);

    const effects = withDb(readTestEffects);
    expect([a, b, c].map((id) => effects.get(id))).toEqual([1, 1, 1]);
    expect(runsOf(a)).toHaveLength(1);
    expect(runsOf(b).map((r) => r.attempt)).toEqual([1, 2]);
    expect(runsOf(c)).toHaveLength(1);
    expect(withDb((db) => readJob(db, b)?.attempts)).toBe(2);
  }, 90_000);
});

posixOnly("effect.once (I03-R6, R24)", () => {
  it("does not run again a job killed right after its result was written", async () => {
    // the next job runs only once x's result committed: one job at a time
    const [x, next] = register("x", "next") as [number, number];
    const first = await start(["next"]);
    await until("the next job to run", () => runsOf(next).length === 1, first.child);
    await kill(first);

    const second = await start();
    await until("the next job to finish", () => statuses([next])[0] === "succeeded", second.child);
    await kill(second);

    expect(runsOf(x)).toHaveLength(1);
    expect(withDb(readTestEffects).get(x)).toBe(1);
    expect(withDb((db) => readJob(db, x))).toMatchObject({ status: "succeeded", attempts: 1 });
  }, 90_000);
});

posixOnly("effect.rollback (I03-R6, R24; review RA-2)", () => {
  it("rolls the effect back with the result transaction a kill interrupts, and writes it once on the rerun", async () => {
    const [w] = register("w") as [number];
    const pauses = writePauseLog(runLog);
    const first = await start([], ["w"]);
    // the effect row is written, the transaction not committed
    await until("job w to stop inside its result write", () => existsSync(pauses), first.child);
    await kill(first);

    // the next open rolls the interrupted transaction back: no effect, the job still running
    expect(withDb(readTestEffects).get(w)).toBeUndefined();
    expect(withDb((db) => readJob(db, w))).toMatchObject({ status: "running", attempts: 1 });

    const second = await start();
    await until("job w to finish", () => statuses([w])[0] === "succeeded", second.child);
    await kill(second);
    expect(withDb(readTestEffects).get(w)).toBe(1);
    expect(runsOf(w).map((r) => r.attempt)).toEqual([1, 2]);
  }, 90_000);
});

posixOnly("poison (I03-R5, R11, R24)", () => {
  it("gives up a job that kills the backend every run after the fifth reclaim, and finishes the rest", async () => {
    const [poison, o1, o2] = register("poison", "o1", "o2") as [number, number, number];
    for (let run = 1; run <= 5; run++) {
      const backend = await start(["poison"]);
      await until(
        `run ${run} of the poison job`,
        () => runsOf(poison).length === run,
        backend.child,
      );
      await kill(backend);
    }
    const last = await start(["poison"]); // were it claimed again, it would wait here
    // the poison job's last lease may outlast the start: the others can finish first
    await until(
      "the poison job to be given up and the others to finish",
      () => statuses([poison, o1, o2]).join() === "dead_letter,succeeded,succeeded",
      last.child,
    );
    await kill(last);

    expect(withDb((db) => readJob(db, poison))).toMatchObject({
      status: "dead_letter",
      reason: "lease-expired",
      attempts: 5,
    });
    expect(runsOf(poison).map((r) => r.attempt)).toEqual([1, 2, 3, 4, 5]);
    const effects = withDb(readTestEffects);
    expect([poison, o1, o2].map((id) => effects.get(id))).toEqual([undefined, 1, 1]);
  }, 120_000);
});

posixOnly("cancel.kill-after-flag (I03-R12, R5, C3)", () => {
  it("closes a job cancelled after its cancel request was written and the backend killed, without running it again", async () => {
    const [x, next] = register("x", "next") as [number, number];
    const first = await start(["x"]);
    await until("job x to run", () => runsOf(x).length === 1, first.child);
    // the request is written by another process, then the backend dies before it looks at it
    expect(withDb((db) => cancelJob(db, x))).toBe("requested");
    await kill(first);
    // normally still running; a heartbeat that landed before the kill may have closed it already
    const afterKill = withDb((db) => readJob(db, x));
    expect(afterKill?.cancelRequested).toBe(true);
    expect(["running", "cancelled"]).toContain(afterKill?.status);

    const second = await start();
    await until(
      "the job to be cancelled and the next to finish",
      () => statuses([x, next]).join() === "cancelled,succeeded",
      second.child,
    );
    await kill(second);

    expect(runsOf(x)).toHaveLength(1); // never run again
    expect(withDb(readTestEffects).get(x)).toBeUndefined();
    expect(withDb(readTestEffects).get(next)).toBe(1);
    expect(withDb((db) => readJob(db, x))).toMatchObject({ status: "cancelled", attempts: 1 });
  }, 90_000);
});
