// S03-T05 collection for the judgement (S03-R12, R16, R17): the relations waiting on a propagation, the
// check-needing facts a table source's loss or change touches (found by relations, never by check lines), and
// the rows a split took off a table (read from the split record only). The judgement itself is S03-T06's.
// All data is synthetic.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import {
  dataset,
  fact,
  item,
  line,
  relation,
  storeVersion,
  type Stored,
} from "./analytical-check-lines.test-support.ts";
import { claimCandidates, splitMovedClaims, waitingRelations } from "./analytical-check-lines.ts";
import { addEvidence } from "./knowledge.ts";
import { migrate } from "./migrations.ts";
import { applyTransition, automatedLifecycle } from "./semantic-lifecycle.ts";
import { userDecisions } from "./semantic-user.ts";
import { registerConnectorInstance } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";
import { memoryDbTemplate } from "@pki/testkit";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);

let db: SqlDriver;
beforeEach(() => {
  db = freshDb();
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

const AT = "2026-11-23T01:02:03.000Z";
const rel = (id: number) => ({ kind: "relation", id }) as const;
const supersedeBy = (relationId: number, basis: { sourceId: number; version: number }) =>
  applyTransition(db, rel(relationId), "propagation", "superseded", { basis, at: AT });
const ref = (s: Stored) => ({ sourceId: s.sourceId, version: s.version });
const ids = (list: readonly { factId: number }[]) => list.map((c) => c.factId);

/** A (table) with Dataset d and a Metric on it; B (table) with d2; a Join d-d2 the Metric uses. */
function scene() {
  const a = storeVersion(db, "a");
  const b = storeVersion(db, "b");
  const d = dataset(db, "d", a.sourceId);
  const d2 = dataset(db, "d2", b.sourceId);
  const grain = fact(db, d, "dataset.grain", '["x"]', "verified");
  const column = fact(db, d, "dataset.column", "x");
  const metric = item(db, "Metric", "m");
  const calc = fact(db, metric, "metric.calculation", '{"aggregation":"count"}', "verified");
  const unit = fact(db, metric, "metric.unit", "won", "verified");
  const join = item(db, "Join", "j");
  const keys = fact(db, join, "join.keys", '[["x","x"]]', "verified");
  const cardinality = fact(db, join, "join.cardinality", "many-to-one", "verified");
  const measuredOn = relation(db, metric, "MEASURED_ON", d);
  relation(db, metric, "USES_JOIN", join);
  relation(db, join, "JOIN_LEFT", d);
  relation(db, join, "JOIN_RIGHT", d2);
  return { a, b, d, d2, grain, column, metric, calc, unit, join, keys, cardinality, measuredOn };
}

describe("waitingRelations", () => {
  it("waiting relation: superseded, last history line the propagation's supersede, basis source uncovered; a covered basis source, a user's reject, or a later line is not waiting", () => {
    const s = scene();
    const doc = storeVersion(db, "doc", false);
    const m = (name: string) => item(db, "Metric", name);
    const waiting = relation(db, m("m1"), "MEASURED_ON", s.d);
    const covered = relation(db, m("m2"), "MEASURED_ON", s.d);
    const rejected = relation(db, m("m3"), "MEASURED_ON", s.d);
    const back = relation(db, m("m4"), "MEASURED_ON", s.d);
    supersedeBy(waiting, ref(doc));
    supersedeBy(covered, ref(s.b));
    db.run(
      "INSERT INTO tombstones (source_id, covers_version, at, reason) VALUES (?, ?, 't', 'user-deleted')",
      [s.b.sourceId, s.b.version],
    );
    userDecisions.decide(db, rel(rejected), "reject", AT);
    supersedeBy(back, ref(doc));
    automatedLifecycle.evidenceReturned(db, rel(back), ref(doc), AT); // a later line: not superseded
    expect(waitingRelations(db)).toEqual([{ relationId: waiting, sourceId: doc.sourceId }]);
  });
});

describe("claimCandidates", () => {
  it("claims of a table source: the check-needing facts of its Datasets, of the Metrics and Joins on them and of the Metrics using those Joins, through live and waiting relations; a rejected relation is not followed", () => {
    const s = scene();
    const doc = storeVersion(db, "doc", false);
    const viaRejected = item(db, "Metric", "rej");
    const rejectedCalc = fact(db, viaRejected, "metric.calculation", '{"aggregation":"count"}');
    relation(db, viaRejected, "MEASURED_ON", s.d, "rejected");
    const viaWaiting = item(db, "Metric", "wait");
    const waitingCalc = fact(db, viaWaiting, "metric.calculation", '{"aggregation":"count"}');
    supersedeBy(relation(db, viaWaiting, "MEASURED_ON", s.d), ref(doc));
    const found = claimCandidates(db, { sourceId: s.a.sourceId, mode: "deletion" });
    expect(ids(found).sort((x, y) => x - y)).toEqual(
      [s.grain, s.calc, s.keys, s.cardinality, waitingCalc].sort((x, y) => x - y),
    );
    expect(ids(found)).not.toContain(rejectedCalc);
    // the basis: the table sources the fact's item reached, with their current versions, ascending
    const calc = found.find((c) => c.factId === s.calc);
    expect(calc?.basis).toEqual([ref(s.a), ref(s.b)]);
    expect(found.find((c) => c.factId === s.grain)?.basis).toEqual([ref(s.a)]);
  });

  it("claims of a table source are found with no check line stored and with stale lines", () => {
    const s = scene();
    const before = ids(claimCandidates(db, { sourceId: s.a.sourceId, mode: "deletion" }));
    line(db, s.calc, "schema", s.a.versionId);
    storeVersion(db, "a"); // a new version of the table: the line is stale
    expect(ids(claimCandidates(db, { sourceId: s.a.sourceId, mode: "deletion" }))).toEqual(before);
    expect(before).toContain(s.calc);
  });

  it("claims of a non-table source: facts of items whose path relation (live or superseded) has evidence on that source — below the kept version for a prune — and of items with a path relation waiting on it", () => {
    const s = scene();
    const doc = storeVersion(db, "doc", false);
    const doc2 = storeVersion(db, "doc", false);
    // ㉮ the Metric's MEASURED_ON is cited by version 1 of the document
    addEvidence(db, {
      target: { relationId: s.measuredOn },
      sourceVersionId: doc.versionId,
      start: 0,
      end: 1,
      quote: "a",
    });
    expect(ids(claimCandidates(db, { sourceId: doc.sourceId, mode: "deletion" }))).toEqual([
      s.calc,
    ]);
    expect(
      ids(
        claimCandidates(db, { sourceId: doc.sourceId, mode: "pruned", keptVersion: doc2.version }),
      ),
    ).toEqual([s.calc]);
    // evidence on the kept version is not below it
    expect(
      ids(
        claimCandidates(db, { sourceId: doc.sourceId, mode: "pruned", keptVersion: doc.version }),
      ),
    ).toEqual([]);
    // ㉯ a path relation waiting on the source
    const other = item(db, "Metric", "other");
    const otherCalc = fact(db, other, "metric.calculation", '{"aggregation":"count"}');
    supersedeBy(relation(db, other, "MEASURED_ON", s.d), ref(doc2));
    expect(ids(claimCandidates(db, { sourceId: doc.sourceId, mode: "deletion" }))).toEqual([
      s.calc,
      otherCalc,
    ]);
    // a non-table source has no table rows to reach
    expect(
      claimCandidates(db, { sourceId: doc.sourceId, mode: "deletion" }).find(
        (c) => c.factId === s.grain,
      ),
    ).toBeUndefined();
  });
});

describe("splitMovedClaims", () => {
  const split = (owner: number, rows: { kind: "fact" | "relation"; id: number }[]) => {
    const done = db.transaction(() => userDecisions.entities.split(db, owner, rows, "moved", AT));
    if (done.status !== "applied") throw new Error(done.reason);
    return done.created;
  };

  it("split record: the verified check-needing facts of the original and new items of the moves that touch the source — ㉮ a moved relation whose object touches it ㉯ a moved check-needing fact whose original item touches it; a move of another fact gives none", () => {
    const s = scene();
    split(s.metric, [{ kind: "fact", id: s.unit }]); // another fact: not a claim
    expect(splitMovedClaims(db, s.a.sourceId)).toEqual([]);
    split(s.metric, [{ kind: "relation", id: s.measuredOn }]); // ㉮ the Metric's way to d moved away
    expect(splitMovedClaims(db, s.a.sourceId)).toEqual([s.calc]);
    expect(splitMovedClaims(db, s.b.sourceId)).toEqual([]); // the moved relation's object is d, not on b
    const unrelated = storeVersion(db, "unrelated");
    expect(splitMovedClaims(db, unrelated.sourceId)).toEqual([]);
  });

  it("split record: a moved check-needing fact whose original item touches the source is ㉯", () => {
    const s = scene();
    const created = split(s.metric, [{ kind: "fact", id: s.calc }]);
    expect(created).toBeGreaterThan(0);
    expect(splitMovedClaims(db, s.a.sourceId)).toEqual([s.calc]);
  });

  it("split record is only read: item_split_moves is the same before and after", () => {
    const s = scene();
    split(s.metric, [{ kind: "relation", id: s.measuredOn }]);
    const before = db.all("SELECT * FROM item_split_moves ORDER BY id");
    claimCandidates(db, { sourceId: s.a.sourceId, mode: "deletion" });
    splitMovedClaims(db, s.a.sourceId);
    expect(db.all("SELECT * FROM item_split_moves ORDER BY id")).toEqual(before);
    expect(before.length).toBeGreaterThan(0);
  });
});
