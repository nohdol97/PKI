// The production build's bundler settings (V01-R20, V01-T15): rolldown, the bundler
// Vite 8 runs on, turns the shell's main and the backend's shell entry into one
// ESM file each for Node/Electron. This is the one bundler configuration besides
// the test runner's (lint `pki/gate-inputs` BUNDLER_CONFIGS): it writes the build
// kind (`import.meta.PKI_BUILD_KIND`, providers/src/build-kind.ts) as a string
// literal, and dead-code removal then drops the branches of other kinds — the
// development exception and the test build's pick (artifact.contents).
// Source-run modules are bundled as their production pairs (REPLACEMENTS), and a
// test-only module reached by the bundle fails the build (forbiddenReason), named
// by path, not only by the `*.test`/`*.e2e` file-name rule.
import { rolldown, type Plugin } from "rolldown";
import { builtinModules } from "node:module";
import { relative, resolve, sep } from "node:path";

export const REPO_ROOT = resolve(import.meta.dirname, "../../..");

/** Loaded at run time from the app folder's node_modules (runtime-packages.ts): native code. */
export const EXTERNAL_PACKAGES = ["better-sqlite3", "@huggingface/transformers"] as const;

/** Source-run module → the module bundled in its place (repository paths). */
export const REPLACEMENTS: Readonly<Record<string, string>> = {
  "apps/desktop/src/layout.ts": "apps/desktop/src/layout.production.ts",
  "backend/src/shell-options.ts": "backend/src/shell-options.production.ts",
};

/** Test-only or development-only code, refused by path (V02 spec "T10이 넘기는 것" 5). */
const FORBIDDEN_PREFIXES = ["packages/testkit/", "apps/desktop/e2e/", "apps/desktop/artifact/"];
// named as well as caught by the patterns below (V02 spec "T10이 넘기는 것" 5, T11 7):
// the seed and the test-build doubles and shell entry, the swapped configuration's
// doubles and preload (V01 spec "T17이 넘기는 것" 3), and the development entry
const FORBIDDEN_FILES = [
  "backend/src/v02-seed.e2e.ts",
  "backend/src/v02-double.e2e.ts",
  "backend/src/v02-double.hook.e2e.ts",
  "backend/src/v02-shell.e2e.ts",
  "backend/src/swap-double.e2e.ts",
  "backend/src/swap-double.hook.e2e.ts",
  "apps/desktop/e2e/double-main.ts",
  "backend/src/dev.ts",
  // the test-build-only job kind and the kill tests' backend entry (I03-R24)
  "backend/src/test-effect.ts",
  "backend/src/job-kill.child.ts",
];
const TEST_FILE = /\.(test|e2e|setup)\.[cm]?[jt]sx?$/;
/** Any `e2e/` folder: E2E code and its helpers, whatever their file names. */
const E2E_FOLDER = /(^|\/)e2e\//;
/** Reached through the composition root's static import; must not survive tree-shaking. */
export const DROPPED_MODULES = ["backend/src/adapters/fixture-connector.ts"] as const;

/** Strings only the development exception's code has (execution-gate.ts). */
export const DEVELOPMENT_EXCEPTION_MARKERS = [
  "unverified-ack-required",
  "unverified-background",
  "unverified-not-synthetic",
  "unverified-malicious",
] as const;
/** What only the test build's pick has (execution-gate.ts, and its forwarding in composition.ts). */
export const TEST_PICK_MARKERS = ["testBuildDecision", "testBuild"] as const;

const repoPath = (id: string) => relative(REPO_ROOT, id).split(sep).join("/");

/** Why the production build refuses the module at `id` (an absolute path); undefined if it does not. */
export function forbiddenReason(id: string): string | undefined {
  const path = repoPath(id);
  if (path.startsWith("..") || path.includes("node_modules/")) return undefined;
  if (FORBIDDEN_PREFIXES.some((p) => path.startsWith(p)) || FORBIDDEN_FILES.includes(path)) {
    return `${path} is a test-only module`;
  }
  if (TEST_FILE.test(path)) return `${path} is a test-only module (file name)`;
  if (E2E_FOLDER.test(path)) return `${path} is a test-only module (e2e folder)`;
  if (Object.hasOwn(REPLACEMENTS, path)) return `${path} is a test-only module (source runs)`;
  return undefined;
}

function productionModules(): Plugin {
  return {
    name: "pki-production-modules",
    async resolveId(source, importer, options) {
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved || resolved.external) return resolved;
      const pair = REPLACEMENTS[repoPath(resolved.id)];
      if (pair !== undefined) return resolve(REPO_ROOT, pair);
      const why = forbiddenReason(resolved.id);
      if (why !== undefined) this.error(why);
      return resolved;
    },
  };
}

export interface BundleOptions {
  /** Entry, absolute or relative to the repository root. */
  input: string;
  outFile: string;
  /** Written as `import.meta.PKI_BUILD_KIND`; undefined writes nothing (as without a bundler). */
  buildKind: string | undefined;
}

/** Bundles `input` into `outFile`; returns the repository modules the bundle kept. */
export async function bundle(options: BundleOptions): Promise<{ modules: string[] }> {
  const input = resolve(REPO_ROOT, options.input);
  const entryPair = REPLACEMENTS[repoPath(input)];
  const build = await rolldown({
    input: entryPair === undefined ? input : resolve(REPO_ROOT, entryPair),
    platform: "node",
    cwd: REPO_ROOT,
    external: [
      "electron",
      ...builtinModules,
      /^node:/,
      ...EXTERNAL_PACKAGES.map((name) => new RegExp(`^${name}(/|$)`)),
    ],
    transform:
      options.buildKind === undefined
        ? {}
        : { define: { "import.meta.PKI_BUILD_KIND": JSON.stringify(options.buildKind) } },
    plugins: [productionModules()],
    onLog(level, log, handler) {
      // a warning is a build failure: an unresolved import or an eval must not ship quietly
      if (level === "warn") throw new Error(`bundle ${options.input}: ${log.message}`);
      handler(level, log);
    },
  });
  try {
    const { output } = await build.write({
      file: options.outFile,
      format: "esm",
      minify: "dce-only",
      comments: false,
      codeSplitting: false,
    });
    const modules = output.flatMap((chunk) =>
      chunk.type === "chunk"
        ? Object.entries(chunk.modules)
            .filter(([, m]) => m.renderedLength > 0)
            .map(([id]) => repoPath(id))
            .filter((p) => !p.startsWith("..") && !p.includes("node_modules/"))
        : [],
    );
    const dropped = modules.filter((m) => (DROPPED_MODULES as readonly string[]).includes(m));
    if (dropped.length > 0) {
      throw new Error(`bundle ${options.input} kept ${dropped.join(", ")}`);
    }
    return { modules: modules.sort() };
  } finally {
    await build.close();
  }
}
