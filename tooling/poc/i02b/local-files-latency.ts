/* eslint-disable pki/module-boundary -- a measurement script that reaches into the packages' sources on purpose, like the other scripts here (I02B-T03b) */
// I02B-C27 (R21): how long does one file take from "read" to "stored" through the product's own path?
// For each normal fixture of `fixtures/documents/`: the file is copied into an approved folder (the
// approval goes through the one-time ticket, as an installed build does), one pass observes it, and the
// pass that follows reads, hashes, normalizes and stores it: that second pass is the sample. The
// normalizer is the product's isolated one (a real host process) unless a test hands another in.
// Prints the p50 and the p95 of the samples; EVALUATION's target is p95 <= 3 s (S24 measures real documents).
// Usage: node local-files-latency.ts [fixturesDir] [scratchDir]
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LocalNormalizerPort } from "@pki/contracts";
import { writeSetting } from "../../../storage/src/index.ts";
import { createLocalFilesConnector } from "../../../backend/src/adapters/local-files-connector.ts";
import { systemClock } from "../../../backend/src/clock.ts";
import { openCanonicalDb, productLocalFiles } from "../../../backend/src/composition.ts";
import { syncConnector } from "../../../backend/src/connectors.ts";

export interface LatencyResult {
  files: number;
  /** Milliseconds of each file's "read -> normalize -> store" pass, in fixture order. */
  samplesMs: number[];
  p50Ms: number;
  p95Ms: number;
  /** The first file's pass, which also starts the normalizer host. */
  coldMs: number;
}

const FIXTURES = resolve(import.meta.dirname, "../../../fixtures/documents");

/** Nearest-rank percentile. */
export function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number;
}

export async function measureLocalFiles(
  options: { fixturesDir?: string; scratch?: string; normalizer?: LocalNormalizerPort } = {},
): Promise<LatencyResult> {
  const fixturesDir = options.fixturesDir ?? FIXTURES;
  const scratch = options.scratch ?? mkdtempSync(join(tmpdir(), "pki-latency-"));
  const dataDir = join(scratch, "data");
  const docs = join(scratch, "docs");
  mkdirSync(docs, { recursive: true });
  const names = readdirSync(fixturesDir)
    .filter((name) => name.startsWith("normal-"))
    .sort();
  const db = openCanonicalDb(dataDir);
  const wiring = productLocalFiles(db, {
    dataDir,
    clock: systemClock,
    onApproved: () => undefined,
    ...(options.normalizer ? { normalizer: options.normalizer } : {}),
  });
  try {
    // one millisecond of settle: the sample is the pass that reads, not the wait for the file to rest
    writeSetting(db, "localFiles.settleMs", "1");
    wiring.tickets.register({ ticket: "t".repeat(32), type: "folder", path: docs });
    const approved = await wiring.locations.approve({ type: "folder", ticket: "t".repeat(32) });
    if (!("id" in approved)) throw new Error(`approval refused: ${JSON.stringify(approved)}`);
    const connector = createLocalFilesConnector(() => wiring.ports);
    await connector.initialize({});
    const sync = () => syncConnector(db, "local-files", "local-files", connector);
    const samplesMs: number[] = [];
    for (const name of names) {
      const path = join(docs, name);
      copyFileSync(join(fixturesDir, name), path);
      const old = new Date(Date.now() - 3_600_000);
      utimesSync(path, old, old);
      await sync(); // observes the file
      await new Promise((r) => setTimeout(r, 5));
      const started = performance.now();
      const result = await sync();
      samplesMs.push(performance.now() - started);
      if (result.created < 1) throw new Error(`${name} was not stored: ${JSON.stringify(result)}`);
    }
    const sorted = [...samplesMs].sort((a, b) => a - b);
    return {
      files: names.length,
      samplesMs,
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      coldMs: samplesMs[0] as number,
    };
  } finally {
    await wiring.close();
    db.close();
    if (options.scratch === undefined) rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [fixturesDir, scratch] = process.argv.slice(2);
  const r = await measureLocalFiles({
    ...(fixturesDir ? { fixturesDir } : {}),
    ...(scratch ? { scratch } : {}),
  });
  console.log(
    `node ${process.version} ${process.platform}-${process.arch}; ${r.files} normal fixtures`,
  );
  console.log(`first file (starts the host): ${r.coldMs.toFixed(1)} ms`);
  console.log(`samples (ms): ${r.samplesMs.map((v) => v.toFixed(1)).join(", ")}`);
  console.log(`p50 ${r.p50Ms.toFixed(1)} ms, p95 ${r.p95Ms.toFixed(1)} ms (target p95 <= 3000 ms)`);
}
