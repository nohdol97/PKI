// A source's deletion or access revocation (V02-R12) in one transaction: a
// content-free tombstone covering every product version, the purge of all its
// versions and what they alone supported, and the rule recomputed over the
// collected items that remain. It never propagates as a new version would.
import {
  addEvidence,
  insertItem,
  listInvalidations,
  migrate,
  readChangeSeq,
  readInsight,
  readTombstone,
  registerConnectorInstance,
  registerJob,
  saveFact,
  saveRelation,
  saveSourceRecord,
  type KnowledgeAttributes,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteSource } from "./deletion.ts";
import { propagateNewVersion } from "./propagation.ts";
import {
  COMPLETION_DATE,
  DEPENDENCY_DELAY,
  DEPENDS_ON,
  TARGET_DATE,
  recomputeDependencyDelay,
} from "./dependency-delay.ts";

const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
};
const AT = "2026-11-22T00:00:00.000Z";

let db: SqlDriver;
let x: number;
let y: number;

beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
  x = insertItem(db, { type: "Project", name: "미리내 프로젝트", ...attrs });
  y = insertItem(db, { type: "System", name: "물결 API", ...attrs });
});
afterEach(() => db.close());

function version(externalId: string, body: string) {
  const saved = saveSourceRecord(db, "c1", { externalId, title: externalId, body });
  if (saved.status !== "created") throw new Error(saved.status);
  const id = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
  return { sourceId: saved.sourceId, id };
}
const cite = (target: { factId: number } | { relationId: number }, sv: number, body: string) =>
  addEvidence(db, { target, sourceVersionId: sv, start: 0, end: [...body].length, quote: body });

/** X targets 12-05 (mail), X depends on Y (wiki), Y completes 12-10 (chat): one active Insight. */
function lateDependency() {
  const mail = version("mail", "목표 12-05");
  const target = saveFact(db, { itemId: x, kind: TARGET_DATE, value: "2026-12-05", ...attrs }).id;
  cite({ factId: target }, mail.id, "목표 12-05");
  const wiki = version("wiki", "X는 Y에 의존");
  const relation = saveRelation(db, { subjectId: x, type: DEPENDS_ON, objectId: y, ...attrs }).id;
  cite({ relationId: relation }, wiki.id, "X는 Y에 의존");
  const chat = version("chat", "완료 12-10");
  const late = saveFact(db, { itemId: y, kind: COMPLETION_DATE, value: "2026-12-10", ...attrs }).id;
  cite({ factId: late }, chat.id, "완료 12-10");
  recomputeDependencyDelay(db, [x, y]);
  return { mail, wiki, chat, target, relation, late };
}
const key = () => ({ rule: DEPENDENCY_DELAY, xItemId: x, yItemId: y });

describe("deleteSource", () => {
  it("writes a tombstone at the latest product version with its reason and raises the sequence once", () => {
    const { chat } = lateDependency();
    version("chat", "완료 12-12");
    const seq = readChangeSeq(db);

    const result = deleteSource(db, chat.sourceId, { reason: "source-deleted", at: AT });

    expect(result).toMatchObject({ outcome: "deleted", version: 2 });
    expect(readTombstone(db, chat.sourceId)).toEqual({
      sourceId: chat.sourceId,
      version: 2,
      at: AT,
      reason: "source-deleted",
    });
    expect(readChangeSeq(db)).toBe(seq + 1);
    expect(db.all("SELECT 1 FROM source_versions WHERE source_id = ?", [chat.sourceId])).toEqual(
      [],
    );
  });

  it("resolves and empties the Insight in its row when the dependency's source goes, keeping X and Y", () => {
    const { wiki, relation } = lateDependency();
    const before = readInsight(db, key());
    expect(before?.state).toBe("active");

    const result = deleteSource(db, wiki.sourceId, { reason: "user-deleted", at: AT });

    expect(result).toMatchObject({
      outcome: "deleted",
      purge: { relations: [relation], items: [], remainingItemIds: [x, y] },
      insights: [{ key: key(), outcome: "resolved" }],
    });
    expect(readInsight(db, key())).toMatchObject({
      id: before?.id,
      state: "resolved",
      summary: null,
      evidenceIds: [],
    });
  });

  it("deletes the Insight row with its item when an item loses all its knowledge", () => {
    const { chat } = lateDependency();
    // Y keeps the wiki relation; a third item only the chat names goes with it
    const z = insertItem(db, { type: "System", name: "Z", ...attrs });
    const zFact = saveFact(db, { itemId: z, kind: COMPLETION_DATE, value: "2026-12-11", ...attrs });
    cite({ factId: zFact.id }, chat.id, "완료 12-10");
    const zRelation = saveRelation(db, { subjectId: x, type: DEPENDS_ON, objectId: z, ...attrs });
    cite({ relationId: zRelation.id }, chat.id, "완료 12-10");
    recomputeDependencyDelay(db, [x, z]);
    expect(readInsight(db, { ...key(), yItemId: z })?.state).toBe("active");

    deleteSource(db, chat.sourceId, { reason: "access-revoked", at: AT });

    expect(readInsight(db, { ...key(), yItemId: z })).toBeUndefined();
    expect(db.all("SELECT id FROM items WHERE id = ?", [z])).toEqual([]);
    expect(readInsight(db, key())?.state).toBe("resolved");
  });

  it("judges an Insight other sources keep valid again, without the purged evidence", () => {
    const { chat, late } = lateDependency();
    const other = version("chat-copy", "완료 12-10");
    const kept = cite({ factId: late }, other.id, "완료 12-10");
    recomputeDependencyDelay(db, [x, y]);
    const before = readInsight(db, key());

    const result = deleteSource(db, chat.sourceId, { reason: "source-deleted", at: AT });

    // the evidence link went with the purged evidence (cascade); the rule finds
    // the rest as it wants it, so the row is judged and left as it is
    expect(result.outcome === "deleted" && result.insights).toEqual([
      { key: key(), outcome: "unchanged" },
    ]);
    const after = readInsight(db, key());
    expect(after).toMatchObject({ id: before?.id, state: "active" });
    expect(after?.evidenceIds).toContain(kept);
    expect(after?.evidenceIds).toHaveLength(3);
  });

  it("changes nothing for a source already purged", () => {
    const { chat } = lateDependency();
    deleteSource(db, chat.sourceId, { reason: "source-deleted", at: AT });
    const seq = readChangeSeq(db);
    expect(deleteSource(db, chat.sourceId, { reason: "user-deleted", at: "later" })).toEqual({
      outcome: "unchanged",
    });
    expect(readChangeSeq(db)).toBe(seq);
    expect(readTombstone(db, chat.sourceId)).toMatchObject({ at: AT, reason: "source-deleted" });
  });

  it("rolls everything back when a step fails, the tombstone included", () => {
    const { chat } = lateDependency();
    db.exec(`CREATE TEMP TRIGGER fail_resolve BEFORE UPDATE ON insights
             BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    const seq = readChangeSeq(db);
    expect(() => deleteSource(db, chat.sourceId, { reason: "source-deleted", at: AT })).toThrow(
      /injected/,
    );
    expect(readTombstone(db, chat.sourceId)).toBeUndefined();
    expect(readChangeSeq(db)).toBe(seq);
    expect(db.all("SELECT count(*) AS n FROM source_versions")).toEqual([{ n: 3 }]);
    expect(readInsight(db, key())?.state).toBe("active");
  });

  it("supersedes a row left with only past evidence of another source, as a new version would (review A-S1)", () => {
    // F is cited by B v1 and A v1; B moves to v2 (F stays valid through A); then A goes
    const f = saveFact(db, { itemId: y, kind: COMPLETION_DATE, value: "2026-12-10", ...attrs }).id;
    const b1 = version("b", "완료 12-10");
    cite({ factId: f }, b1.id, "완료 12-10");
    const a1 = version("a", "완료 12-10");
    cite({ factId: f }, a1.id, "완료 12-10");
    const r = saveRelation(db, { subjectId: x, type: DEPENDS_ON, objectId: y, ...attrs }).id;
    cite({ relationId: r }, b1.id, "완료 12-10");
    cite({ relationId: r }, a1.id, "완료 12-10");
    const rejected = saveFact(db, {
      itemId: y,
      kind: TARGET_DATE,
      value: "2026-12-01",
      ...attrs,
    }).id;
    cite({ factId: rejected }, b1.id, "완료 12-10");
    cite({ factId: rejected }, a1.id, "완료 12-10");
    db.run("UPDATE facts SET status = 'rejected' WHERE id = ?", [rejected]);
    version("b", "완료 12-12");
    propagateNewVersion(db, b1.sourceId);
    expect(db.all("SELECT status FROM facts WHERE id = ?", [f])).toEqual([{ status: "candidate" }]);

    const result = deleteSource(db, a1.sourceId, { reason: "source-deleted", at: AT });

    expect(result).toMatchObject({ purge: { superseded: { facts: [f], relations: [r] } } });
    expect(db.all("SELECT id, status FROM facts ORDER BY id")).toEqual([
      { id: f, status: "superseded" },
      { id: rejected, status: "rejected" },
    ]);
    expect(db.all("SELECT status FROM relations WHERE id = ?", [r])).toEqual([
      { status: "superseded" },
    ]);
  });

  it("keeps the status of a row another source's current evidence supports", () => {
    const { chat, late } = lateDependency();
    const other = version("chat-copy", "완료 12-10");
    cite({ factId: late }, other.id, "완료 12-10");
    deleteSource(db, chat.sourceId, { reason: "source-deleted", at: AT });
    expect(db.all("SELECT status FROM facts WHERE id = ?", [late])).toEqual([
      { status: "candidate" },
    ]);
  });
});

describe("purge.idempotent: the purge closes the source's open jobs (I04-R12)", () => {
  it("supersedes every open job of the source in the purge's transaction, but no projection job, dead letter or other source's job", () => {
    const { chat, mail } = lateDependency();
    const job = (kind: string, target: string, sourceId = chat.sourceId) => {
      const r = registerJob(db, { kind, target, sourceId, fenceVersion: 1 });
      if (!r.registered) throw new Error("not registered");
      return r.job.id;
    };
    const set = (id: number, status: string) =>
      db.run("UPDATE jobs SET status = ? WHERE id = ?", [status, id]);
    const queued = job("extract", "q");
    const running = job("extract", "r");
    set(running, "running");
    const retry = job("extract", "t");
    set(retry, "retry");
    const held = job("extract", "h");
    set(held, "held");
    const dead = job("extract", "d");
    set(dead, "dead_letter");
    const remove = job("projection-remove", "engine");
    const otherSource = job("extract", "q", mail.sourceId);
    const tokens = () =>
      Object.fromEntries(
        db.all("SELECT id, lease_token FROM jobs").map((r) => [r.id as number, r.lease_token]),
      );
    const before = tokens();

    deleteSource(db, chat.sourceId, { reason: "source-deleted", at: AT });

    const rows = db.all("SELECT id, status, reason FROM jobs ORDER BY id");
    expect(rows).toEqual([
      { id: queued, status: "superseded", reason: "source-closed" },
      { id: running, status: "superseded", reason: "source-closed" },
      { id: retry, status: "superseded", reason: "source-closed" },
      { id: held, status: "superseded", reason: "source-closed" },
      { id: dead, status: "dead_letter", reason: null },
      { id: remove, status: "queued", reason: null },
      { id: otherSource, status: "queued", reason: null },
    ]);
    // a running job's holder loses its lease: its heartbeat and result write fail
    expect(tokens()[running]).toBe((before[running] as number) + 1);
  });

  it("changes nothing the second time: sequence, rows, records and jobs as they were", () => {
    const { chat } = lateDependency();
    deleteSource(db, chat.sourceId, { reason: "source-deleted", at: AT });
    const r = registerJob(db, {
      kind: "extract",
      target: "late",
      sourceId: chat.sourceId,
      fenceVersion: 1,
    });
    expect(r.registered).toBe(true);
    const snapshot = () => ({
      seq: readChangeSeq(db),
      rows: ["source_versions", "evidence", "facts", "relations", "items", "insights"].map(
        (t) => db.all(`SELECT count(*) AS n FROM ${t}`)[0]?.n,
      ),
      records: listInvalidations(db),
      jobs: db.all("SELECT id, status, reason, lease_token FROM jobs ORDER BY id"),
    });
    const before = snapshot();

    expect(deleteSource(db, chat.sourceId, { reason: "source-deleted", at: AT })).toEqual({
      outcome: "unchanged",
    });

    expect(snapshot()).toEqual(before);
  });
});
