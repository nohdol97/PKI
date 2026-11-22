// I04-R10 optional part (I04-T12; I04-C3): the user prunes the earlier versions of one source.
// Test: versions.prune. The text only earlier versions held leaves every file of the data
// directory, a fact only past evidence supported is deleted, one the latest version cites stays,
// the latest version stays, and the projections get one removal job each (I04-R12).
// Canaries share no prefix with each other or with any other stored word.
import {
  addEvidence,
  canonicalTransaction,
  insertItem,
  listInvalidations,
  prepareCanonicalDb,
  readChangeSeq,
  readTombstoneState,
  registerConnectorInstance,
  saveFact,
  saveInsight,
  saveSourceRecord,
  searchKeyword,
  type KnowledgeAttributes,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { canariesLeft } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMPLETION_DATE, DEPENDENCY_DELAY } from "./dependency-delay.ts";
import { defaultEntries } from "./entries.ts";
import { applyTombstone } from "./tombstone-entry.ts";

const CANARY = {
  body: "jwxbody", // the latest version's text: stays
  old: "mbvold", // only an earlier version held it
  quote: "pqyquote", // the latest version's evidence quote: stays
  oldQuote: "nzkoldquote", // an earlier version's evidence quote
  shared: "vtsshared", // quoted by evidence on an earlier and on the latest version
  insight: "xfginsight", // the Insight's explanation: only the earlier evidence reached it
  author: "wqpauthor", // provenance of an earlier version (I01-R13)
  title: "hrtoldtitle", // the title of an earlier version, in the keyword index
};
const GONE = [CANARY.old, CANARY.oldQuote, CANARY.insight, CANARY.author, CANARY.title];
const KEPT = [CANARY.body, CANARY.quote, CANARY.shared];
const AT = "2026-11-22T00:00:00.000Z";
const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
};
const IDENTITY = { connectorInstanceId: "c1", namespace: "n", externalId: "doc" };

let dir: string;
let db: SqlDriver;
const open = (): SqlDriver => {
  const opened = openBetterSqlite3(join(dir, "pki.sqlite"));
  prepareCanonicalDb(opened);
  return opened;
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-prune-"));
  db = open();
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const V1 = `값 ${CANARY.old} 그리고 ${CANARY.oldQuote} 그리고 ${CANARY.shared} 입니다`;
const V2 = `중간 판 ${CANARY.shared} 입니다`;
const V3 = `이제 ${CANARY.body} 와 ${CANARY.quote} 그리고 ${CANARY.shared} 입니다`;

function save(body: string, extra: { title?: string; author?: string } = {}) {
  const saved = saveSourceRecord(db, "c1", {
    namespace: "n",
    externalId: "doc",
    title: extra.title ?? "제목",
    body,
    ...(extra.author ? { provenance: { author: extra.author } } : {}),
  });
  if (saved.status !== "created") throw new Error(saved.status);
  return saved.sourceId;
}
const versionId = (sourceId: number, v: number) =>
  db.all("SELECT id FROM source_versions WHERE source_id = ? AND version = ?", [sourceId, v])[0]
    ?.id as number;
const cite = (factId: number, sourceId: number, v: number, body: string, quote: string) => {
  const start = body.indexOf(quote);
  return addEvidence(db, {
    target: { factId },
    sourceVersionId: versionId(sourceId, v),
    start,
    end: start + quote.length,
    quote,
  });
};

/**
 * One source with three versions. Facts: `onlyOld` (version 1 evidence only), `both` (version 1
 * and the latest), `onlyLatest`, and an Insight explained by the item of `onlyOld`.
 */
function seed() {
  save(V1, { title: CANARY.title, author: CANARY.author });
  save(V2);
  const sourceId = save(V3);
  const x = insertItem(db, { type: "Project", name: "X 항목", ...attrs });
  const y = insertItem(db, { type: "System", name: "Y 항목", ...attrs });
  const fact = (itemId: number, value: string) =>
    saveFact(db, { itemId, kind: COMPLETION_DATE, value, ...attrs }).id;
  const onlyOld = fact(x, "2026-12-10");
  const both = fact(y, "2026-12-12");
  const onlyLatest = fact(y, "2026-12-13");
  const evidenceOld = cite(onlyOld, sourceId, 1, V1, CANARY.oldQuote);
  cite(both, sourceId, 1, V1, CANARY.shared);
  cite(both, sourceId, 3, V3, CANARY.shared);
  cite(onlyLatest, sourceId, 3, V3, CANARY.quote);
  saveInsight(
    db,
    { rule: DEPENDENCY_DELAY, xItemId: x, yItemId: y },
    {
      state: "active",
      summary: `${CANARY.insight} 지연`,
      evidenceIds: [evidenceOld],
    },
  );
  return { sourceId, x, y, onlyOld, both, onlyLatest };
}
const prune = (identity = IDENTITY, at = AT) => defaultEntries.pruneVersions(db, identity, at);
const versions = () =>
  db.all("SELECT version FROM source_versions ORDER BY version").map((r) => r.version);
const ids = (table: string) => db.all(`SELECT id FROM ${table} ORDER BY id`).map((r) => r.id);
const residue = (words: string[]) => {
  db.close();
  const left = canariesLeft(dir, words);
  db = open();
  return left;
};

describe("versions.prune", () => {
  it("every canary is in the files before the prune (else the checks below prove nothing)", () => {
    seed();
    expect(residue([...GONE, ...KEPT]).sort()).toEqual([...GONE, ...KEPT].sort());
  });

  it("deletes the earlier versions and leaves no text only they held in any file", () => {
    const { sourceId } = seed();
    expect(prune()).toEqual({ outcome: "pruned", sourceId, keptVersion: 3, prunedVersions: 2 });
    expect(versions()).toEqual([3]);
    expect(residue(GONE)).toEqual([]);
    expect(residue(KEPT).sort()).toEqual([...KEPT].sort());
    expect(searchKeyword(db, CANARY.title)).toEqual([]);
    expect(searchKeyword(db, CANARY.body)).toHaveLength(1);
  });

  it("deletes a fact only the pruned evidence supported and keeps one the latest version cites", () => {
    const { onlyOld, both, onlyLatest, x } = seed();
    prune();
    expect(ids("facts")).toEqual([both, onlyLatest]);
    expect(ids("facts")).not.toContain(onlyOld);
    // the evidence on the earlier versions went with them: the shared fact keeps its latest one
    expect(
      db.all("SELECT quote FROM evidence WHERE fact_id = ?", [both]).map((r) => r.quote),
    ).toEqual([CANARY.shared]);
    // the item that only the deleted fact held goes too, and its Insight with it
    expect(ids("items")).not.toContain(x);
    expect(db.all("SELECT count(*) AS n FROM insights")[0]?.n).toBe(0);
  });

  it("records one invalidation of kind old-versions-pruned with its counts and no tombstone", () => {
    const { sourceId } = seed();
    const before = listInvalidations(db).length;
    prune();
    const [record, ...rest] = listInvalidations(db);
    expect(rest).toHaveLength(before);
    expect(record).toMatchObject({ sourceId, changeKind: "old-versions-pruned" });
    expect(record?.removedByKind).toMatchObject({ source: 2, fact: 1, item: 1 });
    expect(readTombstoneState(db, sourceId)).toBeUndefined();
  });

  it("registers one removal job per projection for the pruned versions only, after raising the change sequence", () => {
    const { sourceId } = seed();
    const seq = readChangeSeq(db);
    prune();
    const jobs = db.all(
      `SELECT target, fence_version AS cover, priority, registered_change_seq AS seq
       FROM jobs WHERE kind = 'projection-remove' ORDER BY target`,
    );
    expect(jobs).toEqual([
      { target: "engine", cover: 2, priority: "user", seq: seq + 1 },
      { target: "vectorIndex", cover: 2, priority: "user", seq: seq + 1 },
    ]);
    expect(readChangeSeq(db)).toBe(seq + 1);
    expect(
      db.all("SELECT DISTINCT source_id AS s FROM jobs WHERE kind = 'projection-remove'"),
    ).toEqual([{ s: sourceId }]);
  });

  it("deletes the scope-policy records of the pruned versions and keeps the latest version's", () => {
    const { sourceId } = seed();
    for (const version of [1, 2, 3]) {
      db.run(
        `INSERT INTO scope_policy_drops (source_id, version, kind, item_key_hash, reason, at)
         VALUES (?, ?, 'fact', ?, 'scope-policy', ?)`,
        [sourceId, version, `hash-${version}`, AT],
      );
    }
    prune();
    expect(db.all("SELECT version FROM scope_policy_drops").map((r) => r.version)).toEqual([3]);
  });

  it("deletes a user-rejected fact whose only evidence was pruned; a later version restating it brings it back as a candidate (decision 4)", () => {
    const { sourceId, y } = seed();
    const rejected = saveFact(db, {
      itemId: y,
      kind: COMPLETION_DATE,
      value: "2026-12-20",
      ...attrs,
      status: "rejected",
    }).id;
    cite(rejected, sourceId, 1, V1, CANARY.old);
    prune();
    expect(ids("facts")).not.toContain(rejected);
    const again = saveFact(db, {
      itemId: y,
      kind: COMPLETION_DATE,
      value: "2026-12-20",
      ...attrs,
    });
    expect(again.created).toBe(true);
    expect(
      db.all("SELECT status FROM facts WHERE id = ?", [again.id]).map((r) => r.status),
    ).toEqual(["candidate"]);
  });

  it("keeps a fact another source's evidence supports, and supersedes one that is left with past evidence only", () => {
    const { sourceId, y } = seed();
    const other = (body: string) => {
      const saved = saveSourceRecord(db, "c1", {
        namespace: "n",
        externalId: "other",
        title: "다른 원본",
        body,
      });
      if (saved.status !== "created") throw new Error(saved.status);
      return saved.sourceId;
    };
    const bId = other("다른 원본 첫 판 zqkfirst");
    other("다른 원본 둘째 판");
    const supported = saveFact(db, {
      itemId: y,
      kind: COMPLETION_DATE,
      value: "2026-12-14",
      ...attrs,
    }).id;
    cite(supported, sourceId, 1, V1, CANARY.old);
    cite(supported, bId, 2, "다른 원본 둘째 판", "둘째");
    const pastOnly = saveFact(db, {
      itemId: y,
      kind: COMPLETION_DATE,
      value: "2026-12-15",
      ...attrs,
    }).id;
    cite(pastOnly, sourceId, 1, V1, CANARY.oldQuote);
    cite(pastOnly, bId, 1, "다른 원본 첫 판 zqkfirst", "zqkfirst");
    prune();
    const status = (id: number) =>
      db.all("SELECT status FROM facts WHERE id = ?", [id]).map((r) => r.status);
    expect(status(supported)).toEqual(["candidate"]);
    expect(status(pastOnly)).toEqual(["superseded"]);
    // the history line rests on the version the prune kept, a number and no text (S01-R6)
    expect(
      db.all("SELECT actor, basis_source_id, basis_version FROM fact_history WHERE fact_id = ?", [
        pastOnly,
      ]),
    ).toEqual([{ actor: "propagation", basis_source_id: sourceId, basis_version: 3 }]);
    expect(db.all("SELECT count(*) AS n FROM fact_history WHERE fact_id = ?", [supported])).toEqual(
      [{ n: 0 }],
    );
    expect(db.all("SELECT count(*) AS n FROM evidence WHERE fact_id = ?", [supported])[0]?.n).toBe(
      1,
    );
    expect(db.all("SELECT count(*) AS n FROM evidence WHERE fact_id = ?", [pastOnly])[0]?.n).toBe(
      1,
    );
  });

  it("keeps numbering above the pruned versions: the next version is 4", () => {
    seed();
    prune();
    const next = saveSourceRecord(db, "c1", {
      namespace: "n",
      externalId: "doc",
      title: "t",
      body: "또 다른 내용",
    });
    expect(next).toMatchObject({ status: "created", version: 4 });
  });

  it("is idempotent: the repeat changes and records nothing", () => {
    const { sourceId } = seed();
    prune();
    const seq = readChangeSeq(db);
    const records = listInvalidations(db).length;
    const jobs = ids("jobs");
    expect(prune()).toEqual({ outcome: "unchanged", sourceId, keptVersion: 3, prunedVersions: 0 });
    expect(readChangeSeq(db)).toBe(seq);
    expect(listInvalidations(db)).toHaveLength(records);
    expect(ids("jobs")).toEqual(jobs);
  });

  it("answers unchanged for a source with a single version, touching nothing", () => {
    const sourceId = save(V3);
    const seq = readChangeSeq(db);
    expect(prune()).toEqual({ outcome: "unchanged", sourceId, keptVersion: 1, prunedVersions: 0 });
    expect(versions()).toEqual([1]);
    expect(readChangeSeq(db)).toBe(seq);
    expect(listInvalidations(db)).toEqual([]);
  });

  it("answers not-found for an unknown source", () => {
    seed();
    expect(prune({ ...IDENTITY, externalId: "nobody" })).toEqual({ outcome: "not-found" });
    expect(prune({ ...IDENTITY, connectorInstanceId: "c2" })).toEqual({ outcome: "not-found" });
    expect(versions()).toEqual([1, 2, 3]);
  });

  it("answers not-found for a tombstoned source and leaves the tombstone as it was", () => {
    const { sourceId } = seed();
    canonicalTransaction(db, (tx) =>
      applyTombstone(tx, {
        identity: IDENTITY,
        reason: "user-deleted",
        lastRevision: null,
        at: AT,
      }),
    );
    const state = readTombstoneState(db, sourceId);
    const records = listInvalidations(db).length;
    expect(prune()).toEqual({ outcome: "not-found" });
    expect(readTombstoneState(db, sourceId)).toEqual(state);
    expect(listInvalidations(db)).toHaveLength(records);
  });

  it("rolls the whole prune back when a step fails: versions, facts and records stay", () => {
    seed();
    db.exec(
      "CREATE TRIGGER fail_prune BEFORE DELETE ON facts BEGIN SELECT RAISE(ABORT, 'forced'); END",
    );
    expect(() => prune()).toThrow(/forced/);
    expect(versions()).toEqual([1, 2, 3]);
    expect(ids("facts")).toHaveLength(3);
    expect(listInvalidations(db)).toEqual([]);
    expect(ids("jobs").length).toBe(0);
  });
});
