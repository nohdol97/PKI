/* eslint-disable pki/module-boundary -- a throwaway measurement script that reaches into the packages' sources on purpose (I02B-T01) */
// I02B-T01 PoC (throwaway), G3: stands in for the packaged backend's shell entry. It is bundled
// by the repository's own bundler settings (apps/desktop/build/bundle.ts) into the app folder's
// `backend/` next to the real `shell.js`, started by Electron's `utilityProcess.fork` exactly as
// the shell starts the backend, and from there starts a `node:worker_threads` worker from a file
// bundled beside it. It then runs the same measurements as the Node-run scripts, inside Electron.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Worker } from "node:worker_threads";
import { normalizeDocument } from "../../../packages/document-normalize/src/index.ts";
import { g1Cases } from "./g1-terminate.ts";

interface ParentPort {
  postMessage(m: unknown): void;
  once(
    event: "message",
    l: (e: { data: { fixturesDir: string; pdfInflated: number } }) => void,
  ): void;
}
const parent = (process as unknown as { parentPort: ParentPort }).parentPort;
const log = (line: string) => parent.postMessage({ type: "log", line });
const workerFile = new URL("./poc-worker.js", import.meta.url);

parent.once("message", ({ data }) => {
  void run(data).catch((error: unknown) => {
    log(`FAILED: ${String(error)}`);
    parent.postMessage({ type: "done" });
  });
});

async function run(data: { fixturesDir: string; pdfInflated: number }) {
  const v = process.versions as Record<string, string>;
  log(
    `process.type=${(process as unknown as { type?: string }).type} electron=${v.electron} node=${v.node} chrome=${v.chrome} v8=${v.v8}`,
  );
  log(`entry=${import.meta.url} workerFile=${workerFile.href}`);

  // 1. the worker file loads and normalizes one file of each format; same result as in-thread
  const files = [
    "normal-markdown.md",
    "normal-text-utf8.txt",
    "normal-html.html",
    "normal-csv.csv",
    "normal-json.json",
    "normal-docx.docx",
    "normal-xlsx.xlsx",
    "normal-pdf.pdf",
  ];
  for (const f of files) {
    const bytes = new Uint8Array(readFileSync(join(data.fixturesDir, f)));
    const inThread = await normalizeDocument({ kind: "bytes", bytes, name: f });
    const t0 = performance.now();
    const viaWorker = await new Promise<{ ok: boolean; detail: Record<string, unknown> } | string>(
      (resolve) => {
        const w = new Worker(workerFile, {
          workerData: { mode: "normalize", bytes, name: basename(f) },
        });
        w.on("message", (m: { type: string; ok?: boolean; detail?: Record<string, unknown> }) => {
          if (m.type === "result") resolve({ ok: m.ok === true, detail: m.detail ?? {} });
        });
        w.once("error", (e) => resolve(`worker error: ${String(e)}`));
        w.once("exit", (c) => resolve(`worker exit ${c} before a result`));
      },
    );
    const expected = inThread.ok
      ? { format: inThread.document.format, textChars: inThread.document.text.length }
      : { code: inThread.error.code };
    const got = typeof viaWorker === "string" ? viaWorker : viaWorker.detail;
    log(
      `normalize ${f}: via worker=${JSON.stringify(got)} in-thread=${JSON.stringify(expected)} same=${JSON.stringify(got) === JSON.stringify(expected)} (${(performance.now() - t0).toFixed(0)} ms)`,
    );
  }

  // 2. G1 inside the utility process
  await g1Cases(
    workerFile,
    { loop: 10, md: 5, pdf: data.pdfInflated > 0 ? 3 : 0 },
    data.pdfInflated,
    log,
  );

  // 3. one buffer-holding worker watched by RSS and by the worker's own gauge (G2 inside Electron)
  const MiB = 1024 ** 2;
  const rss = () => process.memoryUsage().rss;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await sleep(500);
  const before = rss();
  const w = new Worker(workerFile, {
    workerData: { mode: "mem-buffer", stepMiB: 16, stepMs: 20, fill: "random" },
    resourceLimits: { maxOldGenerationSizeMb: 128 },
  });
  let held = 0;
  w.on("message", (m: { type: string; mib?: number }) => {
    if (m.type === "grew") held = m.mib ?? held;
  });
  let rssFired = "never";
  let extFired = "never";
  const t0 = performance.now();
  while (held < 2560) {
    await sleep(250);
    const grown = rss() - before;
    const hs = await w.getHeapStatistics();
    if (rssFired === "never" && grown > 1536 * MiB)
      rssFired = `${(performance.now() - t0).toFixed(0)} ms`;
    if (extFired === "never" && hs.external_memory + hs.used_heap_size > 1536 * MiB)
      extFired = `${(performance.now() - t0).toFixed(0)} ms`;
    if (rssFired !== "never") break;
  }
  const grownEnd = rss() - before;
  await w.terminate();
  log(
    `mem-buffer in utility process: worker held ${held} MiB; RSS growth at stop ${(grownEnd / MiB).toFixed(0)} MiB; RSS watchdog (1536 MiB) fired: ${rssFired}; external_memory gauge over 1536 MiB: ${extFired}`,
  );

  parent.postMessage({ type: "done" });
}
