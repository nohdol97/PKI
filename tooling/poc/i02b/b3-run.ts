/* eslint-disable pki/module-boundary -- a throwaway measurement script that reaches into the packages' sources on purpose (I02B-T01) */
// I02B-T01 PoC (throwaway), B2/B3: bundles the entries with the repository's bundler settings into
// the built app folder and starts the Electron binary on `poc-b3-main.js`.
// Usage: node b3-run.ts <fixturesDir> <xlsxFile> <full: 0|1>
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { bundle } from "../../../apps/desktop/build/bundle.ts";
import { APP_DIR } from "../../../apps/desktop/build/paths.ts";

const ELECTRON = createRequire(new URL("../../../apps/desktop/package.json", import.meta.url))(
  "electron",
) as string;
const [fixturesDir, xlsxFile, full = "0"] = process.argv.slice(2);
if (!fixturesDir || !xlsxFile) throw new Error("usage: b3-run.ts <fixturesDir> <xlsxFile> <full>");
for (const [input, out] of [
  ["tooling/poc/i02b/b3-main.ts", "poc-b3-main.js"],
  ["tooling/poc/i02b/b3-utility-entry.ts", "backend/poc-b3-entry.js"],
  ["tooling/poc/i02b/child-normalizer.ts", "backend/poc-child.js"],
  ["tooling/poc/i02b/worker-entry.ts", "backend/poc-worker.js"],
] as const) {
  const { modules } = await bundle({ input, outFile: join(APP_DIR, out), buildKind: "production" });
  console.log(`bundled ${input} -> ${out} (${modules.length} repository modules)`);
}
// a scratch copy of the Electron app with a fuse flipped can be named here (the fuse experiment)
const child = spawn(
  process.env.PKI_POC_ELECTRON ?? ELECTRON,
  [
    join(APP_DIR, "poc-b3-main.js"),
    fixturesDir,
    xlsxFile,
    full,
    `--user-data-dir=${join(APP_DIR, "..", "poc-userdata")}`,
  ],
  {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      ...(process.env.B3_ONLY ? { B3_ONLY: process.env.B3_ONLY } : {}),
    },
    stdio: "inherit",
  },
);
const code = await new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
console.log(`electron exited with code ${code}`);
process.exit(code ?? 1);
