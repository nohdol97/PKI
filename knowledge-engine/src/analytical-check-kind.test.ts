// S03-T04 (S03-R6, R17): the derivative kind `analytical-check`, registered with what `dataset_tables` needs.
// A deleted source's table rows go with it, in the deletion's transaction, even when another source's row
// keeps the Dataset item (the row follows its source, not its item); a new version, a prune and a scope
// change keep every row; the layer is `insight`, so the kind runs after the fact, relation and item kinds. The
// check lines (S03-T05) go with the source's versions they read, and with the rows another source's deletion
// takes from under a check; the candidates the judgement (S03-T06) will take are collected, not judged.
import {
  addEvidence,
  createUserDecisions,
  defaultScopePolicy,
  findSourceVersionId,
  insertItem,
  listCheckLines,
  listInvalidations,
  migrate,
  onMembershipChanged,
  registerConnectorInstance,
  saveCheckLine,
  saveDatasetTable,
  saveFact,
  saveRelation,
  saveSourceRecord,
  type CheckName,
  type KnowledgeAttributes,
  type ScopePolicy,
  type SqlDriver,
} from "@pki/storage";
import { seedLegacyTombstone, memoryDbTemplate } from "@pki/testkit";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CANONICAL_KINDS, createProductRegistry, propagateCanonical } from "./canonical-kinds.ts";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);

let db: SqlDriver;
beforeEach(() => {
  db = freshDb();
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
        .lineage(db, { kind: "analytical-check", id: `table:${id}` })
        .map((v) => [v.sourceId, v.version]),
    ).toEqual([
      [a, 1],
      [a, 2],
    ]);
  });
});

// ---- S03-T05: the check lines, the rows under them, the candidates ------------------------------------------

const factOn = (itemId: number, factKind: string, value: string) =>
  saveFact(db, { itemId, kind: factKind, value, ...attrs }).id;
const versionIdOf = (sourceId: number, version = 1) =>
  findSourceVersionId(db, sourceId, version) as number;
const lineOf = (
  factId: number,
  check: CheckName,
  versionId: number,
  otherVersionId: number | null = null,
) =>
  saveCheckLine(db, {
    factId,
    check,
    passed: true,
    failure: null,
    examined: 1,
    violations: 0,
    skipped: 0,
    versionId,
    otherVersionId,
    at: "t",
  });
const lineKeys = () =>
  db
    .all("SELECT fact_id, check_name FROM analytical_checks ORDER BY fact_id, check_name")
    .map((r) => `${r.fact_id as number}:${r.check_name as string}`);
const cite = (target: { factId: number } | { relationId: number }, sourceId: number, version = 1) =>
  addEvidence(db, {
    target,
    sourceVersionId: versionId(sourceId, version),
    start: 0,
    end: 2,
    quote: "본문",
  });
const versionId = versionIdOf;

describe("derivatives.contract (analytical-check, the check lines)", () => {
  it("deleting a table source removes its table rows and the lines that read its versions and counts both; a line that read another table only and another source's table row stay", () => {
    const a = source("a");
    const b = source("b");
    const dA = dataset(a, "");
    const dB = dataset(b, "");
    const gA = factOn(dA, "dataset.grain", '["k"]');
    const gB = factOn(dB, "dataset.grain", '["k"]');
    lineOf(gA, "grain", versionIdOf(a));
    lineOf(gA, "schema", versionIdOf(a));
    lineOf(gB, "grain", versionIdOf(b));
    const propagation = deletion(a);
    // one table row and the two lines the version delete's cascade took before this kind ran
    expect(propagation.removedByKind["analytical-check"]).toBe(3);
    expect(lineKeys()).toEqual([`${gB}:grain`]);
    expect(tables()).toEqual([{ source_id: b, table_key: "" }]);
    expect(deletion(a).removedByKind["analytical-check"]).toBe(0); // the same deletion again counts nothing
  });

  it("a prune removes only the lines that read the pruned versions and keeps the table rows", () => {
    const a = source("a", 2);
    const d = dataset(a, "");
    const g = factOn(d, "dataset.grain", '["k"]');
    lineOf(g, "grain", versionIdOf(a, 1));
    lineOf(g, "schema", versionIdOf(a, 2));
    const propagation = run({ kind: "old-versions-pruned", sourceId: a, version: 2 });
    expect(propagation.removedByKind["analytical-check"]).toBe(1);
    expect(lineKeys()).toEqual([`${g}:schema`]);
    expect(tables()).toEqual([{ source_id: a, table_key: "" }]);
  });

  it("a deleted source's evidence leaving a row a check reads removes that check's line; the target's own evidence leaving does not", () => {
    const table = source("table");
    const doc = source("doc");
    const other = source("other");
    const d = dataset(table, "");
    const metric = insertItem(db, { type: "Metric", name: "m", ...attrs });
    const calc = factOn(metric, "metric.calculation", '{"aggregation":"count"}');
    const grain = factOn(d, "dataset.grain", '["k"]'); // only the document cites it: it goes with it
    saveRelation(db, { subjectId: metric, type: "MEASURED_ON", objectId: d, ...attrs });
    cite({ factId: grain }, doc);
    cite({ factId: calc }, doc);
    cite({ factId: calc }, other); // the target keeps a current evidence after the document goes
    lineOf(calc, "aggregation", versionIdOf(table));
    lineOf(calc, "schema", versionIdOf(table));
    deletion(doc);
    expect(db.all("SELECT 1 FROM facts WHERE id = ?", [grain])).toEqual([]);
    // the aggregation line read the Grain fact, which is gone; the schema line did not
    expect(lineKeys()).toEqual([`${calc}:schema`]);
  });

  it("a new version or a deletion of a table removes the aggregation lines of the Metrics that use a Join on it", () => {
    const a = source("a");
    const b = source("b");
    const c = source("c");
    const dA = dataset(a, "");
    const dB = dataset(b, "");
    const dC = dataset(c, "");
    const metric = insertItem(db, { type: "Metric", name: "m", ...attrs });
    const calc = factOn(metric, "metric.calculation", '{"aggregation":"count"}');
    const join = insertItem(db, { type: "Join", name: "j", ...attrs });
    saveRelation(db, { subjectId: metric, type: "MEASURED_ON", objectId: dC, ...attrs });
    saveRelation(db, { subjectId: metric, type: "USES_JOIN", objectId: join, ...attrs });
    saveRelation(db, { subjectId: join, type: "JOIN_LEFT", objectId: dA, ...attrs });
    saveRelation(db, { subjectId: join, type: "JOIN_RIGHT", objectId: dB, ...attrs });
    const seed = () => {
      lineOf(calc, "aggregation", versionIdOf(c), null); // it read three tables: no room for a third version
      lineOf(calc, "schema", versionIdOf(c));
    };
    seed();
    source("a-unrelated");
    saveSourceRecord(db, "c1", { externalId: "a", title: "t", body: "본문 a 2" });
    run({ kind: "new-version", sourceId: a, version: 2 });
    expect(lineKeys()).toEqual([`${calc}:schema`]);
    lineOf(calc, "aggregation", versionIdOf(c));
    deletion(b);
    expect(lineKeys()).toEqual([`${calc}:schema`]);
  });

  it("the lineage of a line is the versions it read and its fact's lineage; of a table row its source's versions", () => {
    const a = source("a");
    const b = source("b");
    const doc = source("doc");
    const d = dataset(a, "");
    const f = factOn(d, "dataset.grain", '["k"]');
    cite({ factId: f }, doc);
    lineOf(f, "grain", versionIdOf(a), versionIdOf(b));
    const id = db.all("SELECT id FROM analytical_checks")[0]?.id as number;
    expect(
      kind.lineage(db, { kind: "analytical-check", id: `check:${id}` }).map((v) => v.sourceId),
    ).toEqual([a, b, doc]);
    expect(kind.lineage(db, { kind: "analytical-check", id: `claim:${f}` })).toEqual([]);
  });
});

describe("derivatives.contract (analytical-check, phase 1's candidates)", () => {
  const refs = (change: Parameters<typeof kind.affected>[1]) =>
    kind.affected(db, change).map((a) => a.ref.id);

  it("collects the candidates in phase 1 with their basis, counts none of them, and collects none on a new version or a scope change", () => {
    const a = source("a");
    const doc = source("doc");
    const d = dataset(a, "");
    const metric = insertItem(db, { type: "Metric", name: "m", ...attrs });
    const calc = factOn(metric, "metric.calculation", '{"aggregation":"count"}');
    const unit = factOn(metric, "metric.unit", "won");
    const rel = saveRelation(db, {
      subjectId: metric,
      type: "MEASURED_ON",
      objectId: d,
      ...attrs,
    }).id;
    expect(unit).toBeGreaterThan(0);
    // no check line stored: the claim is found by the relations
    const found = kind.affected(db, {
      kind: "source-deleted",
      sourceId: a,
      coversVersion: 1,
      lastRevision: null,
    });
    expect(found.map((x) => x.ref.id)).toEqual([`table:1`, `claim:${calc}`]);
    expect(found[1]?.lineage).toEqual([{ sourceId: a, version: 1 }]); // the claim's basis
    expect(refs({ kind: "new-version", sourceId: a, version: 1 })).toEqual([]);
    expect(refs({ kind: "scope-changed", sourceId: a, from: null, to: ["x"] })).toEqual([]);
    // a document whose evidence cites the path relation: its deletion collects the Metric's claim (㉮)
    cite({ relationId: rel }, doc);
    expect(
      refs({ kind: "source-deleted", sourceId: doc, coversVersion: 1, lastRevision: null }),
    ).toEqual([`claim:${calc}`]);
    // the claim is not counted, and the propagation of the table's deletion ends with the table row only
    const propagation = deletion(a);
    expect(propagation.removedByKind["analytical-check"]).toBe(1);
  });
});

describe("derivatives.contract (analytical-check, the receiver in a propagation, S02-R13)", () => {
  const apart: ScopePolicy = {
    ...defaultScopePolicy,
    combinable: (scopes) => !(scopes.length > 1 && scopes.some((s) => s?.includes("secret"))),
  };
  const AT = "2026-11-23T00:00:00.000Z";

  /** A Dataset item built from the evidence of a document of its own; `tableSource` holds its table. */
  function datasetFrom(externalId: string, tableSource: number) {
    const saved = saveSourceRecord(db, "c1", {
      externalId,
      title: `t-${externalId}`,
      body: `본문 ${externalId}`,
      accessScope: null,
    });
    if (saved.status !== "created") throw new Error(saved.status);
    const item = insertItem(db, { type: "Dataset", name: `d-${externalId}`, ...attrs });
    const fact = factOn(item, "dataset.grain", '["k"]');
    cite({ factId: fact }, saved.sourceId);
    saveDatasetTable(db, { itemId: item, sourceId: tableSource, key: externalId, rowCount: 1 });
    return { item, fact, sourceId: saved.sourceId };
  }

  it.each([true, false])(
    "the receiver is called inside a deletion's propagation and the propagation ends (a table exists: %s)",
    (withTable) => {
      const table = source("table");
      const [x, y, z] = [
        datasetFrom("x", table),
        datasetFrom("y", table),
        datasetFrom("z", table),
      ] as const;
      if (!withTable) db.run("DELETE FROM dataset_tables");
      const entry = createUserDecisions({ combinable: () => true, listeners: [] });
      db.transaction(() => entry.entities.merge(db, x.item, y.item, AT));
      db.transaction(() => entry.entities.merge(db, y.item, z.item, AT));
      db.run("UPDATE sources SET access_scope = ? WHERE id = ?", [
        JSON.stringify(["secret"]),
        z.sourceId,
      ]);
      const registry = createProductRegistry({
        policy: apart,
        membershipListeners: [onMembershipChanged],
      });
      db.transaction(() =>
        propagateCanonical(
          db,
          { kind: "scope-changed", sourceId: z.sourceId, from: null, to: ["secret"] },
          AT,
          registry,
        ),
      );
      // x's fact has a line (read from the table's version); the group is resting now, then wakes on z's deletion
      if (withTable) lineOf(x.fact, "grain", versionIdOf(table));
      db.transaction(() => {
        seedLegacyTombstone(db, {
          sourceId: z.sourceId,
          version: 1,
          at: AT,
          reason: "source-deleted",
        });
        propagateCanonical(
          db,
          { kind: "source-deleted", sourceId: z.sourceId, coversVersion: 1, lastRevision: null },
          AT,
          registry,
        );
      });
      expect(listInvalidations(db, 1).length).toBeGreaterThan(0);
      if (withTable) expect(listCheckLines(db, x.fact)).toEqual([]); // the receiver erased it
    },
  );
});

describe("derivatives.contract (analytical-check, review round 1)", () => {
  /** A table with a Dataset, a Metric measured on it, a Grain fact and the Metric's aggregation line. */
  function measured(tag = "table") {
    const table = source(tag);
    const d = dataset(table, "");
    const metric = insertItem(db, { type: "Metric", name: "m", ...attrs });
    const calc = factOn(metric, "metric.calculation", '{"aggregation":"count"}');
    const grain = factOn(d, "dataset.grain", '["k"]');
    saveRelation(db, { subjectId: metric, type: "MEASURED_ON", objectId: d, ...attrs });
    // the line is written after the citing: adding evidence to a row a check reads erases that check's line
    const writeLine = () => lineOf(calc, "aggregation", versionIdOf(table));
    return { table, calc, grain, writeLine };
  }

  it("a prune that keeps version 2 keeps the lines resting on rows cited only on version 2", () => {
    const { calc, grain, writeLine } = measured();
    const doc = source("doc", 2);
    cite({ factId: grain }, doc, 2);
    writeLine();
    run({ kind: "old-versions-pruned", sourceId: doc, version: 2 });
    expect(lineKeys()).toEqual([`${calc}:aggregation`]);
    // a row cited on the pruned version too is still collected
    const { calc: calc2, grain: grain2, writeLine: write2 } = measured("table-two");
    const docB = source("doc-b", 2);
    cite({ factId: grain2 }, docB, 1);
    write2();
    expect(
      kind
        .affected(db, { kind: "old-versions-pruned", sourceId: docB, version: 2 })
        .map((a) => a.ref.id),
    ).toContain(
      `check:${db.all("SELECT id FROM analytical_checks WHERE fact_id = ?", [calc2])[0]?.id}`,
    );
  });

  it("a line erased because a deleted source's evidence left a row it reads queues the check job of its table", () => {
    const { table, grain, writeLine } = measured();
    const docD = source("doc-d");
    const docE = source("doc-e");
    cite({ factId: grain }, docD);
    cite({ factId: grain }, docE); // the Grain fact stays: only the evidence of D goes
    writeLine();
    db.run("DELETE FROM jobs");
    deletion(docD);
    expect(db.all("SELECT 1 FROM facts WHERE id = ?", [grain])).toHaveLength(1);
    expect(lineKeys()).toEqual([]); // erased: the Grain fact it read lost the evidence of D
    expect(
      db.all("SELECT source_id FROM jobs WHERE kind = 'analytical-check'").map((r) => r.source_id),
    ).toEqual([table]);
  });
});

describe("gate.lost (analytical-check, the deletion's judgement, S03-R16 ①, G-C4)", () => {
  it("G-C4 (①): deleting the table source of a verified calculation's Dataset disputes it in the deletion's transaction with data-basis-lost and the covered version as the basis", () => {
    const table = source("table");
    const d = dataset(table, "");
    const metric = insertItem(db, { type: "Metric", name: "m", ...attrs });
    saveRelation(db, { subjectId: metric, type: "MEASURED_ON", objectId: d, ...attrs });
    const calc = saveFact(db, {
      itemId: metric,
      kind: "metric.calculation",
      value: '{"aggregation":"count"}',
      ...attrs,
      status: "verified",
    }).id;
    deletion(table);
    expect(db.all("SELECT status FROM facts WHERE id = ?", [calc])).toEqual([
      { status: "disputed" },
    ]);
    expect(
      db.all(
        "SELECT actor, action, reason, basis_source_id, basis_version FROM fact_history WHERE fact_id = ? ORDER BY seq DESC LIMIT 1",
        [calc],
      ),
    ).toEqual([
      {
        actor: "policy",
        action: "dispute",
        reason: "data-basis-lost",
        basis_source_id: table,
        basis_version: 1,
      },
    ]);
  });
});
