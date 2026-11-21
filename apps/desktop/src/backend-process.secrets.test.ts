// The shell answers the backend's secret requests over the parent channel (V01-R4,
// R13): the value goes only to that child, only when asked, and never at start.
import type { SecretRead } from "@pki/contracts";
import { describe, expect, it } from "vitest";
import { startBackendProcess, type BackendChild, type ForkBackend } from "./backend-process.ts";

const CANARY = "sk-canary-process";

/** A child that reports ready on start and lets the test speak as the backend. */
function fakeChild() {
  const posted: unknown[] = [];
  let onMessage: (message: unknown) => void = () => undefined;
  const started: { args: string[]; env: Record<string, string> }[] = [];
  const child: BackendChild = {
    pid: 1,
    postMessage(message) {
      posted.push(message);
      if ((message as { type?: string }).type === "start") {
        queueMicrotask(() => onMessage({ type: "ready", port: 4000 }));
      }
    },
    on: (_event, listener) => void (onMessage = listener),
    once: () => undefined,
    kill: () => true,
  };
  const fork: ForkBackend = (_entry, args, env) => (started.push({ args, env }), child);
  return { fork, posted, started, send: (m: unknown) => onMessage(m) };
}

const store = (read: SecretRead) => ({ read: async () => read });
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("backend secret requests", () => {
  it("answers a request with the stored value, matched by ID", async () => {
    const child = fakeChild();
    await startBackendProcess({
      fork: child.fork,
      entry: "x",
      origin: "app://pki",
      secrets: store({ state: "present", value: CANARY }),
    });
    expect(JSON.stringify([child.started, child.posted])).not.toContain(CANARY);

    child.send({ type: "secret-request", id: 3, name: "openai-compatible.api-key" });
    await settle();
    expect(child.posted.at(-1)).toEqual({ type: "secret", id: 3, state: "present", value: CANARY });
  });

  it.each([
    ["missing", { state: "missing" } as const],
    ["unavailable", { state: "unavailable" } as const],
  ])("passes on %s", async (_name, read) => {
    const child = fakeChild();
    await startBackendProcess({
      fork: child.fork,
      entry: "x",
      origin: "app://pki",
      secrets: store(read),
    });
    child.send({ type: "secret-request", id: 1, name: "a" });
    await settle();
    expect(child.posted.at(-1)).toEqual({ type: "secret", id: 1, ...read });
  });

  it("answers unavailable when the shell has no store, or the store fails", async () => {
    for (const secrets of [undefined, { read: () => Promise.reject(new Error("x")) }]) {
      const child = fakeChild();
      await startBackendProcess({ fork: child.fork, entry: "x", origin: "app://pki", secrets });
      child.send({ type: "secret-request", id: 1, name: "a" });
      await settle();
      expect(child.posted.at(-1)).toEqual({ type: "secret", id: 1, state: "unavailable" });
    }
  });

  it.each([
    ["an invalid name", { type: "secret-request", id: 1, name: "Bad Name!" }],
    ["an extra field", { type: "secret-request", id: 1, name: "a", extra: 1 }],
    ["no ID", { type: "secret-request", name: "a" }],
  ])("ignores a request with %s", async (_name, request) => {
    const child = fakeChild();
    let asked = 0;
    await startBackendProcess({
      fork: child.fork,
      entry: "x",
      origin: "app://pki",
      secrets: { read: async () => (asked++, { state: "present", value: CANARY }) },
    });
    const before = child.posted.length;
    child.send(request);
    await settle();
    expect(child.posted.length).toBe(before);
    expect(asked).toBe(0);
  });
});
