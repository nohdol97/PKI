// The backend's requests for its normalizer host reach the shell's broker, and nothing else does
// (I02B-R22, I02B-C50): a request is a type and a number, any other shape is dropped, and the host goes
// when the backend exits.
import { describe, expect, it } from "vitest";
import { startBackendProcess, type BackendChild } from "./backend-process.ts";
import type { NormalizerHostBroker } from "./normalizer-host.ts";

function setup() {
  const calls: string[] = [];
  let send: (message: unknown) => void = () => undefined;
  let exit: (code: number) => void = () => undefined;
  const posted: { message: unknown; transfer: readonly unknown[] | undefined }[] = [];
  const child: BackendChild = {
    pid: 1,
    postMessage(message, transfer) {
      posted.push({ message, transfer });
      if ((message as { type?: string }).type === "start") {
        queueMicrotask(() => send({ type: "ready", port: 4000 }));
      }
    },
    on: (_event, listener) => void (send = listener),
    once: (_event, listener) => void (exit = listener),
    kill: () => true,
  };
  const broker: NormalizerHostBroker = {
    start: (id) => void calls.push(`start ${id}`),
    end: (id) => void calls.push(`end ${id}`),
    stop: () => void calls.push("stop"),
  };
  const given: BackendChild[] = [];
  const running = startBackendProcess({
    fork: () => child,
    entry: "backend/shell.js",
    origin: "app://pki",
    scopePolicy: undefined,
    normalizerHost: (backend) => (given.push(backend), broker),
  });
  return {
    running,
    calls,
    send: (m: unknown) => send(m),
    exit: (c: number) => exit(c),
    given,
    child,
    posted,
  };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the normalizer host requests on the backend channel", () => {
  it("gives the broker the backend's own channel and routes a start and an end to it", async () => {
    const t = setup();
    const backend = await t.running;
    expect(t.given).toEqual([t.child]);
    t.send({ type: "normalizer-host-start", id: 4 });
    t.send({ type: "normalizer-host-end", id: 4 });
    expect(t.calls).toEqual(["start 4", "end 4"]);
    expect(backend.url).toContain("4000");
  });

  it.each([
    { type: "normalizer-host-start" },
    { type: "normalizer-host-start", id: 0 },
    { type: "normalizer-host-start", id: -3 },
    { type: "normalizer-host-start", id: 1.5 },
    { type: "normalizer-host-start", id: "2" },
    { type: "normalizer-host-start", id: 2, entry: "/bin/sh" },
    { type: "normalizer-host-start", id: 2, args: ["--inspect"] },
    { type: "normalizer-host-start", id: 2, env: { A: "1" } },
    { type: "normalizer-host-end", id: 2, extra: true },
    { type: "normalizer-host-gone", id: 2 },
  ])("drops %j: it starts nothing and does not stop the backend", async (message) => {
    const t = setup();
    await t.running;
    t.send(message);
    await settle();
    expect(t.calls).toEqual([]);
    expect(t.posted.some((p) => (p.message as { type?: string }).type === "stop")).toBe(false);
  });

  it("stops the broker when the backend exits", async () => {
    const t = setup();
    await t.running;
    t.exit(0);
    await settle();
    expect(t.calls).toEqual(["stop"]);
  });

  it("without a broker the requests are ignored", async () => {
    let send: (message: unknown) => void = () => undefined;
    const child: BackendChild = {
      pid: 1,
      postMessage: (message) => {
        if ((message as { type?: string }).type === "start") {
          queueMicrotask(() => send({ type: "ready", port: 4000 }));
        }
      },
      on: (_event, listener) => void (send = listener),
      once: () => undefined,
      kill: () => true,
    };
    await startBackendProcess({
      fork: () => child,
      entry: "e",
      origin: "app://pki",
      scopePolicy: undefined,
    });
    expect(() => send({ type: "normalizer-host-start", id: 1 })).not.toThrow();
  });
});
