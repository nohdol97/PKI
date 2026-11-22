// `pnpm --filter @pki/desktop build` (V01-R20, V01-T15): the production build of the
// backend, the screens and the shell into one Electron app folder (paths.ts),
// the input R04 packages into an installer. No installer here. Steps, each
// stopping the build when it fails:
// 1. the synthetic manifest must equal a fresh build from the repository (it is
//    checked, never rewritten: "T04가 넘기는 것" 1)
// 2. the screens (Vite) into app/web
// 3. the shell's main and the backend's shell entry, bundled (bundle.ts)
// 4. the runtime packages the bundles leave external (runtime-packages.ts)
// 5. the report: the modules each bundle kept and the packages copied
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { bundle, EXTERNAL_PACKAGES, REPO_ROOT } from "./bundle.ts";
import { APP_DIR, DIST_DIR, REPORT_FILE, type BuildReport } from "./paths.ts";
import { copyRuntimePackages, planRuntimePackages } from "./runtime-packages.ts";

const DESKTOP = resolve(import.meta.dirname, "..");
/** The workspace package declaring each external, where its lookup starts. */
const DECLARED_IN: Record<(typeof EXTERNAL_PACKAGES)[number], string> = {
  "better-sqlite3": join(REPO_ROOT, "storage"),
  "@huggingface/transformers": join(REPO_ROOT, "providers"),
};

const pnpm = (...args: string[]) =>
  execFileSync("pnpm", args, { cwd: REPO_ROOT, stdio: "inherit" });

rmSync(DIST_DIR, { recursive: true, force: true });
mkdirSync(APP_DIR, { recursive: true });

pnpm("--filter", "@pki/providers", "check:synthetic-manifest");
pnpm(
  "--filter",
  "@pki/web",
  "exec",
  "vite",
  "build",
  "--outDir",
  join(APP_DIR, "web"),
  "--emptyOutDir",
);

const bundles: BuildReport["bundles"] = {};
for (const [input, output] of [
  ["apps/desktop/src/main.ts", "main.js"],
  ["backend/src/shell.ts", "backend/shell.js"],
] as const) {
  bundles[output] = (
    await bundle({ input, outFile: join(APP_DIR, output), buildKind: "production" })
  ).modules;
}
cpSync(join(DESKTOP, "src", "preload.cjs"), join(APP_DIR, "preload.cjs"));

const desktop = JSON.parse(readFileSync(join(DESKTOP, "package.json"), "utf8"));
const product = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
writeFileSync(
  join(APP_DIR, "package.json"),
  `${JSON.stringify(
    {
      // Electron names userData after this: "pki" would be the canonical data folder
      // "PKI" itself on a case-insensitive macOS volume (V01-T15 1)
      name: "pki-desktop",
      private: true,
      type: "module",
      license: product.license,
      main: "main.js",
      // Electron's version, for the packager (R04); nothing is installed from here
      devDependencies: { electron: desktop.devDependencies.electron },
    },
    null,
    2,
  )}\n`,
);

const plan = planRuntimePackages(
  EXTERNAL_PACKAGES.map((name) => ({ name, from: DECLARED_IN[name] })),
  join(APP_DIR, "node_modules"),
);
copyRuntimePackages(plan);

const report: BuildReport = {
  bundles,
  packages: plan.map((p) => ({
    name: p.name,
    version: p.version,
    license: p.license,
    path: relative(APP_DIR, p.dest).split("\\").join("/"),
  })),
};
writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(
  `built ${relative(REPO_ROOT, APP_DIR)}: ${Object.keys(bundles).join(", ")}, web/, ${plan.length} runtime packages\n`,
);
