// The fake CLI's leak check (review A-D4): it kills only processes that are this
// fake's own, by their command line; a recorded PID now belonging to another
// process (reused by the OS) is left alone.
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installFakeCli, processAlive } from "./fake-cli.ts";

const others: number[] = [];
afterEach(() => {
  for (const pid of others.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
});

describe("installFakeCli leftovers", () => {
  it("never kills a process that is not the fake's, though its PID was recorded", async () => {
    const fake = installFakeCli();
    try {
      const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      const pid = other.pid ?? 0;
      others.push(pid);
      // as if the OS had given a recorded fake PID to this unrelated process
      appendFileSync(
        join(fake.bin, "..", "state", "pids.jsonl"),
        `${JSON.stringify({ child: pid, grandchild: pid })}\n`,
      );
      expect(await fake.leftovers(100)).toEqual([]);
      fake.dispose();
      expect(processAlive(pid)).toBe(true);
    } finally {
      fake.dispose();
    }
  });
});

// I06F-C9 (I06F-R10): a fake that starts late records nothing until its delay has passed, and one ended
// by SIGTERM meanwhile ends with no record, as a process that was slow to start would.
const ended = (child: ChildProcess) =>
  new Promise<void>((resolve) => child.once("exit", () => resolve()));

describe("installFakeCli startDelayMs", () => {
  it("records no run and no PID when ended by SIGTERM inside the delay; without it the same call records", async () => {
    const fake = installFakeCli();
    try {
      const plain = spawn(fake.path("claude"), ["--version"], { env: { PATH: fake.bin } });
      plain.stdin.end();
      await ended(plain);
      expect(fake.runs().map((r) => r.kind)).toEqual(["version"]); // the control: it does record here
      fake.reset();

      fake.configure({ startDelayMs: 20_000 });
      const slow = spawn(fake.path("claude"), ["--version"], { env: { PATH: fake.bin } });
      slow.stdin.end();
      const slowEnded = ended(slow); // watched from the start: a fake with no delay is gone before the signal
      await new Promise((r) => setTimeout(r, 1_000)); // long enough for a Node start to have recorded
      slow.kill("SIGTERM");
      await slowEnded;
      expect(fake.runs()).toEqual([]);
      expect(fake.spawned()).toEqual([]);
    } finally {
      fake.dispose();
    }
  });
});
