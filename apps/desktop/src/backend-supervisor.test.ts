// V01-T16: the shell restarts a backend that exits by itself, a bounded number of
// times, with the run's token, and forwards only to the backend that is running now
// (each start binds its own port). A quit stops whatever is running or starting and
// starts nothing more.
import { describe, expect, it } from "vitest";
import type { Backend } from "./backend-process.ts";
import { superviseBackend } from "./backend-supervisor.ts";

interface FakeBackend extends Backend {
  crash(): void;
  stopped: boolean;
}

function fakeStarts(options: { fail?: (n: number) => boolean } = {}) {
  const started: FakeBackend[] = [];
  const tokens: string[] = [];
  let n = 0;
  const start = async (token: string): Promise<Backend> => {
    n += 1;
    tokens.push(token);
    if (options.fail?.(n)) throw new Error("backend failed to start");
    let exit: (code: number) => void = () => undefined;
    const exited = new Promise<number>((resolve) => (exit = resolve));
    const backend: FakeBackend = {
      url: `http://127.0.0.1:${4000 + n}`,
      token,
      pid: 100 + n,
      exited,
      registerLocationTicket: () => true,
      revealPath: async () => undefined,
      loginSettings: async () => undefined,
      resumed: () => undefined,
      stopped: false,
      crash: () => exit(1),
      async stop() {
        backend.stopped = true;
        exit(0);
      },
    };
    started.push(backend);
    return backend;
  };
  return { start, started, tokens };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("backend supervisor", () => {
  it("restarts a backend that exited by itself, with the same token, at its new address", async () => {
    const { start, started, tokens } = fakeStarts();
    const supervisor = await superviseBackend({ start, maxRestarts: 3 });
    expect(supervisor.url()).toBe("http://127.0.0.1:4001");
    started[0]?.crash();
    await settle();
    expect(started).toHaveLength(2);
    expect(supervisor.url()).toBe("http://127.0.0.1:4002");
    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]).toBe(supervisor.token);
    await supervisor.stop();
  });

  it("forwards nowhere between the exit and the restarted backend's ready", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { start, started } = fakeStarts();
    const supervisor = await superviseBackend({
      start: async (token) => {
        if (started.length === 1) await gate;
        return start(token);
      },
      maxRestarts: 3,
    });
    started[0]?.crash();
    await settle();
    expect(supervisor.url()).toBeUndefined();
    release();
    await expect.poll(() => supervisor.url()).toBe("http://127.0.0.1:4002");
    await supervisor.stop();
  });

  it("gives up after the limit: nothing forwards and nothing more starts", async () => {
    const { start, started } = fakeStarts();
    const gaveUp: number[] = [];
    const supervisor = await superviseBackend({
      start,
      maxRestarts: 2,
      onGiveUp: (code) => gaveUp.push(code),
    });
    for (let i = 0; i < 3; i++) {
      started[i]?.crash();
      await settle();
    }
    expect(started).toHaveLength(3);
    expect(supervisor.url()).toBeUndefined();
    expect(gaveUp).toEqual([1]);
    await supervisor.stop();
  });

  it("counts a restart that fails to start toward the limit", async () => {
    const { start, started } = fakeStarts({ fail: (n) => n === 2 });
    const supervisor = await superviseBackend({ start, maxRestarts: 2 });
    started[0]?.crash();
    await expect.poll(() => supervisor.url()).toBe("http://127.0.0.1:4003");
    started[1]?.crash();
    await settle();
    expect(supervisor.url()).toBeUndefined();
    await supervisor.stop();
  });

  it("does not restart a backend the quit stopped", async () => {
    const { start, started } = fakeStarts();
    const supervisor = await superviseBackend({ start, maxRestarts: 3 });
    await supervisor.stop();
    await settle();
    expect(started).toHaveLength(1);
    expect(started[0]?.stopped).toBe(true);
    expect(supervisor.url()).toBeUndefined();
  });

  it("stops a backend whose restart was still starting when the quit came", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { start, started } = fakeStarts();
    const supervisor = await superviseBackend({
      start: async (token) => {
        if (started.length === 1) await gate;
        return start(token);
      },
      maxRestarts: 3,
    });
    started[0]?.crash();
    await settle();
    const stopping = supervisor.stop();
    release();
    await stopping;
    expect(started).toHaveLength(2);
    expect(started[1]?.stopped).toBe(true);
    expect(supervisor.url()).toBeUndefined();
  });

  it("rejects when the first start fails: the shell reports it and exits", async () => {
    const { start } = fakeStarts({ fail: () => true });
    await expect(superviseBackend({ start, maxRestarts: 3 })).rejects.toThrow(
      "backend failed to start",
    );
  });
});
