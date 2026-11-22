// Test-only Electron main (V02-T11): the flow E2E starts Electron on this file in
// place of the app folder (Playwright drops NODE_OPTIONS, so a preload cannot do
// it), with the shell's usual switches. It makes every backend the shell forks run
// the test-build-only entry backend/src/v02-shell.e2e.ts, which binds the
// per-fixture Provider double and runs backend/src/shell.ts as it is, with the
// shell's arguments and environment; then it runs the shell's own main
// (src/main.ts) unchanged. Not importable from Node (it imports Electron's
// main-process API). T15 keeps this file, like the rest of e2e/, out of the build.
import { utilityProcess } from "electron";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SHELL_ENTRY = fileURLToPath(new URL("../../../backend/src/shell.ts", import.meta.url));
const DOUBLE_ENTRY = fileURLToPath(
  new URL("../../../backend/src/v02-shell.e2e.ts", import.meta.url),
);

const fork = utilityProcess.fork;
utilityProcess.fork = (modulePath, args, options) => {
  // a shell that forks anything else has changed: fail loudly, never run unbound. The
  // reason also goes to the file the E2E names (PKI_E2E_GUARD_FILE), which it reads
  // when the shell does not start (this may run before the E2E can read stderr). Then
  // the process ends at once: a throw reaches the shell's start-failure dialog, which
  // blocks the main process until clicked, and process.exit and app.exit did not end
  // it under Playwright's inspector (observed).
  if (modulePath !== SHELL_ENTRY) {
    const message = `PKI E2E: unexpected backend entry ${modulePath}; expected ${SHELL_ENTRY}`;
    process.stderr.write(`${message}\n`);
    const file = process.env.PKI_E2E_GUARD_FILE;
    if (file) appendFileSync(file, `${message}\n`);
    process.kill(process.pid, "SIGKILL");
    throw new Error(message);
  }
  return fork(DOUBLE_ENTRY, args, options);
};

await import("../src/main.ts");
