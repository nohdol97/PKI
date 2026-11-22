// I02B-T01 PoC (throwaway), G17: how much does the REAL backend's resident memory move while it
// does nothing? Starts the development backend entry (`backend/src/dev.ts`, fixture connector,
// empty temporary data directory), waits for it to print its URL, then samples the process's RSS
// (`ps -o rss=`, KiB) every 250 ms. The sampling process is outside the backend, so it adds nothing.
// Usage: node g17-backend-idle.ts <scratchDir> <settleSeconds> <sampleSeconds>
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [scratch, settleArg = "10", secondsArg = "120"] = process.argv.slice(2);
if (!scratch)
  throw new Error("usage: g17-backend-idle.ts <scratchDir> [settleSeconds] [sampleSeconds]");
mkdirSync(scratch, { recursive: true });
const backendEntry = new URL("../../../backend/src/dev.ts", import.meta.url).pathname;
const child = spawn(process.execPath, [backendEntry, "--data-dir", join(scratch, "data")], {
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (c: Buffer) => (stderr += c));
const ready = await new Promise<string>((resolve, reject) => {
  child.stdout.once("data", (c: Buffer) =>
    resolve(
      c
        .toString()
        .replace(/"token":"[^"]*"/, '"token":"<redacted>"')
        .trim(),
    ),
  );
  child.once("exit", (code) => reject(new Error(`backend exited ${code}: ${stderr}`)));
});
console.log(
  `node ${process.version} ${process.platform}-${process.arch}; backend pid=${child.pid} up: ${ready}`,
);
const rssMiB = () =>
  Number(
    execFileSync("ps", ["-o", "rss=", "-p", String(child.pid)])
      .toString()
      .trim(),
  ) / 1024;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const early: number[] = [];
const t0 = performance.now();
while (performance.now() - t0 < Number(settleArg) * 1000) {
  early.push(rssMiB());
  await sleep(250);
}
console.log(
  `first ${settleArg} s after start: RSS ${(early[0] ?? NaN).toFixed(0)} -> ${(early.at(-1) ?? NaN).toFixed(0)} MiB (min ${Math.min(...early).toFixed(0)}, max ${Math.max(...early).toFixed(0)})`,
);

const samples: number[] = [];
const t1 = performance.now();
while (performance.now() - t1 < Number(secondsArg) * 1000) {
  samples.push(rssMiB());
  await sleep(250);
}
child.kill("SIGTERM");
const min = Math.min(...samples);
const max = Math.max(...samples);
let swing = 0;
const win = 20; // 5 s at 250 ms
for (let i = 0; i + win <= samples.length; i++) {
  const w = samples.slice(i, i + win);
  swing = Math.max(swing, Math.max(...w) - Math.min(...w));
}
console.log(
  `idle ${secondsArg} s: n=${samples.length} RSS min=${min.toFixed(1)} max=${max.toFixed(1)} MiB; max-min=${(max - min).toFixed(1)} MiB; largest swing in any 5 s window=${swing.toFixed(1)} MiB (rssSettleBytes default 256 MiB)`,
);
