// The isolated normalizer (I02B-R22, R23, spec "포트와 색인의 모양"): the backend's side. It queues
// jobs one at a time, keeps one normalizer host process and reuses it between jobs, keeps its own wall
// clock as the backstop of the host's, and turns everything that can happen to the host into a result.
// The Promise never rejects. A host that vanishes mid-job is `resource-exceeded` after one retry on a
// fresh host; three different files in a row that way make it normalize a fixed canary document, and
// when that dies too the host is called broken ("unavailable") until a canary passes again.
// What starts the host (`child_process.fork`, or Electron's main process on request) is the
// `HostSpawner`; nothing here knows which.
import { createHash } from "node:crypto";
import { parseFromHost, type FromHost, type HostLimitCode } from "./host-protocol.ts";
import { resolveLimits, type PartialLimits } from "./limits.ts";
import type {
  DocumentFormat,
  NormalizedDocument,
  NormalizeError,
  NormalizeErrorCode,
} from "./types.ts";

export type IsolatedErrorCode = NormalizeErrorCode | HostLimitCode;

export interface IsolatedError extends Omit<NormalizeError, "code"> {
  code: IsolatedErrorCode;
}

export type IsolatedResult =
  | { ok: true; document: NormalizedDocument }
  | {
      ok: false;
      error: IsolatedError;
      /** `resource-exceeded` because the host vanished twice without a word (I02B-R23). */
      unexplainedDeath?: true;
      /** The host is broken: the canary document did not come back. Set on every result that says so. */
      unavailable?: true;
      /** A test worker's record of when it crossed the memory limit and when the host saw it (I02B-C45). */
      diag?: { crossedAtMs: number; seenAtMs: number };
    };

/** A running host: a channel to it, its end, and the news that it is gone. */
export interface HostHandle {
  /** The host's process id when the spawner knows it (ⓐ); a diagnostic for tests, never used to decide. */
  readonly pid?: number | undefined;
  post(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  /** The host process is gone, however it ended. */
  onGone(listener: () => void): void;
  /** Ends the host (ⓐ directly, ⓑ by asking Electron's main process). */
  kill(): void;
}

export interface HostSpawner {
  spawn(): Promise<HostHandle>;
}

export interface IsolatedNormalizerOptions {
  spawner: HostSpawner;
  timeoutMs: number;
  maxHeapMb: number;
  maxExternalMemoryBytes: number;
  externalPollMs?: number;
}

export interface IsolatedNormalizer {
  normalize(
    input: { bytes: Uint8Array; name: string; format?: DocumentFormat },
    opts?: { limits?: PartialLimits; signal?: AbortSignal },
  ): Promise<IsolatedResult>;
  /** The host is broken (a canary did not come back); `normalize` answers `worker-failed` without a host. */
  unavailable(): boolean;
  /** At a pass's start: when unavailable, tries the canary once; true when the normalizer is usable. */
  recheck(): Promise<boolean>;
  close(): Promise<void>;
}

/** After `timeoutMs` the host ends itself; the backend ends it this much later (I02B-R23). */
export const BACKSTOP_MS = 2_000;
/** A host that is not up and ready (its worker has loaded the normalizer) by then is a spawn failure. */
export const STARTUP_MS = 20_000;
/** Different files in a row that died without a word before the canary is tried (I02B-R23). */
export const CANARY_AFTER = 3;
export const DEFAULT_EXTERNAL_POLL_MS = 250;

/** The fixed document the canary normalizes: a few lines of Markdown (I02B-R23). */
export const CANARY = {
  bytes: new TextEncoder().encode("# canary\n\nfixed text, a few lines\n\n- one\n- two\n"),
  name: "canary.md",
};

const MESSAGES: Record<HostLimitCode, string> = {
  "timed-out": "정규화가 제한 시간을 넘겨 끊었다",
  "resource-exceeded": "정규화가 메모리 한도를 넘겨 끊었다",
  "worker-failed": "정규화 작업자를 쓸 수 없다",
};

const fail = (code: HostLimitCode, extra: object = {}): IsolatedResult => ({
  ok: false,
  error: { code, message: MESSAGES[code] },
  ...extra,
});

interface Job {
  id: number;
  bytes: Uint8Array;
  name: string;
  format?: DocumentFormat;
  limits?: PartialLimits;
  signal?: AbortSignal;
}

type Outcome =
  | { kind: "result"; result: IsolatedResult }
  | { kind: "limit"; code: HostLimitCode; diag?: { crossedAtMs: number; seenAtMs: number } }
  | { kind: "died" }
  | { kind: "no-host" }
  | { kind: "aborted" };

interface Conn {
  handle: HostHandle;
  gone: boolean;
  /** Takes the next event of this host; one waiter at a time. */
  waiter: ((event: FromHost | "gone") => void) | undefined;
}

export function createIsolatedNormalizer(options: IsolatedNormalizerOptions): IsolatedNormalizer {
  const pollMs = options.externalPollMs ?? DEFAULT_EXTERNAL_POLL_MS;
  let conn: Conn | undefined;
  let closed = false;
  let unavailable = false;
  let nextId = 1;
  let queue: Promise<unknown> = Promise.resolve();
  /** The content fingerprints of the files that died in a row; its size is the count. */
  const deaths = new Set<string>();

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  function drop(c: Conn) {
    if (c.gone) return;
    c.gone = true;
    if (conn === c) conn = undefined;
    try {
      c.handle.kill();
    } catch {
      // already gone
    }
  }

  /** A host that is up and has said it is ready; a new one when there is none. */
  async function acquire(): Promise<Conn> {
    if (conn !== undefined && !conn.gone) return conn;
    let timer: NodeJS.Timeout | undefined;
    let late = false;
    const startup = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        late = true;
        reject(new Error("startup"));
      }, STARTUP_MS);
    });
    try {
      const spawned = options.spawner.spawn();
      // a host that comes up after the wait is ended, not kept
      spawned.then(
        (h) => {
          if (late) h.kill();
        },
        () => undefined,
      );
      const handle = await Promise.race([spawned, startup]);
      // closed while the host was starting: it is not kept
      if (closed) {
        handle.kill();
        throw new Error("closed");
      }
      const c: Conn = { handle, gone: false, waiter: undefined };
      handle.onMessage((raw) => {
        const message = parseFromHost(raw);
        if (message === undefined || c.gone) return;
        const waiting = c.waiter;
        c.waiter = undefined;
        waiting?.(message);
      });
      handle.onGone(() => {
        c.gone = true;
        if (conn === c) conn = undefined;
        const waiting = c.waiter;
        c.waiter = undefined;
        waiting?.("gone");
      });
      conn = c;
      handle.post({
        type: "init",
        maxHeapMb: options.maxHeapMb,
        maxExternalMemoryBytes: options.maxExternalMemoryBytes,
        externalPollMs: pollMs,
        timeoutMs: options.timeoutMs,
      });
      // ready, or gone, or too slow
      const ready = await Promise.race([waitFor(c, (m) => m.type === "ready"), startup]);
      if (ready === "gone") throw new Error("gone");
      return c;
    } catch (error) {
      if (conn !== undefined) drop(conn);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The next event of `c` that `wanted` accepts; "gone" when the host is. */
  function waitFor(c: Conn, wanted: (m: FromHost) => boolean): Promise<FromHost | "gone"> {
    return new Promise((resolve) => {
      if (c.gone) return resolve("gone");
      const listen = () => {
        c.waiter = (event) => {
          if (event === "gone" || wanted(event)) resolve(event);
          else listen();
        };
      };
      listen();
    });
  }

  /** One try of one job on the current host (a new one if needed). */
  async function attempt(job: Job): Promise<Outcome> {
    let c: Conn;
    try {
      c = await acquire();
    } catch {
      return { kind: "no-host" };
    }
    c.handle.post({
      type: "job",
      id: job.id,
      bytes: job.bytes,
      name: job.name,
      ...(job.format === undefined ? {} : { format: job.format }),
      ...(job.limits === undefined ? {} : { limits: job.limits }),
    });
    return new Promise<Outcome>((resolve) => {
      let onAbort: (() => void) | undefined;
      // the host's own clock is first; this one covers a host whose main thread is stuck too
      const backstop = setTimeout(
        () => finish({ kind: "limit", code: "timed-out" }, true),
        options.timeoutMs + BACKSTOP_MS,
      );
      const finish = (outcome: Outcome, end: boolean) => {
        clearTimeout(backstop);
        if (onAbort) job.signal?.removeEventListener("abort", onAbort);
        if (end) drop(c);
        resolve(outcome);
      };
      void waitFor(
        c,
        (m) =>
          m.type === "invalid" || ((m.type === "result" || m.type === "limit") && m.id === job.id),
      ).then((event) => {
        if (event === "gone") return finish(closed ? { kind: "aborted" } : { kind: "died" }, false);
        // a result that is not a NormalizeResult: the host is not to be trusted, it goes
        if (event.type === "invalid") return finish({ kind: "limit", code: "worker-failed" }, true);
        if (event.type === "result") {
          return finish({ kind: "result", result: event.result as IsolatedResult }, false);
        }
        if (event.type === "limit") {
          return finish(
            { kind: "limit", code: event.code, ...(event.diag ? { diag: event.diag } : {}) },
            true,
          );
        }
      });
      if (job.signal) {
        onAbort = () => finish({ kind: "aborted" }, true);
        if (job.signal.aborted) onAbort();
        else job.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  /** True when the canary document comes back normalized from a fresh host. */
  async function canary(): Promise<boolean> {
    if (conn !== undefined) drop(conn);
    const outcome = await attempt({ id: nextId++, ...CANARY });
    return outcome.kind === "result" && outcome.result.ok;
  }

  async function runJob(job: Job): Promise<IsolatedResult> {
    if (closed || job.signal?.aborted) return fail("worker-failed");
    if (unavailable) return fail("worker-failed", { unavailable: true });
    let outcome = await attempt(job);
    // one death without a word is not that file's fault: once more, on a fresh host
    if (outcome.kind === "died" && !closed) outcome = await attempt(job);
    switch (outcome.kind) {
      case "result":
        deaths.clear();
        return outcome.result;
      case "limit":
        deaths.clear();
        return fail(outcome.code, outcome.diag ? { diag: outcome.diag } : {});
      case "no-host":
      case "aborted":
        return fail("worker-failed");
      case "died": {
        if (closed) return fail("worker-failed");
        deaths.add(createHash("sha256").update(job.bytes).digest("hex"));
        const extra: { unexplainedDeath: true; unavailable?: true } = { unexplainedDeath: true };
        if (deaths.size >= CANARY_AFTER) {
          if (await canary()) deaths.clear();
          else {
            unavailable = true;
            extra.unavailable = true;
          }
        }
        return fail("resource-exceeded", extra);
      }
    }
  }

  return {
    normalize(input, opts = {}) {
      return enqueue(async () => {
        let limits;
        try {
          // a bad limits object is the caller's bug; the Promise still does not reject
          limits = resolveLimits(opts.limits);
        } catch {
          return fail("worker-failed");
        }
        // too large is the normalizer's own answer, given before the bytes are copied to a host
        if (input.bytes.length > limits.maxFileBytes) {
          return {
            ok: false,
            error: {
              code: "too-large",
              message: `입력이 maxFileBytes(${limits.maxFileBytes})보다 크다`,
              detail: { limit: limits.maxFileBytes },
            },
          };
        }
        try {
          return await runJob({
            id: nextId++,
            bytes: input.bytes,
            name: input.name,
            ...(input.format === undefined ? {} : { format: input.format }),
            ...(opts.limits === undefined ? {} : { limits: opts.limits }),
            ...(opts.signal === undefined ? {} : { signal: opts.signal }),
          });
        } catch {
          return fail("worker-failed");
        }
      });
    },
    unavailable: () => unavailable,
    recheck() {
      return enqueue(async () => {
        if (!unavailable || closed) return !unavailable;
        // like normalize, it does not reject: a channel that fails to send is a canary that did not come back
        if (!(await canary().catch(() => false))) return false;
        unavailable = false;
        deaths.clear();
        return true;
      });
    },
    async close() {
      closed = true;
      if (conn !== undefined) drop(conn);
      await queue;
    },
  };
}
