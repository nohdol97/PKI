// I02B-T01 PoC (throwaway), B2/B3: Electron main. (1) forks the stand-in backend utility process
// that tries to start a Node child; (2) as the driver itself, forks a SECOND utility process per
// job (the "main forks a normalization utility process" shape) and runs the same measurements.
// No top-level await before `ready` (see g3-main.ts).
import { app, utilityProcess } from "electron";
import { join } from "node:path";
import {
  bombs,
  formats,
  makeHandle,
  memReturn,
  overhead,
  workerInChild,
  xlsxDeaths,
  type Spawner,
} from "./b3-child.ts";

const appDir = import.meta.dirname;
const [fixturesDir = "", xlsxFile = "", fullArg = "0"] = process.argv
  .slice(2)
  .filter((a) => !a.startsWith("--"));
const full = fullArg === "1";
const log = (l: string) => console.log(l);
app.dock?.hide();

const utilitySpawner: Spawner = (execArgv) => {
  const c = utilityProcess.fork(join(appDir, "backend", "poc-child.js"), [], {
    execArgv,
    serviceName: "PKI normalizer",
  });
  return makeHandle(
    () => c.pid,
    (m) => c.postMessage(m),
    (l) => c.on("message", (m) => l(m as Record<string, unknown>)),
    new Promise((r) => c.once("exit", (code) => r({ code, signal: null }))),
    () => void c.kill(),
  );
};

void app.whenReady().then(async () => {
  log(`electron main: ${process.versions.electron} node ${process.versions.node}`);
  await new Promise<void>((resolve) => {
    const u = utilityProcess.fork(join(appDir, "backend", "poc-b3-entry.js"), [], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      serviceName: "PKI backend",
    });
    u.on("message", (m: { type: string; line?: string }) => {
      if (m.type === "log") log(m.line ?? "");
      if (m.type === "done") {
        u.kill();
        resolve();
      }
    });
    u.once("spawn", () => u.postMessage({ fixturesDir, xlsxFile, full }));
    u.once("exit", () => resolve());
  });
  const lg = (l: string) => log(`[main] ${l}`);
  if (process.env.B3_ONLY === "wic") {
    await workerInChild(
      "main>utility",
      utilitySpawner,
      xlsxFile,
      join(appDir, "backend", "poc-worker.js"),
      512,
      10,
      lg,
    );
    app.exit(0);
    return;
  }
  const first = utilitySpawner([]);
  const ready = await first.next((m) => m.type === "ready", 15_000);
  lg(
    `main forks a second utility process (execArgv none): ${ready ? `answered over its parent port, versions=${JSON.stringify(ready.versions)}` : "no answer"}`,
  );
  first.kill();
  await first.exited;
  await overhead("main>utility", utilitySpawner, fixturesDir, 20, lg);
  await formats("main>utility", utilitySpawner, fixturesDir, lg);
  await xlsxDeaths("main>utility", utilitySpawner, xlsxFile, 512, full ? 10 : 2, lg);
  await bombs(
    "main>utility",
    utilitySpawner,
    join(appDir, "backend", "poc-worker.js"),
    full ? 5 : 1,
    lg,
  );
  await memReturn("main>utility", utilitySpawner, full ? 5 : 1, lg);
  app.exit(0);
});
