// P02-R9: the backend's `notify` message reaches the shell's notifier only when it has exactly its five keys, and
// the notifier's answer goes back as `notify-ack`; a message with a key more neither reaches it nor fails the backend.
import { describe, expect, it } from "vitest";
import { startBackendProcess, type BackendChild } from "./backend-process.ts";
import type { NotifyMessage } from "./notifier.ts";

function fakeBackend() {
  const posted: unknown[] = [];
  const listeners: ((message: unknown) => void)[] = [];
  let killed = 0;
  const child: BackendChild = {
    pid: 1,
    postMessage: (message) => void posted.push(message),
    on: (_event, listener) => void listeners.push(listener),
    once: () => undefined,
    kill: () => (killed += 1) > 0,
  };
  return {
    child,
    posted,
    killed: () => killed,
    emit: (message: unknown) => listeners.forEach((l) => l(message)),
  };
}

const notify = { type: "notify", id: "a-1", kind: "daily", count: 2, unread: 4 };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function started(answer: (m: NotifyMessage) => Promise<"shown" | undefined>) {
  const backend = fakeBackend();
  const seen: NotifyMessage[] = [];
  const running = startBackendProcess({
    fork: () => backend.child,
    entry: "entry.js",
    origin: "app://pki",
    userData: "/u",
    scopePolicy: undefined,
    notify: (m) => (seen.push(m), answer(m)),
  });
  backend.emit({ type: "ready", port: 4000 });
  await running;
  return { ...backend, seen };
}

describe("backend-process: the notify message (P02-R9)", () => {
  it("hands a valid message to the notifier once and posts its answer back as notify-ack", async () => {
    const b = await started(async () => "shown");
    b.emit(notify);
    await tick();
    expect(b.seen).toEqual([notify]);
    expect(b.posted).toContainEqual({ type: "notify-ack", id: "a-1", result: "shown" });
  });

  it("drops a message with one key more: the notifier is not asked, nothing is answered, the backend keeps running", async () => {
    const b = await started(async () => "shown");
    b.emit({ ...notify, summary: "항목 이름" });
    await tick();
    expect(b.seen).toEqual([]);
    expect(b.posted.filter((m) => (m as { type: string }).type === "notify-ack")).toEqual([]);
    expect(b.killed()).toBe(0);
  });
});
