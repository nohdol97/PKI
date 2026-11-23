// H02A-C7 (shell half): the OS's wake-up reaches the backend as `{ type: "resumed" }`, and
// nothing is sent to a process that has ended (spec 2026-11-24-H02-common, R11).
import { describe, expect, it } from "vitest";
import { startBackendProcess, type BackendChild } from "./backend-process.ts";

function fakeBackend() {
  const posted: unknown[] = [];
  const listeners: ((message: unknown) => void)[] = [];
  const exits: ((code: number | null) => void)[] = [];
  const child: BackendChild = {
    pid: 1,
    postMessage: (message) => void posted.push(message),
    on: (_event, listener) => void listeners.push(listener),
    once: (_event, listener) => void exits.push(listener as (code: number | null) => void),
    kill: () => true,
  };
  return {
    child,
    posted,
    ready: () => listeners.forEach((l) => l({ type: "ready", port: 4000 })),
    exit: () => exits.forEach((l) => l(0)),
  };
}

describe("backend-process: resumed (H02A-R11)", () => {
  it("H02A-C7: posts resumed to the running child and nothing after it has exited", async () => {
    const fake = fakeBackend();
    const running = startBackendProcess({
      fork: () => fake.child,
      entry: "entry.js",
      origin: "app://pki",
      userData: "/u",
      scopePolicy: undefined,
    });
    fake.ready();
    const backend = await running;
    backend.resumed();
    expect(fake.posted.filter((m) => (m as { type: string }).type === "resumed")).toEqual([
      { type: "resumed" },
    ]);
    fake.exit();
    await backend.exited;
    backend.resumed();
    expect(fake.posted.filter((m) => (m as { type: string }).type === "resumed")).toHaveLength(1);
  });
});
