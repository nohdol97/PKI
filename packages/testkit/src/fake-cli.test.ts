// The fake CLI's leak check (review A-D4): it kills only processes that are this
// fake's own, by their command line; a recorded PID now belonging to another
// process (reused by the OS) is left alone.
import { spawn } from "node:child_process";
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
