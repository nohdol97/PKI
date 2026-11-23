// The process that plays the backend in the trigger-input repetition (I02B-C49, test code). One run is
// one process, started by `trigger-repeat.slow.ts` with a mode, and it reports over IPC what it saw:
//   isolated    the trigger XLSX through the isolated normalizer (the host is another process), then a
//               small file; reports both outcomes
//   in-process  the same XLSX in a worker thread of THIS process, no host in between (the variant
//               without the boundary: its job is to show the repetition can go red)
// Arguments: <mode> <maxHeapMb>. The parent counts how this process ended: exit code and signal.
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { createIsolatedNormalizer } from "../isolated.ts";
import { createForkSpawner } from "../spawn-node.ts";
import { makeTriggerXlsx } from "./time-bombs.ts";

const [mode, heap] = process.argv.slice(2);
const maxHeapMb = Number(heap);
const trigger = makeTriggerXlsx();
const small = new TextEncoder().encode("# small\n\nA small file.\n");

async function isolated() {
  const normalizer = createIsolatedNormalizer({
    spawner: createForkSpawner(),
    // long: on a busy machine the heap limit, not the clock, must be what ends the XLSX
    timeoutMs: 600_000,
    maxHeapMb,
    maxExternalMemoryBytes: 1_610_612_736,
  });
  const first = await normalizer.normalize({ bytes: trigger, name: "trigger.xlsx" });
  const second = await normalizer.normalize({ bytes: small, name: "small.md" });
  await normalizer.close();
  process.send?.({
    first: first.ok ? "ok" : first.error.code,
    unexplainedDeath: !first.ok && first.unexplainedDeath === true,
    second: second.ok,
  });
}

async function inProcess() {
  const worker = new Worker(fileURLToPath(new URL("../isolated-worker.ts", import.meta.url)), {
    resourceLimits: { maxOldGenerationSizeMb: maxHeapMb },
  });
  const outcome = await new Promise<string>((resolve) => {
    // the worker says `up` first; the result is the message after the job
    worker.on("message", (m: { type: string; result?: { ok: boolean } }) => {
      if (m.type === "result") resolve(m.result?.ok ? "ok" : "error");
    });
    worker.once("error", (e: Error & { code?: string }) => resolve(e.code ?? e.name));
    worker.once("exit", () => resolve("exit"));
    worker.postMessage({ type: "job", id: 1, bytes: trigger, name: "trigger.xlsx" });
  });
  process.send?.({ first: outcome });
}

await (mode === "in-process" ? inProcess() : isolated());
process.exit(0);
