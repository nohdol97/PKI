// I02B-R22 (adapter ⓑ): the real shell entry, under Node's fork, takes the shell's answers about a
// normalizer host as its own messages. Before the start, a message that is not the shell's `start` ends
// the backend (a malformed start is refused); an answer about a host is not that, so the start that
// follows it still works. The ports and the real processes are in artifact.normalizer.e2e.ts.
import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ENTRY = fileURLToPath(new URL("./shell.ts", import.meta.url));
const TOKEN = "n".repeat(43);

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "pki-shell-host-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the shell entry and the normalizer host's answers", () => {
  it("an answer about a host before the start is not a malformed start", async () => {
    const proc = fork(ENTRY, ["--data-dir", join(dir, "data")], {
      env: { PATH: process.env.PATH ?? "", HOME: dir },
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const messages: unknown[] = [];
    const exited = new Promise<number | null>((resolve) => proc.once("exit", resolve));
    const ready = new Promise<void>((resolve) =>
      proc.on("message", (m) => {
        messages.push(m);
        resolve();
      }),
    );
    try {
      proc.send({ type: "normalizer-host-gone", id: 5 });
      proc.send({ type: "normalizer-host-failed", id: 6 });
      proc.send({ type: "start", token: TOKEN });
      await ready;
      expect(messages[0]).toMatchObject({ type: "ready" });
      proc.send({ type: "stop" });
      expect(await exited).toBe(0);
    } finally {
      proc.kill("SIGKILL");
    }
  }, 30_000);
});
