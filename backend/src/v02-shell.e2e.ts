// Test-build-only Electron backend entry (V02-T11): started on the test main
// apps/desktop/e2e/double-main.ts, the shell forks this file in place of shell.ts. It binds the per-fixture Provider double (v02-double.hook.e2e.ts), then
// runs the shell's own entry unchanged. Electron's utility process ignores
// `--import` in execArgv, hence an entry rather than a preload. T15: never shipped.
import "./v02-double.hook.e2e.ts";

await import("./shell.ts");
