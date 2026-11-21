// Test-build-only seed (V02-T10, spec "T10이 넘기는 것" 5): puts V02 fixture sets
// into a data directory's canonical DB through the product's import, job runner,
// Broker and rule, with the per-fixture Provider double bound. Run with `node`
// before an E2E starts the backend on that directory:
//   node backend/src/v02-seed.e2e.ts --data-dir DIR --set plain [--set malicious]
// It adds no switch to the backend process. The `.e2e.ts` name keeps it a test
// module: product code cannot import it (module boundary) and Playwright does not
// collect it (testIgnore). T15: it and @pki/testkit never ship in an installer.
import type { EgressControls } from "@pki/providers";
import type { SqlDriver } from "@pki/storage";
import { FakeProvider, fixtureExtraction } from "@pki/testkit";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  openCanonicalDb,
  productCalls,
  productEgress,
  productImporter,
  productRunner,
} from "./composition.ts";

const FIXTURES = resolve(import.meta.dirname, "../../fixtures");
const read = (name: string) => readFileSync(resolve(FIXTURES, name), "utf8");
const expected = JSON.parse(read("v02-expected.json")) as {
  sets: Record<string, { files: string[] }>;
};

/** The JSONL text of one fixture set of fixtures/v02-expected.json. */
export function fixtureSetText(set: string): string {
  const files = expected.sets[set]?.files;
  if (!files) throw new Error(`unknown fixture set: ${set}`);
  return files.map(read).join("\n");
}

function consentLocalModel(egress: EgressControls) {
  const shown = egress.overview().providers.find((p) => p.providerId === "local-model");
  const granted = egress.grant("local-model", ["general"], {
    destination: shown?.destination ?? "",
    policyVersion: egress.policyVersion(),
  });
  if ("error" in granted) throw new Error(granted.error);
}

/**
 * Imports `sets` (in order) and runs their extraction jobs to the end with the
 * fixture double; returns the jobs that did not end `done` (none expected).
 */
export async function seedV02(db: SqlDriver, sets: readonly string[]): Promise<number> {
  const egress = productEgress(db);
  consentLocalModel(egress);
  const provider = new FakeProvider({
    id: "local-model",
    transport: "http",
    answer: fixtureExtraction(),
  });
  const { broker } = productCalls(db, egress, { providers: [provider] });
  const runner = productRunner(db, broker);
  try {
    const importer = productImporter(db, { runner });
    for (const set of sets) {
      const result = await importer(fixtureSetText(set));
      if ("error" in result || result.errorCount > 0) throw new Error(`seed import failed: ${set}`);
      await runner.wake();
    }
  } finally {
    await runner.stop();
  }
  return db.all("SELECT id FROM jobs WHERE status <> 'done'").length;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      "data-dir": { type: "string" },
      set: { type: "string", multiple: true, default: [] },
    },
  });
  const dir = values["data-dir"];
  if (!dir || values.set.length === 0) throw new Error("--data-dir and --set are required");
  const db = openCanonicalDb(dir);
  try {
    const notDone = await seedV02(db, values.set);
    if (notDone > 0) throw new Error(`${notDone} seed jobs did not finish`);
  } finally {
    db.close();
  }
}
