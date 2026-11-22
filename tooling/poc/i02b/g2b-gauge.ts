/* eslint-disable pki/module-boundary -- a throwaway measurement script that reaches into the packages' sources on purpose (I02B-T01) */
// I02B-T01 PoC (throwaway), G2 follow-up: the alternative gauge, the worker's own
// `external_memory` read by the PARENT with `worker.getHeapStatistics()`.
//  a  can the parent read it while the worker is stuck in a synchronous allocating loop?
//     (latency n=20) and does a worker self-report timer work then (expected: no)
//  b  detection: limit 1.5 GiB, poll 250 ms, Buffer-holding workers (busy sync loop)
//  c  false positives: peak gauge of the normalizer fixtures and the two repro inputs
//  d  blind spot: memory V8 does not account for (SQLite's malloc, WebAssembly memory)
// Usage: node g2b-gauge.ts <a|b|c|d> [reps]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { buildXlsx } from "../../../packages/document-normalize/src/testing/ooxml-builder.ts";
import { makePdfBomb, makeSlowMarkdown } from "./repro-inputs.ts";

const MiB = 1024 ** 2;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ms = (n: number) => n.toFixed(1);
const summary = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return `min=${ms(s[0] ?? NaN)} median=${ms(s[Math.floor(s.length / 2)] ?? NaN)} max=${ms(s.at(-1) ?? NaN)}`;
};
const ready = (w: Worker) => new Promise<void>((r) => w.once("message", () => r()));

/** (a) */
export async function readWhileBusy(workerFile: string | URL, n: number, log: (l: string) => void) {
  const lat: number[] = [];
  let unanswered = 0;
  for (let i = 0; i < n; i++) {
    const w = new Worker(workerFile, { workerData: { mode: "mem-sync", capMiB: 2048 } });
    await ready(w);
    await sleep(1200); // the loop is allocating, then spinning at the cap
    const t0 = performance.now();
    const answer = await Promise.race([
      w.getHeapStatistics().then((h) => h.external_memory),
      sleep(5000).then(() => -1),
    ]);
    if (answer < 0) unanswered++;
    else lat.push(performance.now() - t0);
    if (i === 0) log(`  first read: external_memory=${(answer / MiB).toFixed(0)} MiB`);
    await w.terminate();
  }
  log(
    `(a) parent getHeapStatistics() on a busy allocating/spinning worker: answered ${lat.length}/${n}, unanswered(5 s)=${unanswered}; latency ms ${lat.length ? summary(lat) : "-"}`,
  );
  // the worker's own timer
  const w = new Worker(workerFile, { workerData: { mode: "self-report", capMiB: 1024 } });
  let selfMessages = 0;
  w.on("message", (m: { type: string }) => m.type === "self" && selfMessages++);
  await sleep(3000);
  await w.terminate();
  log(
    `(a) worker self-report timer (every 50 ms) while busy in the sync loop: ${selfMessages} messages in 3000 ms`,
  );
}

/** (b) */
export async function detection(workerFile: string | URL, n: number, log: (l: string) => void) {
  const limit = 1536 * MiB;
  const caught: number[] = [];
  const times: number[] = [];
  const held: number[] = [];
  let polls = 0;
  for (let i = 0; i < n; i++) {
    const w = new Worker(workerFile, {
      workerData: { mode: "mem-sync", capMiB: 3072 },
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    await ready(w);
    const t0 = performance.now();
    let at = -1;
    let ext = 0;
    for (let p = 1; p <= 40; p++) {
      await sleep(250);
      ext = (await w.getHeapStatistics()).external_memory;
      if (ext > limit) {
        at = performance.now() - t0;
        polls = p;
        break;
      }
    }
    const tt0 = performance.now();
    await w.terminate();
    if (at >= 0) {
      caught.push(1);
      times.push(at);
      held.push(ext);
    }
    void tt0;
  }
  log(
    `(b) external_memory > 1536 MiB, poll 250 ms, sync Buffer-holding worker (cap 3072 MiB): caught ${caught.length}/${n}; time-to-catch ms ${times.length ? summary(times) : "-"}; external_memory at catch MiB ${held.length ? summary(held.map((h) => h / MiB)) : "-"} (last polls=${polls})`,
  );
}

/** (c) peak of external_memory and of external_memory + used heap while a worker runs `data` */
async function peakOf(workerFile: string | URL, data: object, maxMs: number) {
  const w = new Worker(workerFile, {
    workerData: data,
    resourceLimits: { maxOldGenerationSizeMb: 512 },
  });
  let done = false;
  w.on("message", (m: { type: string }) => m.type === "result" && (done = true));
  w.once("error", () => (done = true));
  await ready(w);
  let peakExt = 0;
  let peakSum = 0;
  const t0 = performance.now();
  while (!done && performance.now() - t0 < maxMs) {
    try {
      const h = await w.getHeapStatistics();
      peakExt = Math.max(peakExt, h.external_memory);
      peakSum = Math.max(peakSum, h.external_memory + h.used_heap_size);
    } catch {
      break;
    }
    await sleep(2);
  }
  const finished = done;
  await w.terminate();
  return { peakExt, peakSum, finished, s: (performance.now() - t0) / 1000 };
}

export async function falsePositives(
  workerFile: string | URL,
  fixturesDir: string,
  log: (l: string) => void,
) {
  const files = readdirSync(fixturesDir)
    .filter((f) => f.startsWith("normal-"))
    .sort();
  for (const f of files) {
    const bytes = new Uint8Array(readFileSync(join(fixturesDir, f)));
    const r = await peakOf(workerFile, { mode: "normalize", bytes, name: f }, 20_000);
    log(
      `(c) ${f}: peak external_memory=${(r.peakExt / MiB).toFixed(1)} MiB, external+heap=${(r.peakSum / MiB).toFixed(1)} MiB, finished=${r.finished}`,
    );
  }
  const md = await peakOf(
    workerFile,
    { mode: "normalize", bytes: makeSlowMarkdown(), name: "x.md" },
    60_000,
  );
  log(
    `(c) repro Markdown 24 KB: peak external_memory=${(md.peakExt / MiB).toFixed(1)} MiB, external+heap=${(md.peakSum / MiB).toFixed(1)} MiB, finished=${md.finished} in ${md.s.toFixed(1)} s`,
  );
  const small = await makePdfBomb(128 * MiB);
  const p1 = await peakOf(workerFile, { mode: "normalize", bytes: small, name: "x.pdf" }, 120_000);
  log(
    `(c) repro PDF scaled to 128 MiB inflated: peak external_memory=${(p1.peakExt / MiB).toFixed(1)} MiB, external+heap=${(p1.peakSum / MiB).toFixed(1)} MiB, finished=${p1.finished} in ${p1.s.toFixed(1)} s`,
  );
  const big = await makePdfBomb(3 * 1024 ** 3);
  const p2 = await peakOf(workerFile, { mode: "normalize", bytes: big, name: "x.pdf" }, 90_000);
  log(
    `(c) repro PDF 3 GiB inflated (first 90 s only): peak external_memory=${(p2.peakExt / MiB).toFixed(1)} MiB, external+heap=${(p2.peakSum / MiB).toFixed(1)} MiB, finished=${p2.finished} after ${p2.s.toFixed(1)} s`,
  );
}

/** (c) the case I02-A measured at 1.04 GiB peak RSS: a large XLSX of four big sheets */
export async function bigXlsx(
  workerFile: string | URL,
  rowsPerSheet: number,
  log: (l: string) => void,
) {
  const row = (r: number) => Array.from({ length: 40 }, (_, c) => r * 40 + c);
  const sheets = Array.from({ length: 4 }, (_, i) => ({
    name: `S${i + 1}`,
    rows: Array.from({ length: rowsPerSheet }, (_, r) => row(r)),
  }));
  const bytes = buildXlsx({ sheets });
  const r = await peakOf(workerFile, { mode: "normalize", bytes, name: "big.xlsx" }, 300_000);
  log(
    `(c) large XLSX (4 sheets x ${rowsPerSheet} rows x 40 columns, ${(bytes.length / MiB).toFixed(1)} MiB file): peak external_memory=${(r.peakExt / MiB).toFixed(1)} MiB, external+heap=${(r.peakSum / MiB).toFixed(1)} MiB, finished=${r.finished} in ${r.s.toFixed(1)} s`,
  );
}

/** (d) */
export async function blindSpot(workerFile: string | URL, log: (l: string) => void) {
  for (const [mode, label, capMiB] of [
    ["mem-sync", "Buffers (accounted)", 1024],
    ["native-wasm", "WebAssembly.Memory", 1024],
    ["native-sqlite", "node:sqlite :memory: randomblob rows", 1024],
  ] as const) {
    await sleep(500);
    const rssBefore = process.memoryUsage.rss();
    const w = new Worker(workerFile, { workerData: { mode, capMiB, stepMiB: 64, stepMs: 5 } });
    let held = 0;
    w.on(
      "message",
      (m: { type: string; mib?: number }) => m.type === "grew" && (held = m.mib ?? held),
    );
    await sleep(6000);
    const h = await w.getHeapStatistics();
    const rss = process.memoryUsage.rss() - rssBefore;
    await w.terminate();
    log(
      `(d) ${label}: worker holds ~${held} MiB; gauge external_memory=${(h.external_memory / MiB).toFixed(0)} MiB, malloced_memory=${(h.malloced_memory / MiB).toFixed(0)} MiB, used_heap=${(h.used_heap_size / MiB).toFixed(0)} MiB; process RSS growth=${(rss / MiB).toFixed(0)} MiB`,
    );
  }
}

if (import.meta.main && import.meta.filename.endsWith("g2b-gauge.ts")) {
  const [which = "a", repsArg = "20"] = process.argv.slice(2);
  const entry = new URL("./worker-entry.ts", import.meta.url);
  const log = (l: string) => console.log(l);
  console.log(`node ${process.version} ${process.platform}-${process.arch}`);
  if (which === "a") await readWhileBusy(entry, Number(repsArg), log);
  if (which === "b") await detection(entry, Number(repsArg), log);
  if (which === "c")
    await falsePositives(
      entry,
      new URL("../../../fixtures/documents", import.meta.url).pathname,
      log,
    );
  if (which === "e") await bigXlsx(entry, Number(repsArg), log);
  if (which === "d") await blindSpot(entry, log);
}
