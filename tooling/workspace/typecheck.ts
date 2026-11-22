// `pnpm typecheck` (I05-R3): `tsc -b` over the repository's own project and, when they exist, a fork's
// composition package and collector packages. The public `tsconfig.json` names no fork project, so the same
// file reads the same in a fork. `backend/tsconfig.json` emits declarations (as `storage` does) because the
// first project that references `@pki/backend` is one of these (TS6310 otherwise, I05-T01). The projects go
// to one `tsc -b` call, which reports the errors of all of them (I05-T01 A6).
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { isSiteDir, workspaceDirs } from "./packages.ts";

/** The projects to build, relative to `root`: `.` and the fork's packages that have a tsconfig.json, sorted. */
export function typecheckProjects(root: string): string[] {
  const fork = workspaceDirs(root)
    .filter((dir) => isSiteDir(dir) && existsSync(join(root, dir, "tsconfig.json")))
    .sort();
  return [".", ...fork];
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, "../..");
  const tsc = join(root, "node_modules/typescript/bin/tsc");
  const run = spawnSync(process.execPath, [tsc, "-b", ...typecheckProjects(root)], {
    cwd: root,
    stdio: "inherit",
  });
  process.exitCode = run.status ?? 1;
}
