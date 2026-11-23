// H03-C2-C3 (docs/specs/2026-11-24-H03-C2-measure-runner.md): the forced-kill phase of the measurement runner against a
// test build with a one-second job lease (vitest.system-measure.config.ts), so the interrupted job is reclaimed in
// seconds. The lease is a test-build override: the product's recovery time is the source run's (D4). POSIX only: the
// rig kills and probes a process group, which Windows does not have.
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runKillPhase } from "./system-measure.test-support.ts";

const alive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

describe.skipIf(process.platform === "win32")("system-measure kill (H03-C2, C3)", () => {
  it("C3: recovers every document after a kill while a job ran, with no duplicate knowledge item and nothing left behind", async () => {
    const trace: { pids: number[]; workDir?: string } = { pids: [] };
    const value = await runKillPhase({ mode: "test-build", leaseMs: 1000, docs: 3, trace });
    expect(value.runningAtKill).toBeGreaterThan(0);
    expect(value.failedJobs).toEqual({});
    expect(value.lostDocs).toBe(0);
    expect(value.duplicateItems).toBe(0);
    expect(value.firstJobAfterRestartMs).toBeGreaterThan(0);
    expect(value.allJobsDoneMs).toBeGreaterThanOrEqual(value.firstJobAfterRestartMs);
    expect(value.leaseSource).toBe("test build override");
    expect(value.leaseMs).toBe(1000);
    for (const pid of trace.pids) expect(alive(pid)).toBe(false);
    expect(existsSync(trace.workDir as string)).toBe(false);
  }, 120_000);
});
