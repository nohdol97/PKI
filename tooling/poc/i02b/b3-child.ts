/* eslint-disable pki/module-boundary -- a throwaway measurement script that reaches into the packages' sources on purpose (I02B-T01) */
// I02B-T01 PoC (throwaway), B2/B3: measurements of a child that hosts the normalizer, generic over
// HOW the child is started (a Spawner), so the same code runs in plain Node, inside the Electron
// utility process (fork with ELECTRON_RUN_AS_NODE) and from Electron main (second utility process).
// Node CLI: node b3-child.ts <section> <xlsxFile> <fixturesDir> [n]
//   sections: overhead | formats | xlsx | bombs | memreturn | worker
import { execFileSync, fork } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { normalizeDocument } from "../../../packages/document-normalize/src/index.ts";

export interface Exit {
  code: number | null;
  signal: string | null;
}
export interface ChildHandle {
  readonly pid: number | undefined;
  send(m: unknown): void;
  /** the next message satisfying `pred`, or undefined at the timeout / when the child exits first */
  next(
    pred: (m: Record<string, unknown>) => boolean,
    timeoutMs: number,
  ): Promise<Record<string, unknown> | undefined>;
  exited: Promise<Exit>;
  kill(): void;
  /** the first line of the child's stderr that says FATAL (a V8 abort), if it wrote one */
  fatalLine(): string;
}
export type Spawner = (execArgv: string[]) => ChildHandle;

export function makeHandle(
  getPid: () => number | undefined,
  send: (m: unknown) => void,
  subscribe: (l: (m: Record<string, unknown>) => void) => void,
  exited: Promise<Exit>,
  kill: () => void,
  fatalLine: () => string = () => "",
): ChildHandle {
  const seen: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  subscribe((m) => {
    seen.push(m);
    waiters.splice(0).forEach((w) => w());
  });
  let done = false;
  void exited.then(() => {
    done = true;
    waiters.splice(0).forEach((w) => w());
  });
  return {
    get pid() {
      return getPid();
    },
    send,
    exited,
    kill,
    fatalLine,
    async next(pred, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const i = seen.findIndex(pred);
        if (i >= 0) return seen.splice(i, 1)[0];
        if (done || Date.now() >= deadline) return undefined;
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, Math.max(1, deadline - Date.now()));
        });
      }
    },
  };
}

/** child_process.fork of `file`; `electronAsNode` runs the Electron binary as Node (ELECTRON_RUN_AS_NODE). */
export function forkSpawner(file: string, electronAsNode: boolean): Spawner {
  return (execArgv) => {
    let fatal = "";
    const cp = fork(file, [], {
      execArgv,
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      ...(electronAsNode
        ? {
            execPath: process.execPath,
            env: {
              PATH: process.env.PATH ?? "",
              HOME: process.env.HOME ?? "",
              ELECTRON_RUN_AS_NODE: "1",
            },
          }
        : {}),
    });
    cp.stderr?.on("data", (c: Buffer) => {
      if (!fatal) fatal = /FATAL ERROR[^\n]*/.exec(c.toString())?.[0] ?? "";
    });
    return makeHandle(
      () => cp.pid,
      (m) => void cp.send(m as never),
      (l) => cp.on("message", (m) => l(m as Record<string, unknown>)),
      new Promise((r) => cp.once("exit", (code, signal) => r({ code, signal }))),
      () => void cp.kill("SIGKILL"),
      () => fatal,
    );
  };
}

const MiB = 1024 ** 2;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stat = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return `min=${(s[0] ?? NaN).toFixed(1)} median=${(s[Math.floor(s.length / 2)] ?? NaN).toFixed(1)} max=${(s.at(-1) ?? NaN).toFixed(1)}`;
};
const exitText = (e: Exit) => `code=${e.code} signal=${e.signal}`;

const FILES = [
  "normal-markdown.md",
  "normal-text-utf8.txt",
  "normal-html.html",
  "normal-csv.csv",
  "normal-json.json",
  "normal-docx.docx",
  "normal-xlsx.xlsx",
  "normal-pdf.pdf",
];
const summary = (r: Awaited<ReturnType<typeof normalizeDocument>>) =>
  r.ok ? { format: r.document.format, textChars: r.document.text.length } : { code: r.error.code };

export async function overhead(
  label: string,
  spawn: Spawner,
  fixturesDir: string,
  n: number,
  log: (l: string) => void,
) {
  const bytes = new Uint8Array(readFileSync(join(fixturesDir, "normal-markdown.md")));
  const perJob: number[] = [];
  const readyOnly: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const c = spawn([]);
    await c.next((m) => m.type === "ready", 30_000);
    readyOnly.push(performance.now() - t0);
    c.send({ type: "job", id: 1, kind: "normalize", bytes, name: "normal-markdown.md" });
    const r = await c.next((m) => m.type === "result", 30_000);
    perJob.push(performance.now() - t0);
    if (r === undefined) log(`${label}: job ${i} produced no result`);
    c.kill();
    await c.exited;
  }
  log(
    `${label} child-per-job (spawn + load normalizer + one small document): n=${n} ms ${stat(perJob)}; spawn->ready only ${stat(readyOnly)}`,
  );
  const c = spawn([]);
  const t0 = performance.now();
  await c.next((m) => m.type === "ready", 30_000);
  c.send({ type: "job", id: 0, kind: "normalize", bytes, name: "normal-markdown.md" });
  await c.next((m) => m.type === "result", 30_000);
  const first = performance.now() - t0;
  const reused: number[] = [];
  for (let i = 1; i <= n; i++) {
    const t = performance.now();
    c.send({ type: "job", id: i, kind: "normalize", bytes, name: "normal-markdown.md" });
    await c.next((m) => m.type === "result" && m.id === i, 30_000);
    reused.push(performance.now() - t);
  }
  c.kill();
  await c.exited;
  log(
    `${label} reused child: first job incl. spawn ${first.toFixed(1)} ms; then n=${n} jobs ms ${stat(reused)}`,
  );
}

export async function formats(
  label: string,
  spawn: Spawner,
  fixturesDir: string,
  log: (l: string) => void,
) {
  const c = spawn([]);
  await c.next((m) => m.type === "ready", 30_000);
  let same = 0;
  for (const [i, f] of FILES.entries()) {
    const bytes = new Uint8Array(readFileSync(join(fixturesDir, f)));
    c.send({ type: "job", id: i, kind: "normalize", bytes, name: f });
    const r = await c.next((m) => m.type === "result" && m.id === i, 30_000);
    const direct = summary(await normalizeDocument({ kind: "bytes", bytes, name: f }));
    const same1 = JSON.stringify(r?.detail) === JSON.stringify(direct);
    if (same1) same++;
    log(
      `${label} ${f}: via child=${JSON.stringify(r?.detail)} direct=${JSON.stringify(direct)} same=${same1}`,
    );
  }
  c.kill();
  await c.exited;
  log(`${label} formats identical to a direct call: ${same}/${FILES.length}`);
}

export async function xlsxDeaths(
  label: string,
  spawn: Spawner,
  xlsxFile: string,
  heapMb: number,
  n: number,
  log: (l: string) => void,
) {
  const bytes = new Uint8Array(readFileSync(xlsxFile));
  let parentAlive = 0;
  const tally: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const c = spawn([`--max-old-space-size=${heapMb}`]);
    const ready = await c.next((m) => m.type === "ready", 30_000);
    if (i === 0)
      log(
        `${label} child heap limit with --max-old-space-size=${heapMb}: ${String(ready?.heapLimitMiB)} MiB; child execArgv ${JSON.stringify(ready?.execArgv)}`,
      );
    const t0 = performance.now();
    c.send({ type: "job", id: 1, kind: "normalize", bytes, name: "big.xlsx" });
    const r = await Promise.race([c.next((m) => m.type === "result", 180_000), c.exited]);
    const gotResult = r !== undefined && (r as Record<string, unknown>).type === "result";
    const ex = await Promise.race([c.exited, sleep(2000).then(() => undefined)]);
    if (ex === undefined) c.kill();
    const e = ex ?? (await c.exited);
    parentAlive++; // this very process kept running after each child
    const key = gotResult
      ? `result ${JSON.stringify((r as Record<string, unknown>).detail)}`
      : `child died ${exitText(e)}`;
    tally[key] = (tally[key] ?? 0) + 1;
    log(
      `${label} xlsx child #${i + 1} (--max-old-space-size=${heapMb}): ${key}; exit ${exitText(e)}${c.fatalLine() ? `; stderr: ${c.fatalLine()}` : ""}; ${((performance.now() - t0) / 1000).toFixed(1)} s`,
    );
  }
  log(
    `${label} xlsx n=${n}: parent alive after ${parentAlive}/${n} children; outcomes ${JSON.stringify(tally)}`,
  );
}

/** physical footprint in MiB of a pid (macOS `footprint`: counts compressed pages RSS leaves out) */
export function footprintMiB(pid: number): number {
  try {
    const out = execFileSync("footprint", ["-p", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    const m = /Footprint:\s*([\d.]+)\s*(KB|MB|GB)/.exec(out);
    if (!m) return NaN;
    const v = Number(m[1]);
    return m[2] === "GB" ? v * 1024 : m[2] === "KB" ? v / 1024 : v;
  } catch {
    return NaN;
  }
}
const rssMiB = (pid: number) =>
  Number(
    execFileSync("ps", ["-o", "rss=", "-p", String(pid)])
      .toString()
      .trim(),
  ) / 1024;

export async function bombs(
  label: string,
  spawn: Spawner,
  workerFile: string,
  n: number,
  log: (l: string) => void,
) {
  for (const kind of ["gauged", "wall-clock"] as const) {
    const rows: string[] = [];
    const peaks: number[] = [];
    const rsses: number[] = [];
    const times: number[] = [];
    for (let i = 0; i < n; i++) {
      const c = spawn([]);
      await c.next((m) => m.type === "ready", 30_000);
      const t0 = performance.now();
      c.send(
        kind === "gauged"
          ? { type: "job", id: 1, kind: "bomb-gauged", capMiB: 2048, limitMiB: 1536, workerFile }
          : { type: "job", id: 1, kind: "bomb-main", capMiB: 2048 },
      );
      let peakFp = 0;
      let peakRss = 0;
      let killedBy = "";
      let exited = false;
      void c.exited.then(() => (exited = true));
      let report: Record<string, unknown> | undefined;
      while (!exited) {
        const pid = c.pid;
        if (pid !== undefined) {
          const fp = footprintMiB(pid);
          if (!Number.isNaN(fp)) peakFp = Math.max(peakFp, fp);
          try {
            peakRss = Math.max(peakRss, rssMiB(pid));
          } catch {
            // gone
          }
        }
        const lim = await c.next((m) => m.type === "limit", 1);
        if (lim) report = lim;
        if (kind === "wall-clock" && performance.now() - t0 > 3000) {
          killedBy = "parent wall-clock 3 s";
          c.kill();
        }
        if (performance.now() - t0 > 20_000) {
          killedBy = "parent safety 20 s";
          c.kill();
        }
      }
      const e = await c.exited;
      times.push(performance.now() - t0);
      peaks.push(peakFp);
      rsses.push(peakRss);
      rows.push(
        `#${i + 1}: ${killedBy || "child exited by itself"} ${exitText(e)} after ${((performance.now() - t0) / 1000).toFixed(1)} s; peak footprint ${peakFp.toFixed(0)} MiB, peak RSS ${peakRss.toFixed(0)} MiB${report ? `; child-reported peak external_memory ${(report.peakExternalMiB as number).toFixed(0)} MiB at ${(report.atMs as number).toFixed(0)} ms` : ""}`,
      );
    }
    for (const r of rows) log(`${label} bomb ${kind} ${r}`);
    log(
      `${label} bomb ${kind} n=${n} (cap 2048 MiB${kind === "gauged" ? ", child polls worker external_memory every 250 ms, limit 1536 MiB" : ", parent kills at 3 s"}): time ms ${stat(times)}; peak footprint MiB ${stat(peaks)}; peak RSS MiB ${stat(rsses)}`,
    );
  }
}

/** the child hosts the normalizer in a worker with a heap limit: does a fatal heap OOM stay in the child? */
export async function workerInChild(
  label: string,
  spawn: Spawner,
  xlsxFile: string,
  workerFile: string,
  heapMb: number,
  n: number,
  log: (l: string) => void,
) {
  const bytes = new Uint8Array(readFileSync(xlsxFile));
  const tally: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const c = spawn([]);
    await c.next((m) => m.type === "ready", 30_000);
    const t0 = performance.now();
    c.send({ type: "job", id: 1, kind: "normalize-in-worker", bytes, heapMb, workerFile });
    const r = await Promise.race([
      c.next((m) => m.type === "result" || m.type === "worker-error", 180_000),
      c.exited,
    ]);
    const reported =
      r !== undefined && "type" in (r as object) ? (r as Record<string, unknown>) : undefined;
    let key: string;
    if (reported) {
      key =
        reported.type === "result"
          ? `result ${JSON.stringify(reported.detail)}`
          : `worker died cleanly (${String(reported.code)}), child process alive`;
    } else {
      const e = await c.exited;
      key = `child process aborted (${exitText(e)})`;
    }
    const e2 = await Promise.race([c.exited, sleep(500).then(() => undefined)]);
    if (e2 === undefined) c.kill();
    await c.exited;
    tally[key] = (tally[key] ?? 0) + 1;
    log(
      `${label} worker-in-child #${i + 1} (worker heap ${heapMb} MiB): ${key}; ${((performance.now() - t0) / 1000).toFixed(1)} s`,
    );
  }
  log(
    `${label} worker-in-child n=${n} (worker heap ${heapMb} MiB, parent alive in all): ${JSON.stringify(tally)}`,
  );
}

const freePct = () =>
  /free percentage:\s*(\d+)%/.exec(execFileSync("memory_pressure").toString())?.[1] ?? "?";
const freePagesMiB = () => {
  const out = execFileSync("vm_stat").toString();
  const page = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 16384);
  return (Number(/Pages free:\s+(\d+)/.exec(out)?.[1] ?? 0) * page) / MiB;
};

export async function memReturn(
  label: string,
  spawn: Spawner,
  n: number,
  log: (l: string) => void,
) {
  for (let i = 0; i < n; i++) {
    await sleep(1500);
    const before = {
      rss: process.memoryUsage.rss() / MiB,
      freePct: freePct(),
      freeMiB: freePagesMiB(),
    };
    const c = spawn([]);
    await c.next((m) => m.type === "ready", 30_000);
    c.send({ type: "job", id: 1, kind: "bomb-main", capMiB: 1024 });
    await sleep(2500);
    const fp = c.pid === undefined ? NaN : footprintMiB(c.pid);
    const during = { freePct: freePct(), freeMiB: freePagesMiB() };
    c.kill();
    const e = await c.exited;
    await sleep(10_000);
    const after = {
      rss: process.memoryUsage.rss() / MiB,
      freePct: freePct(),
      freeMiB: freePagesMiB(),
    };
    log(
      `${label} memory return #${i + 1}: child footprint before kill ${fp.toFixed(0)} MiB (${exitText(e)}); system free before/during/10 s after: ${before.freeMiB.toFixed(0)}/${during.freeMiB.toFixed(0)}/${after.freeMiB.toFixed(0)} MiB (${before.freePct}%/${during.freePct}%/${after.freePct}%); parent RSS before/after ${before.rss.toFixed(0)}/${after.rss.toFixed(0)} MiB`,
    );
  }
}

/** a fresh worker per job and the cost of one small document (the comparison row) */
export async function workerCost(
  workerFile: string | URL,
  fixturesDir: string,
  n: number,
  log: (l: string) => void,
) {
  const bytes = new Uint8Array(readFileSync(join(fixturesDir, "normal-markdown.md")));
  const t: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const w = new Worker(workerFile, {
      workerData: { mode: "normalize", bytes, name: "normal-markdown.md" },
    });
    await new Promise((r) =>
      w.on("message", (m: { type: string }) => m.type === "result" && r(undefined)),
    );
    t.push(performance.now() - t0);
    await w.terminate();
  }
  log(`worker-per-job (new Worker + load normalizer + one small document): n=${n} ms ${stat(t)}`);
}

if (import.meta.main && import.meta.filename.endsWith("b3-child.ts")) {
  const [section = "overhead", xlsxFile = "", fixturesDir = "", nArg = "20"] =
    process.argv.slice(2);
  const n = Number(nArg);
  const log = (l: string) => console.log(l);
  const childFile = new URL("./child-normalizer.ts", import.meta.url).pathname;
  const workerFile = new URL("./worker-entry.ts", import.meta.url).pathname;
  const spawner = forkSpawner(childFile, false);
  console.log(
    `node ${process.version} ${process.platform}-${process.arch}; host: plain Node, child_process.fork`,
  );
  if (section === "overhead") await overhead("node-fork", spawner, fixturesDir, n, log);
  if (section === "worker") await workerCost(workerFile, fixturesDir, n, log);
  if (section === "formats") await formats("node-fork", spawner, fixturesDir, log);
  if (section === "xlsx") await xlsxDeaths("node-fork", spawner, xlsxFile, 512, n, log);
  if (section === "bombs") await bombs("node-fork", spawner, workerFile, n, log);
  if (section === "wic")
    await workerInChild("node-fork", spawner, xlsxFile, workerFile, 512, n, log);
  if (section === "memreturn") await memReturn("node-fork", spawner, n, log);
}
