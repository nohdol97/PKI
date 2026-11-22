// I02B-T01 PoC (throwaway), B2/B3: the stand-in backend entry (a utility process). Can it start a
// Node child at all, and if so what do the B3 measurements give from inside it?
import { spawn } from "node:child_process";
import { join } from "node:path";
import { bombs, forkSpawner, formats, memReturn, overhead, xlsxDeaths } from "./b3-child.ts";

interface ParentPort {
  postMessage(m: unknown): void;
  once(
    event: "message",
    l: (e: { data: { fixturesDir: string; xlsxFile: string; full: boolean } }) => void,
  ): void;
}
const parent = (process as unknown as { parentPort: ParentPort }).parentPort;
const log = (line: string) => parent.postMessage({ type: "log", line: `[utility] ${line}` });
const here = import.meta.dirname;
const childFile = join(here, "poc-child.js");
const workerFile = join(here, "poc-worker.js");

parent.once("message", ({ data }) => {
  void run(data)
    .catch((e: unknown) => log(`FAILED: ${String(e)}`))
    .finally(() => parent.postMessage({ type: "done" }));
});

async function run(data: { fixturesDir: string; xlsxFile: string; full: boolean }) {
  const v = process.versions as Record<string, string>;
  log(
    `process.type=${(process as unknown as { type?: string }).type} electron=${v.electron} node=${v.node} execPath=${process.execPath}`,
  );
  // 1. can this utility process start a Node child?
  const viaFork = forkSpawner(childFile, true)([]);
  const ready = await viaFork.next((m) => m.type === "ready", 15_000);
  log(
    `child_process.fork(entry, {execPath: process.execPath, env: {ELECTRON_RUN_AS_NODE: "1"}}): ${ready ? `child started and answered over IPC, versions=${JSON.stringify(ready.versions)}` : "no answer within 15 s"}`,
  );
  viaFork.kill();
  await viaFork.exited;
  const spawned = await new Promise<string>((resolve) => {
    const cp = spawn(process.execPath, [childFile], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ELECTRON_RUN_AS_NODE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    cp.stderr.on("data", (c: Buffer) => (err += c));
    cp.once("spawn", () => {
      setTimeout(() => {
        cp.kill("SIGKILL");
      }, 3000);
    });
    cp.once("error", (e) => resolve(`spawn error ${String(e)}`));
    cp.once("exit", (code, signal) =>
      resolve(
        `spawned and ran until killed at 3 s: code=${code} signal=${signal}${err ? ` stderr=${err.slice(0, 200)}` : ""}`,
      ),
    );
  });
  log(
    `child_process.spawn(process.execPath, [entry], {env: {ELECTRON_RUN_AS_NODE: "1"}}): ${spawned}`,
  );
  if (!ready) return;
  const spawner = forkSpawner(childFile, true);
  await overhead("utility>fork", spawner, data.fixturesDir, 20, log);
  await formats("utility>fork", spawner, data.fixturesDir, log);
  await xlsxDeaths("utility>fork", spawner, data.xlsxFile, 512, data.full ? 10 : 2, log);
  await bombs("utility>fork", spawner, workerFile, data.full ? 5 : 1, log);
  await memReturn("utility>fork", spawner, data.full ? 5 : 1, log);
}
