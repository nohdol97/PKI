// Test-only Electron main (V02-T11): the flow E2E starts Electron on this file in
// place of the app folder (Playwright drops NODE_OPTIONS, so a preload cannot do
// it), with the shell's usual switches. It makes every backend the shell forks run
// the test-build-only entry backend/src/v02-shell.e2e.ts, which binds the
// per-fixture Provider double and runs backend/src/shell.ts as it is, with the
// shell's arguments and environment; then it runs the shell's own main
// (src/main.ts) unchanged. Not importable from Node (it imports Electron's
// main-process API). T15 keeps this file, like the rest of e2e/, out of the build.
import { utilityProcess } from "electron";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { backendEntry } from "../src/backend-entry.ts";

// The entry the shell forks from source is the build's choice (I05-R2): the public one, or a fork's own when
// the tree has a composition package. The double still forks the public double entry below, so v02-flow
// exercises the public double, not a fork's registration.
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SHELL_ENTRY = backendEntry(ROOT);
// the shape is read a second way, so entry selection is pinned apart from the shell's own use of it
if (
  (SHELL_ENTRY === join(ROOT, "backend/src/shell.ts")) ===
  existsSync(join(ROOT, "site/composition/package.json"))
) {
  throw new Error(`PKI E2E: backendEntry ${SHELL_ENTRY} disagrees with the shape of ${ROOT}`);
}
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
