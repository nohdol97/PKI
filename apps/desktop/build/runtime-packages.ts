// The app folder's node_modules (V01-T15): the bundles' external packages
// (bundle.ts EXTERNAL_PACKAGES, native code) and everything they depend on, as
// real files out of the pnpm store, one copy per version. A second version of a
// name goes under the package that needs it, where Node's lookup finds it first.
// Type-only `@types/*` packages are left out. Only what is installed is copied:
// optional dependencies of other platforms are not there (build on the target OS).
import { cpSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

export interface RuntimePackage {
  name: string;
  version: string;
  license: string;
  /** The package's folder in the store. */
  source: string;
  /** Where it goes. */
  dest: string;
}

interface Manifest {
  name: string;
  version: string;
  license?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/** Node's lookup from `from`: the nearest node_modules/<name> going up. */
function findPackage(name: string, from: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(dir) === dir) return undefined;
  }
}

const read = (dir: string): Manifest => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

/**
 * Where each package goes under `nodeModules`. `roots` are the externals, each
 * looked up from the folder of the workspace package that declares it.
 */
export function planRuntimePackages(
  roots: readonly { name: string; from: string }[],
  nodeModules: string,
): RuntimePackage[] {
  const plan: RuntimePackage[] = [];
  const top = new Map<string, string>(); // name → source placed at the top
  const placed = new Set<string>(); // dest folders

  const place = (name: string, from: string, parentDest: string, optional: boolean) => {
    if (name.startsWith("@types/")) return;
    const source = findPackage(name, from);
    if (source === undefined) {
      if (optional) return;
      throw new Error(`${name} (needed from ${from}) not found`);
    }
    const manifest = read(source);
    const atTop = top.get(name);
    let dest: string;
    if (atTop === undefined) {
      dest = join(nodeModules, name);
      top.set(name, source);
    } else if (atTop === source) {
      return;
    } else {
      dest = join(parentDest, "node_modules", name);
    }
    if (placed.has(dest)) return;
    placed.add(dest);
    plan.push({
      name,
      version: manifest.version,
      license: manifest.license ?? "",
      source,
      dest,
    });
    for (const dep of Object.keys(manifest.dependencies ?? {})) place(dep, source, dest, false);
    for (const dep of Object.keys(manifest.optionalDependencies ?? {})) {
      place(dep, source, dest, true);
    }
  };

  for (const root of roots) place(root.name, root.from, nodeModules, false);
  return plan;
}

export function copyRuntimePackages(plan: readonly RuntimePackage[]): void {
  for (const p of plan) cpSync(p.source, p.dest, { recursive: true, dereference: true });
}
