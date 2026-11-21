// Leak checks over the OS temp directory (V01-C5 `secrets`, `redaction.failure-paths`):
// the entries that appeared since `before`, plain files at the top level included,
// whose bytes contain `needle`. Only listing and reading are guarded — an entry a
// sibling test removed meanwhile is skipped — the verdict is the caller's assertion.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const tempEntries = (): Set<string> => new Set(readdirSync(tmpdir()));

function filesOf(path: string): string[] {
  try {
    if (statSync(path).isFile()) return [path];
    return readdirSync(path, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name));
  } catch {
    return []; // removed meanwhile
  }
}

function contains(file: string, needle: string): boolean {
  try {
    return readFileSync(file).includes(needle);
  } catch {
    return false; // removed meanwhile
  }
}

export function newTempFilesContaining(before: ReadonlySet<string>, needle: string): string[] {
  return readdirSync(tmpdir())
    .filter((name) => !before.has(name))
    .flatMap((name) => filesOf(join(tmpdir(), name)))
    .filter((file) => contains(file, needle));
}
