/* eslint-disable pki/module-boundary -- a throwaway measurement script that reaches into the packages' sources on purpose (I02B-T01) */
// I02B-T01 PoC (throwaway), G3: bundles the three entries with the repository's bundler settings
// into the already-built app folder (`pnpm --filter @pki/desktop build` first), then starts the
// Electron binary on `poc-main.js`.
// Usage: node g3-run.ts <fixturesDir> <pdfInflatedBytes|0>
import { spawn } from "node:child_process";
import { join } from "node:path";
import { bundle } from "../../../apps/desktop/build/bundle.ts";
import { APP_DIR } from "../../../apps/desktop/build/paths.ts";
import { createRequire } from "node:module";

// the electron package's export is the path of its binary (as apps/desktop/e2e/launch.ts reads it)
const ELECTRON = createRequire(new URL("../../../apps/desktop/package.json", import.meta.url))(
  "electron",
) as string;
const [fixturesDir, pdfInflated = "0"] = process.argv.slice(2);
if (!fixturesDir) throw new Error("usage: g3-run.ts <fixturesDir> <pdfInflated>");
for (const [input, out] of [
  ["tooling/poc/i02b/g3-main.ts", "poc-main.js"],
  ["tooling/poc/i02b/g3-backend-entry.ts", "backend/poc-entry.js"],
  ["tooling/poc/i02b/worker-entry.ts", "backend/poc-worker.js"],
] as const) {
  const { modules } = await bundle({ input, outFile: join(APP_DIR, out), buildKind: "production" });
  console.log(`bundled ${input} -> ${out} (${modules.length} repository modules)`);
}
const child = spawn(
  ELECTRON,
  [
    join(APP_DIR, "poc-main.js"),
    fixturesDir,
    pdfInflated,
    `--user-data-dir=${join(APP_DIR, "..", "poc-userdata")}`,
  ],
  {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    stdio: "inherit",
  },
);
const code = await new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
console.log(`electron exited with code ${code}`);
process.exit(code ?? 1);
