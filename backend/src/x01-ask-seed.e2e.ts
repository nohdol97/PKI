// Test-build-only seed for the Ask screen's browser E2E (X01-C2c): imports fixtures/x01-ask.jsonl through the
// product's importer into a data directory's canonical DB and plants the release-date knowledge its labels name
// (the fixture extraction has no kind for `release_date`; X01-D12 plants labelled knowledge the same way), so a
// hit has related knowledge and the old mail version is stale. Run with `node` before the E2E starts the backend:
//   node backend/src/x01-ask-seed.e2e.ts --data-dir DIR
import { locateQuote } from "@pki/knowledge-engine";
import {
  addEvidence,
  insertAssertionLink,
  insertItem,
  saveFact,
  type SqlDriver,
} from "@pki/storage";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { openCanonicalDb, productImporter } from "./composition.ts";

const FIXTURES = resolve(import.meta.dirname, "../../fixtures");
const attrs = {
  epistemic: "explicit",
  status: "verified",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
} as const;

export async function seedAsk(db: SqlDriver): Promise<void> {
  const imported = await productImporter(db)(
    readFileSync(resolve(FIXTURES, "x01-ask.jsonl"), "utf8"),
  );
  if ("error" in imported || imported.errorCount > 0) throw new Error("seed import failed");

  // the two versions of mail/x01-release, oldest first
  const [oldId, newId] = db
    .all(
      `SELECT v.id, v.body FROM source_versions v JOIN sources s ON s.id = v.source_id
        WHERE s.external_id = 'mail/x01-release' ORDER BY v.id`,
    )
    .map((r) => ({ id: r.id as number, body: r.body as string }));
  if (!oldId || !newId) throw new Error("seed: the release mail has no two versions");
  const project = insertItem(db, { type: "Project", name: "물결 프로젝트", ...attrs });
  const plant = (version: { id: number; body: string }, value: string, quote: string) => {
    const fact = saveFact(db, {
      itemId: project,
      kind: "release_date",
      value,
      ...attrs,
      validAt: value,
    }).id;
    const span = locateQuote(version.body, quote);
    if ("dropped" in span) throw new Error("seed: quote not found");
    addEvidence(db, { target: { factId: fact }, sourceVersionId: version.id, quote, ...span });
    return fact;
  };
  const was = plant(oldId, "2026-12-10", "배포일은 12월 10일이다");
  const now = plant(newId, "2026-12-17", "배포일은 12월 17일로 바뀌었다");
  insertAssertionLink(db, {
    type: "SUPERSEDES",
    fromFactId: now,
    toFactId: was,
    createdBy: "rule",
    at: "2026-11-23T00:00:00.000Z",
  });
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { "data-dir": { type: "string" } } });
  const dir = values["data-dir"];
  if (!dir) throw new Error("--data-dir is required");
  const db = openCanonicalDb(dir);
  try {
    await seedAsk(db);
  } finally {
    db.close();
  }
}
