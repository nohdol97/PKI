// S01-T06 (R20, R22): the derivative kind `ontology`. The contract cases ①–⑥ run for it in
// canonical-kinds.test.ts (the fixture's lineage-free row is a user-added element); here the parts
// the contract cannot hold: a verified element keeps no lineage and survives its source's deletion
// (its lineage rows alone go), a candidate or rejected one is deleted with the last of its lineage,
// and an earlier-version prune reaches the lineage rows below the version it keeps.
import {
  applyOntologyChange,
  migrate,
  registerConnectorInstance,
  saveSourceRecord,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { setOntologyStatusForTest } from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CANONICAL_KINDS, propagateCanonical } from "./canonical-kinds.ts";

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

const kind = CANONICAL_KINDS.find((k) => k.kind === "ontology");
if (!kind) throw new Error("the ontology kind is not registered");

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

type Status = "candidate" | "verified" | "rejected" | "superseded";
/** An element in `status` whose lineage rows are `from`; a verified or superseded one was proposed first. */
function element(name: string, status: Status, from: [number, number][]): number {
  const [first, ...more] = from as [[number, number], ...[number, number][]];
  const outcome = applyOntologyChange(
    db,
    { op: "add", name, rule: { elementKind: "item-type" } },
    "extraction",
    { sourceId: first[0], version: first[1] },
  );
  if (outcome.status !== "candidate") throw new Error(JSON.stringify(outcome));
  for (const [sourceId, version] of more) {
    db.run("INSERT INTO ontology_basis (element_id, source_id, version) VALUES (?, ?, ?)", [
      outcome.id,
      sourceId,
      version,
    ]);
  }
  if (status !== "candidate") setOntologyStatusForTest(db, outcome.id, status);
  return outcome.id;
}

const stored = (id: number) =>
  db.all("SELECT status FROM ontology_elements WHERE id = ?", [id]).map((r) => r.status);
const basisOf = (id: number) =>
  db
    .all("SELECT source_id, version FROM ontology_basis WHERE element_id = ? ORDER BY 1, 2", [id])
    .map((r) => [r.source_id, r.version]);
const history = (id: number) =>
  db.all("SELECT count(*) AS n FROM ontology_history WHERE element_id = ?", [id])[0]?.n;
const lineage = (id: number) =>
  kind.lineage(db, { kind: "ontology", id: String(id) }).map((v) => [v.sourceId, v.version]);
const run = (change: Parameters<typeof propagateCanonical>[1]) =>
  db.transaction(() => propagateCanonical(db, change)).propagation;
const deletion = (sourceId: number) =>
  run({ kind: "source-deleted", sourceId, coversVersion: 1, lastRevision: null });

describe("ontology.candidates: the kind's lineage (R20, R22)", () => {
  it("follows the basis rows of a candidate and a rejected element and holds none for a verified or retired one", () => {
    const a = source("a");
    const [c, r, v, s] = (
      [
        ["Cand", "candidate"],
        ["Rej", "rejected"],
        ["Ver", "verified"],
        ["Ret", "superseded"],
      ] as const
    ).map(([name, status]) => element(name, status, [[a, 1]])) as [number, number, number, number];
    expect(lineage(c)).toEqual([[a, 1]]);
    expect(lineage(r)).toEqual([[a, 1]]);
    expect(lineage(v)).toEqual([]);
    expect(lineage(s)).toEqual([]);
    // the rows themselves are kept, for an undo of the approval
    expect(basisOf(v)).toEqual([[a, 1]]);
  });
});

describe("ontology.candidates: a source's deletion (R22)", () => {
  it("removes the lineage rows of every element and deletes the candidates and rejected ones left with none", () => {
    const a = source("a");
    const b = source("b");
    const onlyA = element("OnlyA", "candidate", [[a, 1]]);
    const rejectedA = element("RejA", "rejected", [[a, 1]]);
    const shared = element("Shared", "candidate", [
      [a, 1],
      [b, 1],
    ]);
    const rejectedShared = element("RejShared", "rejected", [
      [a, 1],
      [b, 1],
    ]);
    const verified = element("Ver", "verified", [[a, 1]]);
    const retired = element("Ret", "superseded", [[a, 1]]);
    const user = applyOntologyChange(
      db,
      { op: "add", name: "Mine", rule: { elementKind: "item-type" } },
      "user",
    );
    if (user.status !== "applied") throw new Error("setup");

    const record = deletion(a);
    expect(record.removedByKind.ontology).toBe(2);
    expect(record.recomputedByKind.ontology).toBe(0);
    expect([onlyA, rejectedA].map(stored)).toEqual([[], []]);
    expect([onlyA, rejectedA].map(history)).toEqual([0, 0]); // the history went with its element
    expect([shared, rejectedShared].map(stored)).toEqual([["candidate"], ["rejected"]]);
    expect([shared, rejectedShared].map(basisOf)).toEqual([[[b, 1]], [[b, 1]]]);
    expect([shared, rejectedShared].map(lineage)).toEqual([[[b, 1]], [[b, 1]]]);
    // a verified or retired element is a rule the user accepted: it stays, its lineage rows alone go
    expect([verified, retired].map(stored)).toEqual([["verified"], ["superseded"]]);
    expect([verified, retired].map(basisOf)).toEqual([[], []]);
    expect(history(verified)).toBeGreaterThan(0);
    expect(stored(user.id)).toEqual(["verified"]);
  });

  it("leaves a candidate that still has a source and deletes it with the last one", () => {
    const a = source("a");
    const b = source("b");
    const both = element("Both", "candidate", [
      [a, 1],
      [b, 1],
    ]);
    deletion(a);
    expect(stored(both)).toEqual(["candidate"]);
    deletion(b);
    expect(stored(both)).toEqual([]);
  });

  it("keeps every row for a new version and for a scope change", () => {
    const a = source("a", 2);
    const id = element("Cand", "candidate", [[a, 1]]);
    const record = run({ kind: "new-version", sourceId: a, version: 2 });
    expect(record.removedByKind.ontology).toBe(0);
    run({ kind: "scope-changed", sourceId: a, from: null, to: ["team"] });
    expect(stored(id)).toEqual(["candidate"]);
    expect(basisOf(id)).toEqual([[a, 1]]);
  });
});

describe("ontology.candidates: a prune of earlier versions (R22)", () => {
  it("takes the lineage rows below the kept version and deletes what is left with none", () => {
    const a = source("a", 3);
    const old = element("Old", "candidate", [
      [a, 1],
      [a, 2],
    ]);
    const mixed = element("Mixed", "rejected", [
      [a, 1],
      [a, 3],
    ]);
    const kept = element("Kept", "candidate", [[a, 3]]);
    const verified = element("Ver", "verified", [
      [a, 1],
      [a, 3],
    ]);
    const record = run({ kind: "old-versions-pruned", sourceId: a, version: 3 });
    expect(record.removedByKind.ontology).toBe(1);
    expect(stored(old)).toEqual([]);
    expect(stored(mixed)).toEqual(["rejected"]);
    expect(basisOf(mixed)).toEqual([[a, 3]]);
    expect(basisOf(kept)).toEqual([[a, 3]]);
    expect(stored(verified)).toEqual(["verified"]);
    expect(basisOf(verified)).toEqual([[a, 3]]);
  });
});
