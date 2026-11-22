// I02B-T01 PoC (throwaway), G3: Electron main for the measurement. Bundled into the app folder
// (g3-run.ts) and started with the Electron binary. It forks `backend/poc-entry.js` with
// `utilityProcess.fork` the way apps/desktop/src/main.ts forks `backend/shell.js`, relays the
// utility process's log lines to stdout and exits when it reports done or exits.
// (No top-level await before `ready`: Electron 45 never reaches `ready` while an ES module main
// is still awaiting it; measured, see the record.)
import { app, utilityProcess } from "electron";
import { join } from "node:path";

const appDir = import.meta.dirname;
const [fixturesDir, pdfInflated = "0"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
app.dock?.hide();
void app.whenReady().then(() => {
  const child = utilityProcess.fork(join(appDir, "backend", "poc-entry.js"), [], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    serviceName: "PKI backend",
  });
  child.on("message", (m: { type: string; line?: string }) => {
    if (m.type === "log") console.log(m.line);
    if (m.type === "done") {
      child.kill();
      app.exit(0);
    }
  });
  child.once("spawn", () => child.postMessage({ fixturesDir, pdfInflated: Number(pdfInflated) }));
  child.once("exit", (code) => {
    console.log(`utility process exited with code ${code}`);
    app.exit(code === 0 ? 0 : 1);
  });
});
