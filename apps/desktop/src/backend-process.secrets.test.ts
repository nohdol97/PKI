// The shell answers the backend's secret requests over the parent channel (V01-R4,
// R13): the value goes only to that child, only when asked for a read, only for the
// names the backend may read (review B3), and never at start.
import type { SecretRead } from "@pki/contracts";
import { describe, expect, it } from "vitest";
import { startBackendProcess, type BackendChild, type ForkBackend } from "./backend-process.ts";

const CANARY = "sk-canary-process";
const KEY_NAME = `openai-compatible.api-key.${"0".repeat(32)}`;
const CONNECTOR_NAME = `connector.${"0123456789abcdef".repeat(2)}.token`;

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

function store(read: SecretRead, usable = true) {
  const calls: string[] = [];
  return {
    calls,
    available: async () => (calls.push("available"), usable),
    read: async (name: string) => (calls.push(`read ${name}`), read),
    has: async (name: string) => (
      calls.push(`has ${name}`),
      read.state === "unavailable"
        ? ({ ok: false, error: "unavailable" } as const)
        : ({ ok: true, present: read.state === "present" } as const)
    ),
    deleteOthers: async (keep: string) => (
      calls.push(`prune ${keep}`),
      read.state === "unavailable"
        ? ({ ok: false, error: "unavailable" } as const)
        : ({ ok: true } as const)
    ),
  };
}
const settle = () => new Promise((r) => setTimeout(r, 0));
const start = (
  child: ReturnType<typeof fakeChild>,
  secrets?: Parameters<typeof startBackendProcess>[0]["secrets"],
) =>
  startBackendProcess({
    fork: child.fork,
    entry: "x",
    origin: "app://pki",
    scopePolicy: undefined,
    secrets,
  });

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

  it("deletes the other keys on a prune request and answers without a value", async () => {
    for (const [read, state] of [
      [{ state: "present", value: CANARY }, "missing"],
      [{ state: "unavailable" }, "unavailable"],
    ] as const) {
      const child = fakeChild();
      const secrets = store(read);
      await start(child, secrets);
      child.send({ type: "secret-request", id: 5, name: KEY_NAME, mode: "prune" });
      await settle();
      expect(child.posted.at(-1)).toEqual({ type: "secret", id: 5, state });
      expect(secrets.calls).toEqual([`prune ${KEY_NAME}`]);
    }
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
      available: () => Promise.reject(new Error("x")),
      read: () => Promise.reject(new Error("x")),
      has: () => Promise.reject(new Error("x")),
      deleteOthers: () => Promise.reject(new Error("x")),
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

// I06-C1 ②③⑤ `backend-process.secrets` (I06-R4): the two shapes the shell answers,
// what it never answers, and what a prune may delete.
describe("backend secret requests, Connector credential names", () => {
  async function ask(
    secrets: ReturnType<typeof store> | undefined,
    name: string,
    mode: "read" | "presence" | "prune",
  ) {
    const child = fakeChild();
    await start(child, secrets);
    const before = child.posted.length;
    child.send({ type: "secret-request", id: 7, name, mode });
    await settle();
    return child.posted.length > before ? child.posted.at(-1) : "no answer";
  }
  const UNAVAILABLE = { type: "secret", id: 7, state: "unavailable" };

  it("answers a read and a presence check of a credential name from the store", async () => {
    expect(await ask(store({ state: "present", value: CANARY }), CONNECTOR_NAME, "read")).toEqual({
      type: "secret",
      id: 7,
      state: "present",
      value: CANARY,
    });
    const secrets = store({ state: "present", value: CANARY });
    expect(await ask(secrets, CONNECTOR_NAME, "presence")).toEqual({
      type: "secret",
      id: 7,
      state: "present",
    });
    expect(secrets.calls).toEqual(["available", `has ${CONNECTOR_NAME}`]);
    expect(await ask(store({ state: "missing" }), CONNECTOR_NAME, "presence")).toEqual({
      type: "secret",
      id: 7,
      state: "missing",
    });
    expect(await ask(store({ state: "missing" }), CONNECTOR_NAME, "read")).toEqual({
      type: "secret",
      id: 7,
      state: "missing",
    });
  });

  it.each([
    ["wrong prefix", `connectors.${"0".repeat(32)}.token`],
    ["uppercase slot", `connector.${"0".repeat(32)}.Token`],
    ["17-char slot", `connector.${"0".repeat(32)}.${"a".repeat(17)}`],
    ["extra dot", `connector.${"0".repeat(32)}.to.ken`],
    ["short hash", `connector.${"0".repeat(31)}.token`],
    ["path-like", "connector.../../secrets"],
    ["Provider-key-like without hash", "openai-compatible.api-key.zzzz"],
    ["unrelated", "some-other-secret"],
  ])("gives nothing for %s, in any mode, and never touches the store", async (_label, name) => {
    for (const mode of ["read", "presence", "prune"] as const) {
      const secrets = store({ state: "present", value: CANARY });
      const answer = await ask(secrets, name, mode);
      // names the request schema itself rejects get no answer at all; the rest "unavailable"
      expect([UNAVAILABLE, "no answer"], `${name} ${mode}`).toContainEqual(answer);
      expect(JSON.stringify(answer)).not.toContain(CANARY);
      expect(secrets.calls).toEqual([]);
    }
  });

  it("with the OS protection off, answers `unavailable` to a presence check even for an empty slot, `missing` for a Provider key", async () => {
    const secrets = store({ state: "missing" }, false);
    expect(await ask(secrets, CONNECTOR_NAME, "presence")).toEqual(UNAVAILABLE);
    expect(secrets.calls).toEqual(["available"]); // the store's own `has` is not consulted
    expect(await ask(store({ state: "missing" }, false), KEY_NAME, "presence")).toEqual({
      type: "secret",
      id: 7,
      state: "missing",
    });
  });

  it("with the OS protection on, an empty credential slot is `missing`; a failing check is `unavailable`", async () => {
    expect(await ask(store({ state: "missing" }, true), CONNECTOR_NAME, "presence")).toEqual({
      type: "secret",
      id: 7,
      state: "missing",
    });
    const failing = {
      ...store({ state: "missing" }),
      available: () => Promise.reject(new Error("x")),
    };
    expect(await ask(failing, CONNECTOR_NAME, "presence")).toEqual(UNAVAILABLE);
  });

  it("answers unavailable for a credential name when the shell has no store", async () => {
    for (const mode of ["read", "presence", "prune"] as const) {
      expect(await ask(undefined, CONNECTOR_NAME, mode)).toEqual(UNAVAILABLE);
    }
  });

  it("deletes nothing and answers unavailable for a prune that keeps a credential name", async () => {
    const secrets = store({ state: "present", value: CANARY });
    expect(await ask(secrets, CONNECTOR_NAME, "prune")).toEqual(UNAVAILABLE);
    expect(secrets.calls).toEqual([]);
  });

  it("still prunes for a Provider key to keep, passing only that name", async () => {
    const secrets = store({ state: "present", value: CANARY });
    expect(await ask(secrets, KEY_NAME, "prune")).toEqual({
      type: "secret",
      id: 7,
      state: "missing",
    });
    expect(secrets.calls).toEqual([`prune ${KEY_NAME}`]);
  });
});
