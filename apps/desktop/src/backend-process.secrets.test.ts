// The shell answers the backend's secret requests over the parent channel (V01-R4,
// R13): the value goes only to that child, only when asked for a read, only for the
// names the backend may read (review B3), and never at start.
import type { SecretRead } from "@pki/contracts";
import { describe, expect, it } from "vitest";
import { startBackendProcess, type BackendChild, type ForkBackend } from "./backend-process.ts";

const CANARY = "sk-canary-process";
const KEY_NAME = `openai-compatible.api-key.${"0".repeat(32)}`;

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

function store(read: SecretRead) {
  const calls: string[] = [];
  return {
    calls,
    read: async (name: string) => (calls.push(`read ${name}`), read),
    has: async (name: string) => (
      calls.push(`has ${name}`),
      read.state === "unavailable"
        ? ({ ok: false, error: "unavailable" } as const)
        : ({ ok: true, present: read.state === "present" } as const)
    ),
  };
}
const settle = () => new Promise((r) => setTimeout(r, 0));
const start = (
  child: ReturnType<typeof fakeChild>,
  secrets?: Parameters<typeof startBackendProcess>[0]["secrets"],
) => startBackendProcess({ fork: child.fork, entry: "x", origin: "app://pki", secrets });

describe("backend secret requests", () => {
  it("answers a read with the stored value, matched by ID", async () => {
    const child = fakeChild();
    await start(child, store({ state: "present", value: CANARY }));
    expect(JSON.stringify([child.started, child.posted])).not.toContain(CANARY);

    child.send({ type: "secret-request", id: 3, name: KEY_NAME, mode: "read" });
    await settle();
    expect(child.posted.at(-1)).toEqual({ type: "secret", id: 3, state: "present", value: CANARY });
  });

  it("answers a presence request without the value", async () => {
    const child = fakeChild();
    const secrets = store({ state: "present", value: CANARY });
    await start(child, secrets);
    child.send({ type: "secret-request", id: 4, name: KEY_NAME, mode: "presence" });
    await settle();
    expect(child.posted.at(-1)).toEqual({ type: "secret", id: 4, state: "present" });
    expect(secrets.calls).toEqual([`has ${KEY_NAME}`]);
  });

  it.each([
    ["missing", { state: "missing" } as const],
    ["unavailable", { state: "unavailable" } as const],
  ])("passes on %s", async (_name, read) => {
    for (const mode of ["read", "presence"]) {
      const child = fakeChild();
      await start(child, store(read));
      child.send({ type: "secret-request", id: 1, name: KEY_NAME, mode });
      await settle();
      expect(child.posted.at(-1)).toEqual({ type: "secret", id: 1, ...read });
    }
  });

  it("answers unavailable when the shell has no store, or the store fails", async () => {
    const failing = {
      read: () => Promise.reject(new Error("x")),
      has: () => Promise.reject(new Error("x")),
    };
    for (const secrets of [undefined, failing]) {
      const child = fakeChild();
      await start(child, secrets);
      child.send({ type: "secret-request", id: 1, name: KEY_NAME, mode: "read" });
      await settle();
      expect(child.posted.at(-1)).toEqual({ type: "secret", id: 1, state: "unavailable" });
    }
  });

  it("gives the backend no secret outside its allowlist", async () => {
    const child = fakeChild();
    const secrets = store({ state: "present", value: CANARY });
    await start(child, secrets);
    for (const name of ["openai-compatible.api-key", "some-other-secret"]) {
      child.send({ type: "secret-request", id: 1, name, mode: "read" });
      await settle();
      expect(child.posted.at(-1)).toEqual({ type: "secret", id: 1, state: "unavailable" });
    }
    expect(secrets.calls).toEqual([]);
  });

  it.each([
    ["an invalid name", { type: "secret-request", id: 1, name: "Bad Name!", mode: "read" }],
    ["an extra field", { type: "secret-request", id: 1, name: KEY_NAME, mode: "read", extra: 1 }],
    ["no ID", { type: "secret-request", name: KEY_NAME, mode: "read" }],
    ["no mode", { type: "secret-request", id: 1, name: KEY_NAME }],
  ])("ignores a request with %s", async (_name, request) => {
    const child = fakeChild();
    const secrets = store({ state: "present", value: CANARY });
    await start(child, secrets);
    const before = child.posted.length;
    child.send(request);
    await settle();
    expect(child.posted.length).toBe(before);
    expect(secrets.calls).toEqual([]);
  });
});
