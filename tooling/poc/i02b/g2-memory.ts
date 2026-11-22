// I02B-T01 PoC (throwaway), G2 + G17.
//  A. `resourceLimits.maxOldGenerationSizeMb` against a worker that fills the V8 heap (it should
//     die by itself) and against one that holds Buffers outside the heap (it should not).
//  B. The "grown resident memory" watchdog (I02B-R23): the main thread polls
//     `process.memoryUsage.rss()` every rssPollMs and ends the worker when RSS grew by more
//     than maxRssGrowthBytes over the value taken just before it started. Detection time,
//     overshoot, and how long RSS takes to come back within rssSettleBytes after the kill.
//  C. A real parser's growth: the PDF bomb (smaller than the 3 GiB one) in a worker.
//  D. G17: how much RSS moves while nothing happens (idle main thread, with and without a
//     parked worker), sampled every 250 ms.
// Usage: node g2-memory.ts <A|B|C|D> [args]
import { Worker } from "node:worker_threads";
import { makePdfBomb } from "./repro-inputs.ts";

const MiB = 1024 ** 2;
const rss = () => process.memoryUsage.rss();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const entry = new URL("./worker-entry.ts", import.meta.url);
const fmt = (b: number) => `${(b / MiB).toFixed(0)} MiB`;

async function baseline(): Promise<number> {
  await sleep(500);
  return rss();
}

async function caseA(
  mode: "mem-js" | "mem-buffer",
  limitMb: number,
  holdMs: number,
  fill: "ones" | "random" = "random",
) {
  const before = await baseline();
  const worker = new Worker(entry, {
    workerData: { mode, stepMiB: 16, stepMs: 20, fill },
    resourceLimits: { maxOldGenerationSizeMb: limitMb },
  });
  let peak = 0;
  const sampler = setInterval(() => (peak = Math.max(peak, rss() - before)), 10);
  let grewMiB = 0;
  worker.on("message", (m: { type: string; mib?: number }) => {
    if (m.type === "grew") grewMiB = m.mib ?? grewMiB;
  });
  const t0 = performance.now();
  const outcome = await Promise.race([
    new Promise<string>((r) =>
      worker.once("error", (e: Error & { code?: string }) =>
        r(`died by itself: ${e.code ?? e.name}`),
      ),
    ),
    new Promise<string>((r) => worker.once("exit", (c) => r(`exited code ${c}`))),
    sleep(holdMs).then(() => `still alive after ${holdMs} ms`),
  ]);
  const aliveMs = performance.now() - t0;
  const peakAtDecision = peak;
  await worker.terminate();
  clearInterval(sampler);
  console.log(
    `A ${mode}${mode === "mem-buffer" ? ` fill=${fill}` : ""} maxOldGenerationSizeMb=${limitMb}: ${outcome} after ${aliveMs.toFixed(0)} ms; worker-reported grown=${grewMiB} MiB; RSS growth seen=${fmt(peakAtDecision)}`,
  );
}

async function caseB(
  stepMiB: number,
  stepMs: number,
  limit: number,
  pollMs: number,
  fill: "ones" | "random",
) {
  const settleBytes = 256 * MiB;
  const safetyHeldBytes = limit + 1024 * MiB; // this experiment's own stop, not the product's
  const before = await baseline();
  const worker = new Worker(entry, {
    workerData: { mode: "mem-buffer", stepMiB, stepMs, fill },
    resourceLimits: { maxOldGenerationSizeMb: 128 },
  });
  let held = 0;
  worker.on("message", (m: { type: string; mib?: number }) => {
    if (m.type === "grew") held = (m.mib ?? 0) * MiB;
  });
  let peak = 0;
  const sampler = setInterval(() => (peak = Math.max(peak, rss() - before)), 10);
  const t0 = performance.now();
  let rssFiredAt = -1; // the I02B-R23 watchdog: RSS growth over the limit
  let rssAtFire = 0;
  let extFiredAt = -1; // an alternative gauge: the worker's own external_memory
  let stopReason: string;
  let lastRss: number;
  let lastExt: number;
  for (;;) {
    await sleep(pollMs);
    const now = performance.now() - t0;
    lastRss = rss() - before;
    const hs = await worker.getHeapStatistics();
    lastExt = hs.external_memory + hs.used_heap_size;
    if (rssFiredAt < 0 && lastRss > limit) {
      rssFiredAt = now;
      rssAtFire = lastRss;
    }
    if (extFiredAt < 0 && lastExt > limit) extFiredAt = now;
    if (rssFiredAt >= 0) {
      stopReason = "RSS watchdog fired";
      break;
    }
    if (held > safetyHeldBytes) {
      stopReason = `RSS watchdog never fired; stopped by the experiment's safety at ${fmt(held)} held`;
      break;
    }
  }
  const t1 = performance.now();
  await worker.terminate();
  const terminateMs = performance.now() - t1;
  const peakAll = peak;
  clearInterval(sampler);
  const t2 = performance.now();
  let settleMs = -1;
  let at1s = 0;
  let at5s = 0;
  while (performance.now() - t2 < 10_000) {
    const grown = rss() - before;
    const sinceMs = performance.now() - t2;
    if (sinceMs >= 1000 && at1s === 0) at1s = grown;
    if (sinceMs >= 5000 && at5s === 0) at5s = grown;
    if (settleMs < 0 && grown <= settleBytes) settleMs = sinceMs;
    if (settleMs >= 0 && sinceMs >= 5000) break;
    await sleep(25);
  }
  console.log(
    `B fill=${fill} step=${stepMiB} MiB/${stepMs} ms limit=${fmt(limit)} poll=${pollMs} ms: ${stopReason}; worker held ${fmt(held)}; ` +
      `RSS growth at last poll=${fmt(lastRss)}, true peak RSS growth=${fmt(peakAll)}; RSS-watchdog fired at ${rssFiredAt < 0 ? "never" : rssFiredAt.toFixed(0) + " ms (growth " + fmt(rssAtFire) + ")"}; ` +
      `external_memory gauge over limit at ${extFiredAt < 0 ? "never" : extFiredAt.toFixed(0) + " ms"} (last ${fmt(lastExt)}); terminate ${terminateMs.toFixed(0)} ms; ` +
      `after kill: within ${fmt(settleBytes)} of baseline after ${settleMs < 0 ? "never(10 s)" : settleMs.toFixed(0) + " ms"}, growth at 1 s=${fmt(at1s)} at 5 s=${fmt(at5s)}`,
  );
}

async function caseC(inflated: number, fill: string) {
  const bytes = await makePdfBomb(inflated, fill);
  const before = await baseline();
  const worker = new Worker(entry, {
    workerData: { mode: "normalize", bytes, name: "x.pdf" },
    resourceLimits: { maxOldGenerationSizeMb: 512 },
  });
  let peak = 0;
  const sampler = setInterval(() => (peak = Math.max(peak, rss() - before)), 10);
  const t0 = performance.now();
  const outcome = await new Promise<string>((r) => {
    worker.on(
      "message",
      (m: { type: string; ok?: boolean }) => m.type === "result" && r(`finished ok=${m.ok}`),
    );
    worker.once("error", (e: Error & { code?: string }) => r(`error ${e.code ?? e.name}`));
  });
  clearInterval(sampler);
  const s = (performance.now() - t0) / 1000;
  await worker.terminate();
  console.log(
    `C pdf-bomb inflated=${fmt(inflated)} (${bytes.length} bytes): ${outcome} in ${s.toFixed(1)} s; peak RSS growth ${fmt(peak)}`,
  );
}

async function caseD(seconds: number, withWorker: boolean) {
  const worker = withWorker ? new Worker(entry, { workerData: { mode: "idle" } }) : undefined;
  if (worker) await new Promise((r) => worker.once("message", r));
  await sleep(2000);
  const samples: number[] = [];
  const end = performance.now() + seconds * 1000;
  while (performance.now() < end) {
    samples.push(rss());
    await sleep(250);
  }
  await worker?.terminate();
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  // largest swing inside any 5 s window (rssSettleMs)
  const win = 20;
  let swing = 0;
  for (let i = 0; i + win <= samples.length; i++) {
    const w = samples.slice(i, i + win);
    swing = Math.max(swing, Math.max(...w) - Math.min(...w));
  }
  console.log(
    `D idle ${withWorker ? "with a parked worker" : "main only"}: n=${samples.length} samples over ${seconds} s; RSS min=${fmt(min)} max=${fmt(max)} max-min=${fmt(max - min)}; largest swing in any 5 s window=${fmt(swing)}`,
  );
}

const [which = "A", ...rest] = process.argv.slice(2);
console.log(
  `node ${process.version} ${process.platform}-${process.arch}; rssPollMs/limit are the spec defaults unless shown`,
);
if (which === "A") {
  for (let i = 0; i < 3; i++) await caseA("mem-js", 128, 20_000);
  for (const fill of ["random", "ones"] as const)
    for (let i = 0; i < 3; i++) await caseA("mem-buffer", 128, 3_000, fill);
} else if (which === "B") {
  const reps = Number(rest[0] ?? 3);
  for (const fill of ["random", "ones"] as const)
    for (const [step, ms] of [
      [16, 20],
      [64, 20],
    ] as const)
      for (let i = 0; i < reps; i++)
        await caseB(step, ms, Number(rest[1] ?? 1536) * MiB, 250, fill);
} else if (which === "C") {
  await caseC(Number(rest[0] ?? 134_217_728), rest[1] ?? "q Q ");
} else if (which === "D") {
  await caseD(Number(rest[0] ?? 120), false);
  await caseD(Number(rest[0] ?? 120), true);
}
