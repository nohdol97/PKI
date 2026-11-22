// Canary inspection of a data directory (I04-R6, C3): after a deletion, no file
// under the directory may still hold a canary string, whichever file it is: the
// database, its -journal/-wal/-shm, or a projection's own path. Canaries must not
// share a prefix with each other or with any other stored word (FTS stores shared
// prefixes once, so a missing canary would prove nothing about the one it shadows).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface CanaryHit {
  canary: string;
  /** Path relative to the inspected directory. */
  file: string;
}

function* filesUnder(dir: string, prefix = ""): Generator<string> {
  const entries = readdirSync(join(dir, prefix), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) yield* filesUnder(dir, relative);
    else if (entry.isFile()) yield relative;
  }
}

/**
 * Every (canary, file) pair where the file's bytes contain the canary, as written
 * or lowercased (an index keeps the lowercased word). Empty means none left.
 */
export function findCanaries(dir: string, canaries: readonly string[]): CanaryHit[] {
  const hits: CanaryHit[] = [];
  for (const file of filesUnder(dir)) {
    const bytes = readFileSync(join(dir, file));
    for (const canary of canaries) {
      if (bytes.includes(canary) || bytes.includes(canary.toLowerCase())) {
        hits.push({ canary, file });
      }
    }
  }
  return hits;
}

/** The canaries found anywhere under `dir`, each once, in the order given. */
export function canariesLeft(dir: string, canaries: readonly string[]): string[] {
  const found = new Set(findCanaries(dir, canaries).map((h) => h.canary));
  return canaries.filter((c) => found.has(c));
}
