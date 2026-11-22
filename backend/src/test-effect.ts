// The `test-effect` job kind (I03-R24), for the kill tests only: only tests and
// the child-process harness (job-kill.child.ts) import this module, and a runner
// takes its handler through `testBuild.handlers`, honoured in a test build only.
// Each run appends "<job ID> <attempt>" to a run log outside the canonical store
// ("it ran"), then either waits at the test's pause point until killed or writes
// one effect row in the result transaction. A job may instead stop inside that
// transaction, after its effect row and before the commit: it notes the point in
// `<run log>.write` and blocks the process until killed, so the kill tests can
// show the effect rolled back with the transaction. The effect table has no unique key, so
// a result written twice leaves two rows: the run log shows how often a job ran,
// the effect rows how often its result stayed.
import type { SqlDriver } from "@pki/storage";
import { appendFileSync } from "node:fs";
import type { JobHandler } from "./job-runner.ts";

export const TEST_EFFECT_JOB_KIND = "test-effect";

export interface TestEffectOptions {
  /** The run log file, outside the canonical store. */
  runLog: string;
  /** Jobs whose target is listed wait after logging, before their result, until their signal is cut. */
  pause?: readonly string[];
  /** Jobs whose target is listed block the process inside the result transaction, after the effect row. */
  pauseInWrite?: readonly string[];
}

/** Where a job that stopped inside its result transaction is noted. */
export const writePauseLog = (runLog: string): string => `${runLog}.write`;

export function createTestEffectHandler(db: SqlDriver, options: TestEffectOptions): JobHandler {
  // not a migration: the table exists only in a store a test build ran this kind on
  db.exec("CREATE TABLE IF NOT EXISTS test_effects (job_id INTEGER NOT NULL)");
  const pause = new Set(options.pause ?? []);
  const pauseInWrite = new Set(options.pauseInWrite ?? []);
  return async (job, { signal }) => {
    appendFileSync(options.runLog, `${job.id} ${job.attempts}\n`);
    if (pause.has(job.target)) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      return { status: "fail", code: "paused", retryable: false }; // never written: the lease is lost
    }
    return {
      status: "succeeded",
      write: () => {
        db.run("INSERT INTO test_effects (job_id) VALUES (?)", [job.id]);
        if (pauseInWrite.has(job.target)) {
          appendFileSync(writePauseLog(options.runLog), `${job.id}\n`);
          // synchronous: the transaction stays open, holding the write lock, until the kill
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
      },
    };
  };
}

/** The effect rows of each job, by job ID. */
export function readTestEffects(db: SqlDriver): Map<number, number> {
  const rows = db.all("SELECT job_id, count(*) AS n FROM test_effects GROUP BY job_id");
  return new Map(rows.map((r) => [r.job_id as number, r.n as number]));
}

/** The run log's lines: how many times each job ran, and its attempt each time. */
export function readRunLog(text: string): { jobId: number; attempt: number }[] {
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [jobId, attempt] = line.split(" ").map(Number);
      return { jobId: jobId as number, attempt: attempt as number };
    });
}
