// S01-T04 `correction.deletion` (S01-R14, R22; decision 4): what a source's deletion, a tombstone and a
// prune of earlier versions do to the rows the user wrote or approved. A row the user wrote skips the
// two evidence-count rules (superseded without current evidence, deleted without any); the way it goes
// is its item: an item with no source-derived row left is deleted and the user's rows on it with it,
// except an item the user created. The rows are made by the real user entry; all data is synthetic.
import {
  addEvidence,
  automatedLifecycle,
  canonicalTransaction,
  insertItem,
  listEvidence,
  listInvalidations,
  prepareCanonicalDb,
  registerConnectorInstance,
  saveFact,
  saveRelation,
  saveSourceRecord,
  userDecisions,
  type EntryRef,
  type KnowledgeAttributes,
  type SourceChange,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { canariesLeft, seedLegacyTombstone } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { propagateCanonical } from "./canonical-kinds.ts";

const AT = "2026-11-23T00:00:00.000Z";
const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-22T00:00:00Z",
};
const CANARY = "qzusercanary";

let dir: string;
let db: SqlDriver;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-correction-deletion-"));
  db = openBetterSqlite3(join(dir, "pki.sqlite"));
  prepareCanonicalDb(db);
  registerConnectorInstance(db, "c", "test-fixtures");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A source with two versions; the evidence the world holds is on the first one (past evidence once the second arrives). */
function source(externalId: string) {
  const first = saveSourceRecord(db, "c", {
    externalId,
    title: externalId,
    body: `${externalId} 하나`,
  });
  const second = saveSourceRecord(db, "c", {
    externalId,
    title: externalId,
    body: `${externalId} 둘`,
  });
  if (first.status !== "created" || second.status !== "created") throw new Error("source");
  const versionId = (v: number) =>
    db.all("SELECT id FROM source_versions WHERE source_id = ? AND version = ?", [
      first.sourceId,
      v,
    ])[0]?.id as number;
  return { sourceId: first.sourceId, v1: versionId(1), v2: versionId(2), latest: 2 };
}
type Source = ReturnType<typeof source>;

const cite = (target: { factId: number } | { relationId: number }, s: Source, version = s.v1) => {
  const body = db.all("SELECT body FROM source_versions WHERE id = ?", [version])[0]
    ?.body as string;
  return addEvidence(db, {
    target,
    sourceVersionId: version,
    start: 0,
    end: [...body].length,
    quote: body,
  });
};

/** What extraction writes: a candidate row with its creation line and evidence from `s`. */
const extractedItem = (name: string) => {
  const id = insertItem(db, { type: "Project", name, ...attrs });
  automatedLifecycle.created(db, { kind: "item", id }, "extraction", null);
  return id;
};
const extractedFact = (itemId: number, value: string, ...from: Source[]) => {
  const id = saveFact(db, { itemId, kind: "target_date", value, ...attrs }).id;
  automatedLifecycle.created(db, { kind: "fact", id }, "extraction", null);
  for (const s of from) cite({ factId: id }, s);
  return id;
};
const extractedRelation = (subjectId: number, objectId: number, ...from: Source[]) => {
  const id = saveRelation(db, { subjectId, type: "DEPENDS_ON", objectId, ...attrs }).id;
  automatedLifecycle.created(db, { kind: "relation", id }, "extraction", null);
  for (const s of from) cite({ relationId: id }, s);
  return id;
};

function add(entry: Parameters<typeof userDecisions.add>[1]): EntryRef {
  const r = userDecisions.add(db, entry);
  if (r.status !== "applied") throw new Error(`add refused: ${JSON.stringify(r)}`);
  return r.ref;
}
const userFact = (itemId: number, value: string, kind = "target_date") =>
  add({ kind: "fact", itemId, factKind: kind, value });
const userRelation = (subjectId: number, objectId: number) =>
  add({ kind: "relation", subjectId, type: "DEPENDS_ON", objectId });

const stored = (table: string, id: number) =>
  db.all(`SELECT 1 FROM ${table} WHERE id = ?`, [id]).length === 1;
const hasFact = (id: number) => stored("facts", id);
const hasItem = (id: number) => stored("items", id);
const hasRelation = (id: number) => stored("relations", id);
const factLines = (id: number) =>
  db.all("SELECT seq, actor, action FROM fact_history WHERE fact_id = ? ORDER BY seq", [id]);

/** The three ways a source's content goes (a tombstone's three reasons are one deletion) and the prune. */
type Mode = "source-deleted" | "user-deleted" | "access-revoked" | "pruned";
const MODES: readonly Mode[] = ["source-deleted", "user-deleted", "access-revoked", "pruned"];

/** Runs the change for `s` through the registry as the entries do, in one transaction. */
function remove(mode: Mode, s: Source) {
  return canonicalTransaction(db, (tx) => {
    let change: SourceChange;
    if (mode === "pruned") {
      change = { kind: "old-versions-pruned", sourceId: s.sourceId, version: s.latest };
    } else {
      seedLegacyTombstone(tx, { sourceId: s.sourceId, version: s.latest, at: AT, reason: mode });
      change = { kind: mode, sourceId: s.sourceId, coversVersion: s.latest, lastRevision: null };
    }
    const { report } = propagateCanonical(tx, change, AT);
    const record = listInvalidations(tx, 1)[0];
    return { report, removed: record?.removedByKind ?? {} };
  });
}

describe.each(MODES)("correction.deletion: %s", (mode) => {
  it("(a) keeps a user-written fact and relation an extraction had cited, at no evidence, while the item stays", () => {
    const a = source("a");
    const b = source("b");
    const x = extractedItem("X");
    const y = extractedItem("Y");
    extractedFact(y, "2026-12-08", b); // Y has a source of its own
    const fromA = extractedFact(x, "2026-12-01", a);
    const fromB = extractedFact(x, "2026-12-02", b);
    const relA = extractedRelation(x, y, a);
    // the user wrote these values; extraction found the same values in `a` and attached evidence
    const written = userFact(x, "2026-12-03");
    const writtenRelation = userRelation(y, x);
    cite({ factId: written.id }, a);
    cite({ relationId: writtenRelation.id }, a);
    expect(listEvidence(db, { factId: written.id })).toHaveLength(1);
    const linesBefore = factLines(written.id);

    const done = remove(mode, a);

    expect(hasFact(fromA)).toBe(false); // an extraction row with no evidence goes, as before
    expect(hasRelation(relA)).toBe(false);
    expect(hasFact(fromB)).toBe(true);
    expect(hasFact(written.id)).toBe(true);
    expect(hasRelation(writtenRelation.id)).toBe(true);
    expect(listEvidence(db, { factId: written.id })).toHaveLength(0);
    expect(
      db.all("SELECT status, epistemic, user_authored FROM facts WHERE id = ?", [written.id]),
    ).toEqual([{ status: "verified", epistemic: "user-approved", user_authored: 1 }]);
    expect(factLines(written.id)).toEqual(linesBefore); // no supersede line either
    expect(hasItem(x)).toBe(true);
    expect(hasItem(y)).toBe(true);
    expect(done.removed).toMatchObject({ fact: 1, relation: 1 });
    expect(done.removed.item).toBe(0);
  });

  it("(b) keeps an item the user created with the user's rows, and deletes its extraction rows", () => {
    const a = source("a");
    const mine = add({ kind: "item", type: "Project", name: "내 항목" }).id;
    const other = extractedItem("O");
    extractedFact(other, "2026-12-11", source("b")); // O has a source of its own
    const keepFact = userFact(mine, "2026-12-04");
    const extracted = extractedFact(mine, "2026-12-05", a);
    const extractedRel = extractedRelation(mine, other, a);
    const userRel = userRelation(other, mine);

    const done = remove(mode, a);

    expect(hasItem(mine)).toBe(true);
    expect(hasFact(keepFact.id)).toBe(true);
    expect(hasRelation(userRel.id)).toBe(true);
    expect(hasFact(extracted)).toBe(false);
    expect(hasRelation(extractedRel)).toBe(false);
    expect(hasItem(other)).toBe(true);
    expect(done.removed).toMatchObject({ fact: 1, relation: 1, item: 0 });
  });

  it("(c) deletes a non-user item with the user's facts and relations on it, and counts them under their kinds", () => {
    const a = source("a");
    const k = extractedItem("K");
    const mine = add({ kind: "item", type: "System", name: "내 시스템" }).id;
    const j = extractedItem("J");
    const b = source("b");
    extractedFact(j, "2026-12-09", b); // J has a source of its own
    const fromA = extractedFact(k, "2026-12-01", a);
    const typed = userFact(k, CANARY, "memo");
    const typedRel = userRelation(k, mine);
    const reverseRel = userRelation(j, k);
    const jFact = userFact(j, "2026-12-10");

    const done = remove(mode, a);

    expect(hasItem(k)).toBe(false);
    for (const id of [fromA, typed.id]) expect(hasFact(id)).toBe(false);
    for (const id of [typedRel.id, reverseRel.id]) expect(hasRelation(id)).toBe(false);
    expect(hasItem(mine)).toBe(true); // the user's own item is the other end: it stays
    expect(hasItem(j)).toBe(true);
    expect(hasFact(jFact.id)).toBe(true);
    // the record counts the user's rows with the extraction's: two facts, two relations, one item
    expect(done.removed).toMatchObject({ fact: 2, relation: 2, item: 1 });
    expect(done.report.facts).toEqual([fromA, typed.id].sort((p, q) => p - q));
    expect(done.report.items).toEqual([k]);
  });

  it("(c) leaves none of the deleted user-written text in any file", () => {
    const a = source("a");
    const k = extractedItem("K");
    extractedFact(k, "2026-12-01", a);
    userFact(k, CANARY, "memo");
    db.close();
    expect(canariesLeft(dir, [CANARY])).toEqual([CANARY]); // it is in the file before the deletion
    db = openBetterSqlite3(join(dir, "pki.sqlite"));
    prepareCanonicalDb(db);
    remove(mode, a);
    db.close();
    expect(canariesLeft(dir, [CANARY])).toEqual([]);
    db = openBetterSqlite3(join(dir, "pki.sqlite"));
    prepareCanonicalDb(db);
  });

  it("(c) a user-written row on an item whose evidence the user's row itself holds does not keep the item", () => {
    // evidence attached to a user-written row is about the user's value, not the item's name: the item
    // is held by source-derived rows only (the cautious reading of R14: the deletion guarantee first)
    const a = source("a");
    const b = source("b");
    const k = extractedItem("K");
    extractedFact(k, "2026-12-01", a);
    const written = userFact(k, "2026-12-02");
    cite({ factId: written.id }, b);

    remove(mode, a);

    expect(hasItem(k)).toBe(false);
    expect(hasFact(written.id)).toBe(false);
  });

  it("(c) an item whose only row from a source is a relation is deleted with the user's rows too", () => {
    const a = source("a");
    const b = source("b");
    const k = extractedItem("K");
    const j = extractedItem("J");
    extractedFact(j, "2026-12-09", b);
    const rel = extractedRelation(k, j, a);
    const written = userFact(k, "2026-12-02");
    const writtenRel = userRelation(j, k);
    cite({ relationId: writtenRel.id }, b); // evidence on the user's relation does not hold K either

    remove(mode, a);

    expect(hasRelation(rel)).toBe(false);
    expect(hasItem(k)).toBe(false);
    expect(hasFact(written.id)).toBe(false);
    expect(hasRelation(writtenRel.id)).toBe(false);
    expect(hasItem(j)).toBe(true);
  });

  it("(d) deletes a row approved with no current evidence when its evidence was only on the deleted source", () => {
    const a = source("a");
    const b = source("b");
    const x = extractedItem("X");
    extractedFact(x, "2026-12-02", b);
    const approved = extractedFact(x, "2026-12-01", a);
    expect(userDecisions.decide(db, { kind: "fact", id: approved }, "approve").status).toBe(
      "applied",
    );
    expect(
      db.all("SELECT reason FROM fact_history WHERE fact_id = ? AND action = 'approve'", [
        approved,
      ]),
    ).toEqual([{ reason: "accepted-without-current-evidence" }]);

    remove(mode, a);

    expect(hasFact(approved)).toBe(false); // the value came from the deleted source
    expect(hasItem(x)).toBe(true);
  });

  it("(d) keeps a row approved with no current evidence, verified, while another source's past evidence is left", () => {
    const a = source("a");
    const b = source("b");
    const x = extractedItem("X");
    const approved = extractedFact(x, "2026-12-01", a, b);
    userDecisions.decide(db, { kind: "fact", id: approved }, "approve");

    remove(mode, a);

    expect(db.all("SELECT status, epistemic FROM facts WHERE id = ?", [approved])).toEqual([
      { status: "verified", epistemic: "user-approved" },
    ]);
    expect(listEvidence(db, { factId: approved })).toHaveLength(1);
    expect(hasItem(x)).toBe(true);
    // the propagation did not supersede it: it was approved knowing it had no current evidence (R12 1)
    expect(factLines(approved).map((l) => l.action)).toEqual(["created", "approve"]);
  });

  it("applied twice, the second counts nothing", () => {
    const a = source("a");
    const k = extractedItem("K");
    extractedFact(k, "2026-12-01", a);
    userFact(k, "2026-12-02");
    remove(mode, a);
    const again = remove(mode, a);
    expect(Object.values(again.removed).every((n) => n === 0)).toBe(true);
  });
});

describe("correction.deletion: a new version deletes nothing", () => {
  it("deletes no user row even on an item no source row holds (only a deletion or a prune judges the item)", () => {
    const a = source("a");
    const k = extractedItem("K");
    const written = userFact(k, "2026-12-02");
    cite({ factId: written.id }, a);
    canonicalTransaction(db, (tx) =>
      propagateCanonical(tx, { kind: "new-version", sourceId: a.sourceId, version: 2 }, AT),
    );
    expect(hasItem(k)).toBe(true);
    expect(hasFact(written.id)).toBe(true);
  });

  it("leaves the user's rows and their item when only a version arrives", () => {
    const a = source("a");
    const k = extractedItem("K");
    extractedFact(k, "2026-12-01", a);
    const written = userFact(k, "2026-12-02");
    canonicalTransaction(db, (tx) =>
      propagateCanonical(tx, { kind: "new-version", sourceId: a.sourceId, version: 2 }, AT),
    );
    expect(hasItem(k)).toBe(true);
    expect(hasFact(written.id)).toBe(true);
  });
});
