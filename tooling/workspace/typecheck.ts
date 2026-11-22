// `pnpm typecheck` (I05-R3): `tsc -b` over the repository's own project and, when they exist, a fork's
// composition package and collector packages. The public `tsconfig.json` names no fork project, so the same
// file reads the same in a fork. `backend/tsconfig.json` emits declarations (as `storage` does) because the
// first project that references `@pki/backend` is one of these (TS6310 otherwise, I05-T01). The projects go
// to one `tsc -b` call, which reports the errors of all of them (I05-T01 A6).
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { isSiteDir, workspaceDirs } from "./packages.ts";

/**
 * The projects to build, relative to `root`: `.` and the fork's packages, sorted. A fork package with no
 * tsconfig.json fails by name rather than being left out, which would pass its errors silently.
 */
export function typecheckProjects(root: string): string[] {
  const fork = workspaceDirs(root).filter(isSiteDir).sort();
  for (const dir of fork) {
    if (!existsSync(join(root, dir, "tsconfig.json"))) {
      throw new Error(`${dir} has no tsconfig.json: add one (the type check would leave it out)`);
    }
  }
  return [".", ...fork];
}

/** Runs `tsc -b` over the projects of `root` and returns its exit status (a failed start is 1). */
export function runTypecheck(root: string): number {
  const tsc = join(import.meta.dirname, "../../node_modules/typescript/bin/tsc");
  const run = spawnSync(process.execPath, [tsc, "-b", ...typecheckProjects(root)], {
    cwd: root,
    stdio: "inherit",
  });
  return run.status ?? 1;
}

if (import.meta.main) {
  try {
    // the root is the repository's; an argument names another (the runner's own tests)
    process.exitCode = runTypecheck(resolve(process.argv[2] ?? join(import.meta.dirname, "../..")));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
