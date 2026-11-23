// The real normalizer host, started with `child_process.fork` (spawn adapter ⓐ): the limits of I02B-R23
// and the criteria I02B-C16, C19, C45. Every case goes through the host process, so a worker that runs
// away or aborts takes down the host and never this test runner (G19). Test workers stand in for the
// parser where a case needs a loop, a heap or a Buffer filler (testing/bomb-worker.ts).
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createIsolatedNormalizer,
  type HostHandle,
  type HostSpawner,
  type IsolatedNormalizer,
} from "./isolated.ts";
import { createForkSpawner } from "./spawn-node.ts";
import { generateFixtures } from "./testing/generate-fixtures.ts";
import { BOMB } from "./testing/time-bombs.ts";

// real processes: a host and its worker take seconds to load on a busy machine
vi.setConfig({ testTimeout: 90_000 });

const here = (file: string) => fileURLToPath(new URL(file, import.meta.url));
const BOMB_WORKER = here("./testing/bomb-worker.ts");
const NET_WORKER = here("./testing/net-watch-worker.ts");
const HUNG_HOST = here("./testing/hung-host.ts");
const HOST = here("./host.ts");
const TEST_HOST = here("./testing/test-host.ts");

const MARKDOWN = new TextEncoder().encode("# Title\n\nSome text.\n");
const small = { bytes: MARKDOWN, name: "small.md" };
const bomb = (name: string) => ({ bytes: new Uint8Array(), name });

const alive = (pid: number | undefined) => {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!condition() && Date.now() < end) await sleep(10);
  return condition();
};

const opened: HostHandle[] = [];
/** When each host said it was ready: the clock of a job starts there. */
const readyAt = new Map<HostHandle, number>();
const normalizers: IsolatedNormalizer[] = [];
/** Remembers every host, so a test can look at its process and none is left behind. */
function watched(inner: HostSpawner): HostSpawner {
  return {
    spawn: async () => {
      const handle = await inner.spawn();
      opened.push(handle);
      handle.onMessage((m) => {
        if ((m as { type?: string }).type === "ready") readyAt.set(handle, performance.now());
      });
      return handle;
    },
  };
}
function make(options: {
  workerFile?: string;
  hostFile?: string;
  timeoutMs?: number;
  maxHeapMb?: number;
  maxExternalMemoryBytes?: number;
  externalPollMs?: number;
}) {
  const normalizer = createIsolatedNormalizer({
    spawner: watched(
      createForkSpawner(
        options.workerFile !== undefined
          ? { hostFile: TEST_HOST, args: ["--worker", options.workerFile] }
          : options.hostFile !== undefined
            ? { hostFile: options.hostFile }
            : {},
      ),
    ),
    timeoutMs: options.timeoutMs ?? 1_000,
    maxHeapMb: options.maxHeapMb ?? 256,
    maxExternalMemoryBytes: options.maxExternalMemoryBytes ?? 1024 ** 3,
    ...(options.externalPollMs === undefined ? {} : { externalPollMs: options.externalPollMs }),
  });
  normalizers.push(normalizer);
  return normalizer;
}

afterEach(async () => {
  await Promise.all(normalizers.splice(0).map((n) => n.close()));
  for (const handle of opened.splice(0)) handle.kill();
  // no host outlives its test
  expect(await until(() => opened.every((h) => !alive(h.pid)), 5_000)).toBe(true);
});

describe("the product's worker in a real host", () => {
  it("normalizes a file and reuses the same host for the next one", async () => {
    const normalizer = make({ timeoutMs: 20_000 });
    const first = await normalizer.normalize(small);
    const second = await normalizer.normalize(small);
    expect(first.ok && first.document.text).toBe("Title\nSome text.");
    expect(second).toEqual(first);
    expect(opened).toHaveLength(1);
  });
});

describe("a loop that never yields (I02B-C16)", () => {
  it("is timed-out within 2 s by the host's own clock, with the test's timer never stalled for 500 ms, and the next file is normalized on a new host", async () => {
    const normalizer = make({ workerFile: BOMB_WORKER, timeoutMs: 1_000 });
    // a warm host: the 1 s below is the job's, not the process start
    expect((await normalizer.normalize(small)).ok).toBe(true);
    const first = opened[0];
    let last = performance.now();
    let widest = 0;
    const ticker = setInterval(() => {
      const now = performance.now();
      widest = Math.max(widest, now - last);
      last = now;
    }, 10);
    const started = performance.now();
    const result = await normalizer.normalize(bomb(BOMB.loop));
    const elapsed = performance.now() - started;
    clearInterval(ticker);
    expect(result).toMatchObject({ ok: false, error: { code: "timed-out" } });
    expect(result).not.toHaveProperty("unexplainedDeath");
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(2_000);
    expect(widest).toBeLessThan(500);
    expect(await until(() => !alive(first?.pid), 3_000)).toBe(true);
    expect((await normalizer.normalize(small)).ok).toBe(true);
    expect(opened).toHaveLength(2);
  });

  it("is ended by the backend's clock at timeoutMs + 2 s when the host's own main thread is stuck too", async () => {
    const normalizer = make({ hostFile: HUNG_HOST, timeoutMs: 1_000 });
    const result = await normalizer.normalize(small);
    const finished = performance.now();
    const elapsed = finished - (readyAt.get(opened[0] as HostHandle) ?? finished);
    expect(result).toMatchObject({ ok: false, error: { code: "timed-out" } });
    expect(elapsed).toBeGreaterThanOrEqual(2_900);
    expect(elapsed).toBeLessThan(3_500);
    expect(await until(() => !alive(opened[0]?.pid), 3_000)).toBe(true);
  });
});

describe("memory and other ends of a job (I02B-C16)", () => {
  it("a worker that fills its heap is resource-exceeded, the runner lives, the next file is normalized", async () => {
    const normalizer = make({ workerFile: BOMB_WORKER, maxHeapMb: 64, timeoutMs: 30_000 });
    const result = await normalizer.normalize(bomb(BOMB.heap));
    expect(result).toMatchObject({ ok: false, error: { code: "resource-exceeded" } });
    expect((await normalizer.normalize(small)).ok).toBe(true);
    expect(opened).toHaveLength(2);
  });

  it("a host killed from outside twice in one job is resource-exceeded with the mark; the next file has a new host", async () => {
    const normalizer = make({ workerFile: BOMB_WORKER, timeoutMs: 30_000 });
    const running = normalizer.normalize(bomb(BOMB.wait));
    for (const round of [1, 2]) {
      // the job is running once the host has said it is ready
      expect(
        await until(
          () => opened.length >= round && readyAt.has(opened[round - 1] as HostHandle),
          60_000,
        ),
      ).toBe(true);
      await sleep(300);
      process.kill(opened[round - 1]?.pid ?? 0, "SIGKILL");
    }
    const result = await running;
    expect(result).toMatchObject({
      ok: false,
      error: { code: "resource-exceeded" },
      unexplainedDeath: true,
    });
    expect(opened).toHaveLength(2);
    expect((await normalizer.normalize(small)).ok).toBe(true);
    expect(opened).toHaveLength(3);
  });

  it("a worker that ends with an error that is not about memory is worker-failed", async () => {
    const normalizer = make({ workerFile: BOMB_WORKER });
    const result = await normalizer.normalize(bomb(BOMB.error));
    expect(result).toMatchObject({ ok: false, error: { code: "worker-failed" } });
    expect(result).not.toHaveProperty("unexplainedDeath");
    expect((await normalizer.normalize(small)).ok).toBe(true);
  });

  it("the host leaves within 2 s when its channel to the backend closes", async () => {
    const child = fork(HOST, [], {
      execArgv: [],
      env: {},
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    // a host that fails this test must not outlive it
    try {
      const ready = new Promise((resolve) => child.once("message", resolve));
      child.send({
        type: "init",
        maxHeapMb: 256,
        maxExternalMemoryBytes: 1024 ** 3,
        externalPollMs: 250,
        timeoutMs: 30_000,
      });
      await ready;
      const pid = child.pid;
      child.disconnect();
      expect(await until(() => !alive(pid), 2_000)).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  });
});

describe("the memory outside the heap (I02B-C45)", () => {
  const LIMIT = 64 * 1024 ** 2;
  const POLL = 100;

  it("a worker that takes Buffers in a synchronous loop is resource-exceeded, noticed within three polls of crossing the limit, and the host is gone", async () => {
    const normalizer = make({
      workerFile: BOMB_WORKER,
      maxExternalMemoryBytes: LIMIT,
      externalPollMs: POLL,
      timeoutMs: 30_000,
    });
    // under the limit a small file is normalized
    expect((await normalizer.normalize(small)).ok).toBe(true);
    const first = opened[0];
    const result = await normalizer.normalize(bomb(BOMB.external));
    expect(result).toMatchObject({ ok: false, error: { code: "resource-exceeded" } });
    const diag = result.ok ? undefined : result.diag;
    expect(diag).toBeDefined();
    // the worker wrote the moment it crossed the limit; the host's main thread saw it by itself
    const lag = (diag?.seenAtMs ?? Infinity) - (diag?.crossedAtMs ?? 0);
    expect(lag).toBeGreaterThanOrEqual(0);
    expect(lag).toBeLessThanOrEqual(3 * POLL);
    expect(await until(() => !alive(first?.pid), 3_000)).toBe(true);
  });
});

describe("no network inside the worker (I02B-C19)", () => {
  it("every fixture goes through the host with the network watch in the worker: 0 calls, and the watch does catch a call", async () => {
    const normalizer = make({ workerFile: NET_WORKER, timeoutMs: 60_000 });
    let normalized = 0;
    for (const [name, bytes] of generateFixtures()) {
      const result = await normalizer.normalize({ bytes, name });
      // a failure result is fine for a corrupt fixture; a host-level one is not
      if (result.ok) normalized++;
      else
        expect(["timed-out", "resource-exceeded", "worker-failed"]).not.toContain(
          result.error.code,
        );
    }
    expect(normalized).toBeGreaterThan(10);
    const calls = await normalizer.normalize(bomb("net:calls"));
    expect(!calls.ok && calls.error.detail).toEqual({ calls: 0 });
    const probe = await normalizer.normalize(bomb("net:probe"));
    expect(!probe.ok && probe.error.detail).toEqual({ calls: 1 });
    // one host throughout: the count is of everything above
    expect(opened).toHaveLength(1);
  });
});
