// S03-T04 (S03-R6, R17): the derivative kind `analytical-check`, registered with what `dataset_tables` needs.
// A deleted source's table rows go with it, in the deletion's transaction, even when another source's row
// keeps the Dataset item (the row follows its source, not its item); a new version, a prune and a scope
// change keep every row; the layer is `insight`, so the kind runs after the fact, relation and item kinds. The
// rest of the kind (the check rows' judgement, S03-R16) is S03-T05's.
import {
  addEvidence,
  insertItem,
  migrate,
  registerConnectorInstance,
  saveDatasetTable,
  saveFact,
  saveSourceRecord,
  type KnowledgeAttributes,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CANONICAL_KINDS, propagateCanonical } from "./canonical-kinds.ts";

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

const kind = CANONICAL_KINDS.find((k) => k.kind === "analytical-check");
if (!kind) throw new Error("the analytical-check kind is not registered");
const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-23T00:00:00Z",
};

/** A source with `n` versions. */
function source(externalId: string, n = 1): number {
  let sourceId = 0;
  for (let v = 1; v <= n; v++) {
    const saved = saveSourceRecord(db, "c1", {
      externalId,
      title: "t",
      body: `본문 ${externalId} ${v}`,
    });
    if (saved.status !== "created") throw new Error(saved.status);
    sourceId = saved.sourceId;
  }
  return sourceId;
}
/** A Dataset item tied to a table of `sourceId`, optionally with a fact of the document `holder` on it. */
function dataset(sourceId: number, key: string, holder?: number): number {
  const item = insertItem(db, { type: "Dataset", name: `d:${key}`, ...attrs });
  saveDatasetTable(db, { itemId: item, sourceId, key, rowCount: 2 });
  if (holder !== undefined) {
    const fact = saveFact(db, { itemId: item, kind: "definition", value: "정의", ...attrs }).id;
    const version = db.all("SELECT id FROM source_versions WHERE source_id = ?", [holder])[0]
      ?.id as number;
    addEvidence(db, {
      target: { factId: fact },
      sourceVersionId: version,
      start: 0,
      end: 2,
      quote: "본문",
    });
  }
  return item;
}
const tables = () => db.all("SELECT source_id, table_key FROM dataset_tables ORDER BY id");
const run = (change: Parameters<typeof propagateCanonical>[1]) =>
  db.transaction(() => propagateCanonical(db, change)).propagation;
const deletion = (sourceId: number, coversVersion = 1) =>
  run({ kind: "source-deleted", sourceId, coversVersion, lastRevision: null });

describe("derivatives.contract (analytical-check, what T04 registers)", () => {
  it("is registered in the insight layer, after the fact, relation and item kinds", () => {
    expect(kind.layer).toBe("insight");
    expect(kind.storage).toBe("canonical");
    const order = CANONICAL_KINDS.map((k) => k.kind);
    for (const before of ["fact", "relation", "item"]) {
      expect(order.indexOf("analytical-check"), before).toBeGreaterThan(order.indexOf(before));
    }
  });

  it("takes the source's table rows on a deletion and counts them in the record; others stay", () => {
    const a = source("a");
    const b = source("b");
    dataset(a, "");
    dataset(a, "Sheet2");
    dataset(b, "");
    const propagation = deletion(a);
    expect(propagation.removedByKind["analytical-check"]).toBe(2);
    expect(tables()).toEqual([{ source_id: b, table_key: "" }]);
  });

  it("takes the row though another source's row keeps the Dataset item (the row follows its source)", () => {
    const table = source("table");
    const document = source("document");
    const item = dataset(table, "Sheet1", document);
    deletion(table);
    expect(tables()).toEqual([]);
    // the item stays: the document's fact still points at it
    expect(db.all("SELECT id FROM items WHERE id = ?", [item])).toEqual([{ id: item }]);
  });

  it("goes with the item when the item is deleted (cascade), and a second run counts nothing", () => {
    const a = source("a");
    dataset(a, "");
    expect(deletion(a).removedByKind["analytical-check"]).toBe(1);
    expect(tables()).toEqual([]);
    expect(deletion(a).removedByKind["analytical-check"]).toBe(0);
  });

  it("keeps every row on a new version, a scope change and an earlier-version prune", () => {
    const a = source("a", 2);
    dataset(a, "");
    run({ kind: "new-version", sourceId: a, version: 2 });
    run({ kind: "scope-changed", sourceId: a, from: null, to: ["user:me"] });
    run({ kind: "old-versions-pruned", sourceId: a, version: 2 });
    expect(tables()).toEqual([{ source_id: a, table_key: "" }]);
  });

  it("reports the source's versions as the row's lineage", () => {
    const a = source("a", 2);
    dataset(a, "");
    const id = db.all("SELECT id FROM dataset_tables")[0]?.id as number;
    expect(
      kind
        .lineage(db, { kind: "analytical-check", id: String(id) })
        .map((v) => [v.sourceId, v.version]),
    ).toEqual([
      [a, 1],
      [a, 2],
    ]);
  });
});
