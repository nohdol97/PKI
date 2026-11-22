// The backend's side of the isolated normalizer (I02B-R22, R23) against a scripted host: result mapping,
// the one retry after a death without a word, the canary and the "unavailable" state (I02B-C51), the
// backstop clock (I02B-C16), and that nothing but bytes, a name and a format goes to the host (I02B-C18).
// The real host process is in host.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKSTOP_MS,
  CANARY,
  createIsolatedNormalizer,
  STARTUP_MS,
  type HostHandle,
  type HostSpawner,
} from "./isolated.ts";
import { normalizeDocument } from "./normalize.ts";

type Reply = (job: { id: number; name: string }) => unknown;

class FakeHost implements HostHandle {
  readonly posted: Record<string, unknown>[] = [];
  killed = false;
  private message: ((m: unknown) => void) | undefined;
  private gone: (() => void)[] = [];
  private readonly reply: Reply | undefined;
  private readonly ready: boolean;
  /** `reply` answers a job: a message, `"die"` to vanish, or nothing (silence). `ready`: says so after init. */
  constructor(reply: Reply | undefined, ready = true) {
    this.reply = reply;
    this.ready = ready;
  }
  post(message: unknown) {
    const m = message as Record<string, unknown>;
    this.posted.push(m);
    if (m.type === "init" && this.ready) queueMicrotask(() => this.message?.(readyMessage));
    if (m.type === "job" && this.reply) {
      const answer = this.reply(m as { id: number; name: string });
      queueMicrotask(() => (answer === "die" ? this.die() : this.message?.(answer)));
    }
  }
  onMessage(l: (m: unknown) => void) {
    this.message = l;
  }
  /** The host says something, as if it had sent it. */
  emit(message: unknown) {
    this.message?.(message);
  }
  onGone(l: () => void) {
    this.gone.push(l);
  }
  kill() {
    this.killed = true;
    queueMicrotask(() => this.die());
  }
  die() {
    for (const l of this.gone.splice(0)) l();
  }
  jobs() {
    return this.posted.filter((m) => m.type === "job");
  }
}

const readyMessage = { type: "ready", processType: null, parentKind: "node-ipc" };
const OK_RESULT = (id: number) => ({
  type: "result",
  id,
  result: {
    ok: true,
    document: { format: "markdown", text: "x", blocks: [], metadata: {}, limitations: [] },
  },
});
const ok: Reply = (job) => OK_RESULT(job.id);

/** A spawner whose hosts are made by `make(n)`, n counting from 1. */
function spawnerOf(make: (n: number) => FakeHost) {
  const hosts: FakeHost[] = [];
  const spawner: HostSpawner = {
    spawn: async () => {
      const host = make(hosts.length + 1);
      hosts.push(host);
      return host;
    },
  };
  return { spawner, hosts };
}

const LIMITS = { timeoutMs: 1_000, maxHeapMb: 256, maxExternalMemoryBytes: 1024 ** 3 };
const file = (n: number) => ({ bytes: new Uint8Array([n, n + 1, n + 2]), name: `f${n}.md` });

afterEach(() => vi.useRealTimers());

describe("results and reuse", () => {
  it("returns the host's result and keeps one host for the next jobs", async () => {
    const { spawner, hosts } = spawnerOf(() => new FakeHost(ok));
    const n = createIsolatedNormalizer({ spawner, ...LIMITS });
    expect((await n.normalize(file(1))).ok).toBe(true);
    expect((await n.normalize(file(2))).ok).toBe(true);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.jobs()).toHaveLength(2);
  });

  it("hands the host its limits once, then jobs that carry bytes, a name and a format only (I02B-C18)", async () => {
    const { spawner, hosts } = spawnerOf(() => new FakeHost(ok));
    const n = createIsolatedNormalizer({ spawner, ...LIMITS, externalPollMs: 50 });
    await n.normalize({ ...file(1), format: "markdown" }, { limits: { pdf: { maxPages: 5 } } });
    expect(hosts[0]?.posted[0]).toEqual({
      type: "init",
      maxHeapMb: 256,
      maxExternalMemoryBytes: 1024 ** 3,
      externalPollMs: 50,
      timeoutMs: 1_000,
    });
    const job = hosts[0]?.jobs()[0] ?? {};
    expect(Object.keys(job).sort()).toEqual(["bytes", "format", "id", "limits", "name", "type"]);
    // no value in it names a file: the name is the caller's string, the rest is bytes and numbers
    expect(JSON.stringify(job, (_k, v) => (v instanceof Uint8Array ? "bytes" : v))).not.toMatch(
      /path|\//,
    );
  });

  it("runs one job at a time, in order: the second is sent only after the first is answered", async () => {
    const { spawner, hosts } = spawnerOf(() => new FakeHost(undefined));
    const n = createIsolatedNormalizer({ spawner, ...LIMITS });
    const first = n.normalize(file(1));
    const second = n.normalize(file(2));
    await vi.waitFor(() => expect(hosts[0]?.jobs()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(hosts[0]?.jobs()).toHaveLength(1);
    hosts[0]?.emit(OK_RESULT(1));
    await first;
    await vi.waitFor(() => expect(hosts[0]?.jobs()).toHaveLength(2));
    hosts[0]?.emit(OK_RESULT(2));
    expect((await second).ok).toBe(true);
    expect(hosts[0]?.jobs().map((j) => j.id)).toEqual([1, 2]);
  });

  it("never rejects: a bad limits object, an aborted signal and a closed normalizer are results", async () => {
    const { spawner, hosts } = spawnerOf(() => new FakeHost(ok));
    const n = createIsolatedNormalizer({ spawner, ...LIMITS });
    const bad = await n.normalize(file(1), { limits: { pdf: { maxPages: -1 } } });
    expect(bad).toMatchObject({ ok: false, error: { code: "worker-failed" } });
    const aborted = await n.normalize(file(1), { signal: AbortSignal.abort() });
    expect(aborted).toMatchObject({ ok: false, error: { code: "worker-failed" } });
    expect(hosts).toHaveLength(0);
    await n.close();
    expect(await n.normalize(file(1))).toMatchObject({
      ok: false,
      error: { code: "worker-failed" },
    });
  });

  it("an abort in flight ends the host and answers worker-failed", async () => {
    const { spawner, hosts } = spawnerOf(() => new FakeHost(undefined));
    const n = createIsolatedNormalizer({ spawner, ...LIMITS });
    const controller = new AbortController();
    const running = n.normalize(file(1), { signal: controller.signal });
    await vi.waitFor(() => expect(hosts[0]?.jobs()).toHaveLength(1));
    controller.abort();
    expect(await running).toMatchObject({ ok: false, error: { code: "worker-failed" } });
    expect(hosts[0]?.killed).toBe(true);
  });

  it("close ends the host and answers the queued jobs worker-failed", async () => {
    const { spawner, hosts } = spawnerOf(() => new FakeHost(undefined));
    const n = createIsolatedNormalizer({ spawner, ...LIMITS });
    const running = n.normalize(file(1));
    const queued = n.normalize(file(2));
    await vi.waitFor(() => expect(hosts[0]?.jobs()).toHaveLength(1));
    await n.close();
    expect(await running).toMatchObject({ ok: false, error: { code: "worker-failed" } });
    expect(await queued).toMatchObject({ ok: false, error: { code: "worker-failed" } });
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.killed).toBe(true);
  });
});

describe("the host is not trusted (I02B-R23)", () => {
  it("a result that is not a NormalizeResult is worker-failed, the host is ended, the file is not retried, and nothing of it is returned", async () => {
    const { spawner, hosts } = spawnerOf(
      (n) =>
        new FakeHost(
          n === 1
            ? (job) => ({
                type: "result",
                id: job.id,
                result: {
                  ok: true,
                  document: { blocks: "not-an-array" },
                  injected: { path: "/etc/passwd" },
                },
              })
            : ok,
        ),
    );
    const n = createIsolatedNormalizer({ spawner, ...LIMITS });
    const result = await n.normalize(file(1));
    expect(result).toMatchObject({ ok: false, error: { code: "worker-failed" } });
    expect(JSON.stringify(result)).not.toContain("passwd");
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.killed).toBe(true);
    expect((await n.normalize(file(2))).ok).toBe(true);
    expect(hosts).toHaveLength(2);
  });
});

describe("the size limit comes first (I02B-R22)", () => {
  it("a file over maxFileBytes is too-large without a host: nothing is spawned or copied", async () => {
    const { spawner, hosts } = spawnerOf(() => new FakeHost(ok));
    const n = createIsolatedNormalizer({ spawner, ...LIMITS });
    const result = await n.normalize(
      { bytes: new Uint8Array(10), name: "big.md" },
      { limits: { maxFileBytes: 9 } },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "too-large", detail: { limit: 9 } } });
    expect(hosts).toHaveLength(0);
    // at the limit it is a job
    expect(
      (
        await n.normalize(
          { bytes: new Uint8Array(9), name: "ok.md" },
          { limits: { maxFileBytes: 9 } },
        )
      ).ok,
    ).toBe(true);
  });
});

describe("close and recheck", () => {
  it("close while the host is still starting ends it: the job does not run and answers worker-failed", async () => {
    let late: FakeHost | undefined;
    const spawner: HostSpawner = {
      spawn: () =>
        new Promise((resolve) => setTimeout(() => resolve((late = new FakeHost(ok))), 50)),
    };
    const n = createIsolatedNormalizer({ spawner, ...LIMITS });
    const running = n.normalize(file(1));
    await new Promise((r) => setTimeout(r, 10));
    await n.close();
    expect(await running).toMatchObject({ ok: false, error: { code: "worker-failed" } });
    expect(late?.killed).toBe(true);
    expect(late?.jobs()).toHaveLength(0);
    // and it was ended before it was told anything
    expect(late?.posted).toEqual([]);
  });

  it("close while the host is up but not yet ready ends it too", async () => {
    const { spawner, hosts } = spawnerOf(() => new FakeHost(ok, false));
    const n = createIsolatedNormalizer({ spawner, ...LIMITS });
    const running = n.normalize(file(1));
    await vi.waitFor(() => expect(hosts).toHaveLength(1));
    await n.close();
    expect(await running).toMatchObject({ ok: false, error: { code: "worker-failed" } });
    expect(hosts[0]?.killed).toBe(true);
  });

  it("recheck does not reject when the channel fails to send: the canary did not come back", async () => {
    let broken = false;
    const { spawner } = spawnerOf(() => {
      const host = new FakeHost(() => "die");
      const post = host.post.bind(host);
      host.post = (message: unknown) => {
        if (broken && (message as { type?: string }).type === "job")
          throw new Error("ERR_IPC_CHANNEL_CLOSED");
        post(message);
      };
      return host;
    });
    const n = createIsolatedNormalizer({ spawner, ...LIMITS });
    for (const i of [1, 2, 3]) await n.normalize(file(i));
    expect(n.unavailable()).toBe(true);
    broken = true;
    await expect(n.recheck()).resolves.toBe(false);
    expect(n.unavailable()).toBe(true);
  });
});

describe("what a host that ends a job itself tells the backend", () => {
  it.each(["timed-out", "resource-exceeded", "worker-failed"] as const)(
    "%s is the result, the host is ended, the file is not retried, the next job has a new host",
    async (code) => {
      const { spawner, hosts } = spawnerOf(
        (n) => new FakeHost(n === 1 ? (job) => ({ type: "limit", id: job.id, code }) : ok),
      );
      const n = createIsolatedNormalizer({ spawner, ...LIMITS });
      const result = await n.normalize(file(1));
      expect(result).toMatchObject({ ok: false, error: { code } });
      expect(result).not.toHaveProperty("unexplainedDeath");
      expect(hosts).toHaveLength(1);
      expect(hosts[0]?.killed).toBe(true);
      expect((await n.normalize(file(2))).ok).toBe(true);
      expect(hosts).toHaveLength(2);
    },
  );

  it("carries a test worker's record of the moment it crossed the memory limit", async () => {
    const diag = { crossedAtMs: 100, seenAtMs: 130 };
    const { spawner } = spawnerOf(
      () => new FakeHost((job) => ({ type: "limit", id: job.id, code: "resource-exceeded", diag })),
    );
    const n = createIsolatedNormalizer({ spawner, ...LIMITS });
    expect(await n.normalize(file(1))).toMatchObject({ ok: false, diag });
  });
});

describe("the backend's own clock (I02B-C16)", () => {
  beforeEach(() => vi.useFakeTimers());

  it("ends a silent host at timeoutMs + 2 s and answers timed-out, not before", async () => {
    const { spawner, hosts } = spawnerOf(() => new FakeHost(undefined));
    const n = createIsolatedNormalizer({ spawner, ...LIMITS });
    let result: unknown;
    void n.normalize(file(1)).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(LIMITS.timeoutMs + BACKSTOP_MS - 1);
    expect(result).toBeUndefined();
    expect(hosts[0]?.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toMatchObject({ ok: false, error: { code: "timed-out" } });
    expect(hosts[0]?.killed).toBe(true);
    expect(result).not.toHaveProperty("unexplainedDeath");
  });

  it("a host that is not up after the start-up time is a spawn failure, and a late host is ended", async () => {
    let lateHost: FakeHost | undefined;
    const spawner: HostSpawner = {
      spawn: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve((lateHost = new FakeHost(ok))), STARTUP_MS + 5_000);
        }),
    };
    const n = createIsolatedNormalizer({ spawner, ...LIMITS });
    let result: unknown;
    void n.normalize(file(1)).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(STARTUP_MS);
    expect(result).toMatchObject({ ok: false, error: { code: "worker-failed" } });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lateHost?.killed).toBe(true);
  });

  it("a host that never says it is ready is ended and is a spawn failure", async () => {
    const { spawner, hosts } = spawnerOf(() => new FakeHost(ok, false));
    const n = createIsolatedNormalizer({ spawner, ...LIMITS });
    let result: unknown;
    void n.normalize(file(1)).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(STARTUP_MS);
    expect(result).toMatchObject({ ok: false, error: { code: "worker-failed" } });
    expect(hosts[0]?.killed).toBe(true);
  });
});

describe("spawn failures (I02B-R23)", () => {
  it("is worker-failed, is not retried within the job, and the next job tries to spawn again", async () => {
    let tries = 0;
    const spawner: HostSpawner = {
      spawn: async () => {
        tries++;
        throw new Error("no process");
      },
    };
    const n = createIsolatedNormalizer({ spawner, ...LIMITS });
    expect(await n.normalize(file(1))).toMatchObject({
      ok: false,
      error: { code: "worker-failed" },
    });
    expect(tries).toBe(1);
    expect(await n.normalize(file(2))).toMatchObject({
      ok: false,
      error: { code: "worker-failed" },
    });
    expect(tries).toBe(2);
    // a spawn failure is not a death without a word: no canary, no "unavailable"
    expect(n.unavailable()).toBe(false);
  });
});

describe("a death without a word (I02B-C51)", () => {
  it("① the first death is retried on a fresh host and the file gets its normal result", async () => {
    const { spawner, hosts } = spawnerOf((n) => new FakeHost(n === 1 ? () => "die" : ok));
    const n = createIsolatedNormalizer({ spawner, ...LIMITS });
    const result = await n.normalize(file(1));
    expect(result.ok).toBe(true);
    expect(hosts).toHaveLength(2);
    expect(hosts[1]?.jobs()).toHaveLength(1);
  });

  it("① a second death is resource-exceeded with the mark, and the next job has a new host", async () => {
    const { spawner, hosts } = spawnerOf((n) => new FakeHost(n <= 2 ? () => "die" : ok));
    const n = createIsolatedNormalizer({ spawner, ...LIMITS });
    const result = await n.normalize(file(1));
    expect(result).toMatchObject({
      ok: false,
      error: { code: "resource-exceeded" },
      unexplainedDeath: true,
    });
    expect(hosts).toHaveLength(2);
    expect((await n.normalize(file(2))).ok).toBe(true);
    expect(hosts).toHaveLength(3);
  });

  it("① a host that reports the limit itself is not retried: one host in all", async () => {
    const { spawner, hosts } = spawnerOf(
      () => new FakeHost((job) => ({ type: "limit", id: job.id, code: "resource-exceeded" })),
    );
    const n = createIsolatedNormalizer({ spawner, ...LIMITS });
    await n.normalize(file(1));
    expect(hosts).toHaveLength(1);
  });

  const dies = (host: FakeHost) => host.jobs().map((j) => j.name);

  it("② three different files in a row: the canary is tried once on a fresh host, then unavailable; later jobs spawn nothing", async () => {
    const { spawner, hosts } = spawnerOf(() => new FakeHost(() => "die"));
    const n = createIsolatedNormalizer({ spawner, ...LIMITS });
    const results = [
      await n.normalize(file(1)),
      await n.normalize(file(2)),
      await n.normalize(file(3)),
    ];
    // each file: two hosts; the canary: one more
    expect(hosts).toHaveLength(7);
    expect(dies(hosts[6] as FakeHost)).toEqual([CANARY.name]);
    expect(results[0]).not.toHaveProperty("unavailable");
    expect(results[2]).toMatchObject({
      ok: false,
      error: { code: "resource-exceeded" },
      unexplainedDeath: true,
      unavailable: true,
    });
    expect(n.unavailable()).toBe(true);
    const fourth = await n.normalize(file(4));
    expect(fourth).toMatchObject({
      ok: false,
      error: { code: "worker-failed" },
      unavailable: true,
    });
    expect(hosts).toHaveLength(7);
  });

  /** Hosts that vanish on every job except the ones `survives` names. */
  const except = (survives: (name: string) => boolean) =>
    spawnerOf(() => new FakeHost((job) => (survives(job.name) ? OK_RESULT(job.id) : "die")));

  it("③ three files die but the canary comes back: not unavailable, the fourth file is normalized", async () => {
    const { spawner } = except((name) => name === CANARY.name || name === "fine.md");
    const n = createIsolatedNormalizer({ spawner, ...LIMITS });
    for (const i of [1, 2, 3]) await n.normalize(file(i));
    expect(n.unavailable()).toBe(false);
    expect((await n.normalize({ ...file(4), name: "fine.md" })).ok).toBe(true);
  });

  it("④ a normal result in between sets the count back to zero", async () => {
    const { spawner, hosts } = except((name) => name === "fine.md");
    const n = createIsolatedNormalizer({ spawner, ...LIMITS });
    await n.normalize(file(1));
    await n.normalize(file(2));
    await n.normalize({ ...file(3), name: "fine.md" });
    await n.normalize(file(4));
    await n.normalize(file(5));
    // four dying files, never three in a row: no canary was tried
    const canaryJobs = hosts.flatMap((h) => h.jobs()).filter((j) => j.name === CANARY.name);
    expect(canaryJobs).toHaveLength(0);
    expect(n.unavailable()).toBe(false);
  });

  it("the same file dying again is one death, not three", async () => {
    const { spawner, hosts } = spawnerOf(() => new FakeHost(() => "die"));
    const n = createIsolatedNormalizer({ spawner, ...LIMITS });
    for (let i = 0; i < 3; i++) await n.normalize(file(1));
    expect(hosts.flatMap((h) => h.jobs()).filter((j) => j.name === CANARY.name)).toHaveLength(0);
    expect(n.unavailable()).toBe(false);
  });

  it("a death, a death, a limit the host reported, a death: the limit breaks the run, no canary", async () => {
    const { spawner, hosts } = spawnerOf(
      () =>
        new FakeHost((job) =>
          job.name === "limit.md" ? { type: "limit", id: job.id, code: "timed-out" } : "die",
        ),
    );
    const n = createIsolatedNormalizer({ spawner, ...LIMITS });
    await n.normalize(file(1));
    await n.normalize(file(2));
    expect(await n.normalize({ ...file(3), name: "limit.md" })).toMatchObject({
      error: { code: "timed-out" },
    });
    await n.normalize(file(4));
    expect(hosts.flatMap((h) => h.jobs()).filter((j) => j.name === CANARY.name)).toHaveLength(0);
    expect(n.unavailable()).toBe(false);
  });

  it("⑤ after the host is fixed, recheck tries the canary, lifts the state and the next job is normalized", async () => {
    let fixed = false;
    const { spawner, hosts } = spawnerOf(
      () => new FakeHost((job) => (fixed ? OK_RESULT(job.id) : "die")),
    );
    const n = createIsolatedNormalizer({ spawner, ...LIMITS });
    for (const i of [1, 2, 3]) await n.normalize(file(i));
    expect(n.unavailable()).toBe(true);
    // still broken: the pass-start check says so and the state stays
    expect(await n.recheck()).toBe(false);
    expect(n.unavailable()).toBe(true);
    fixed = true;
    const before = hosts.length;
    expect(await n.recheck()).toBe(true);
    expect(n.unavailable()).toBe(false);
    expect(hosts.length).toBe(before + 1);
    expect(
      hosts
        .at(-1)
        ?.jobs()
        .map((j) => j.name),
    ).toEqual([CANARY.name]);
    expect((await n.normalize(file(9))).ok).toBe(true);
  });

  it("recheck on a normalizer that is fine spawns nothing", async () => {
    const { spawner, hosts } = spawnerOf(() => new FakeHost(ok));
    const n = createIsolatedNormalizer({ spawner, ...LIMITS });
    expect(await n.recheck()).toBe(true);
    expect(hosts).toHaveLength(0);
  });

  it("the canary is a few lines of Markdown that the normalizer turns into text", async () => {
    const result = await normalizeDocument({ kind: "bytes", ...CANARY });
    expect(result.ok && result.document.text.length).toBeGreaterThan(10);
  });
});
