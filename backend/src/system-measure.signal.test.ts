// H03C2F-C7 (docs/specs/2026-11-24-H03C2F-runner-followups.md): a measurement command that gets SIGTERM while its
// backend runs ends 143 (SIGTERM) and leaves neither the backend nor its work folder behind. POSIX only: it probes a
// process group.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const MAIN = join(import.meta.dirname, "system-measure.main.test-support.ts");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const groupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};
/** The command's direct children: the backends the runner started. */
const children = (pid: number): number[] =>
  spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
    .stdout.split("\n")
    .filter(Boolean)
    .map(Number);

describe.skipIf(process.platform === "win32")("system-measure signal (H03C2F)", () => {
  it("H03C2F-C7: SIGTERM ends the command non-zero, kills its backend and removes its work folder", async () => {
    const out = mkdtempSync(join(tmpdir(), "pki-c7-out-"));
    // the command's own temp root, so another test's work folder is never mistaken for its
    const temp = mkdtempSync(join(tmpdir(), "pki-c7-tmp-"));
    const workDirs = () => readdirSync(temp).filter((n) => n.startsWith("pki-measure-"));
    const command = spawn(
      process.execPath,
      [
        MAIN,
        "--out",
        out,
        "--name",
        "sig",
        "--sources",
        "2",
        "--queries",
        "25",
        "--idle-seconds",
        "60",
        "--skip-kill",
      ],
      { cwd: ROOT, stdio: "ignore", env: { ...process.env, TMPDIR: temp } },
    );
    const exited = new Promise<number | null>((r) => command.on("exit", (code) => r(code)));
    let backend: number[] = [];
    try {
      const deadline = Date.now() + 60_000;
      while (backend.length === 0 && Date.now() < deadline) {
        await sleep(200);
        backend = children(command.pid as number);
      }
      expect(backend.length).toBeGreaterThan(0);
      const created = workDirs();
      expect(created.length).toBe(1);
      command.kill("SIGTERM");
      const code = await exited;
      expect(code).toBe(143);
      for (const pid of backend) expect(groupAlive(pid)).toBe(false);
      expect(workDirs()).toEqual([]);
    } finally {
      command.kill("SIGKILL");
      // the backend is detached: a run that fails before the SIGTERM step must not orphan it
      for (const pid of backend) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      rmSync(out, { recursive: true, force: true });
      rmSync(temp, { recursive: true, force: true });
    }
  }, 120_000);
});
