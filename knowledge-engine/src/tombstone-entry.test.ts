// The tombstone entries (I04-R9, R12; I04-C2): applyTombstone finds the source by
// its identity, sets the cover itself, and on every outcome that changes the
// tombstone closes the source's open jobs and propagates once, in the caller's
// canonical transaction. liftTombstone only marks the tombstone lifted.
import {
  addEvidence,
  canonicalTransaction,
  findSourceId,
  insertItem,
  listInvalidations,
  migrate,
  readChangeSeq,
  readJob,
  readTombstoneState,
  registerConnectorInstance,
  registerJob,
  saveFact,
  saveSourceRecord,
  type KnowledgeAttributes,
  type SqlDriver,
  type TombstoneReason,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMPLETION_DATE, TARGET_DATE } from "./dependency-delay.ts";
import { applyTombstone, liftTombstone } from "./tombstone-entry.ts";

const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
};
const AT = "2026-11-22T00:00:00.000Z";
const LATER = "2026-11-23T00:00:00.000Z";
const AGAIN = "2026-11-24T00:00:00.000Z";

let db: SqlDriver;
let item: number;
/** The source the tests delete: two versions, each citing a fact of its own. */
let chat: number;
/** Another source, never deleted. */
let mail: number;

function version(externalId: string, body: string) {
  const saved = saveSourceRecord(db, "c1", { namespace: "n", externalId, title: externalId, body });
  if (saved.status !== "created") throw new Error(saved.status);
  const id = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
  return { sourceId: saved.sourceId, id };
}
function fact(kind: string, value: string, sourceVersionId: number, body: string) {
  const id = saveFact(db, { itemId: item, kind, value, ...attrs }).id;
  addEvidence(db, {
    target: { factId: id },
    sourceVersionId,
    start: 0,
    end: [...body].length,
    quote: body,
  });
}

beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
  item = insertItem(db, { type: "Project", name: "미리내 프로젝트", ...attrs });
  const kept = version("mail", "목표 12-05");
  mail = kept.sourceId;
  fact(TARGET_DATE, "2026-12-05", kept.id, "목표 12-05");
  const first = version("chat", "완료 12-10");
  chat = first.sourceId;
  fact(COMPLETION_DATE, "2026-12-10", first.id, "완료 12-10");
  const second = version("chat", "완료 12-12");
  fact(COMPLETION_DATE, "2026-12-12", second.id, "완료 12-12");
});
afterEach(() => db.close());

const identity = (externalId = "chat") => ({
  connectorInstanceId: "c1",
  namespace: "n",
  externalId,
});
const apply = (
  reason: TombstoneReason,
  lastRevision: number | null,
  at = AT,
  externalId = "chat",
) =>
  canonicalTransaction(db, (tx) =>
    applyTombstone(tx, { identity: identity(externalId), reason, lastRevision, at }),
  );
const lift = (sourceId: number, at = LATER) =>
  canonicalTransaction(db, (tx) => liftTombstone(tx, sourceId, at));
const count = (table: string) => db.all(`SELECT count(*) AS n FROM ${table}`)[0]?.n as number;
const TABLES = [
  "sources",
  "source_versions",
  "evidence",
  "facts",
  "relations",
  "items",
  "insights",
  "tombstones",
  "jobs",
  "invalidations",
];
/** Everything a second, equal deletion must leave as it is. */
const snapshot = () => ({
  seq: readChangeSeq(db),
  rows: Object.fromEntries(TABLES.map((t) => [t, count(t)])),
  tombstones: db.all("SELECT * FROM tombstones ORDER BY source_id"),
  invalidations: db.all("SELECT * FROM invalidations ORDER BY id"),
  jobs: db.all("SELECT id, status, reason, lease_token, updated_at FROM jobs ORDER BY id"),
});

describe("tombstone.rules: applyTombstone", () => {
  it("covers the source's latest version, purges it and propagates once, the caller propagating nothing", () => {
    const seq = readChangeSeq(db);

    expect(apply("source-deleted", 7)).toEqual({
      outcome: "created",
      sourceId: chat,
      coversVersion: 2,
    });

    expect(readTombstoneState(db, chat)).toEqual({
      sourceId: chat,
      coversVersion: 2,
      lastRevision: 7,
      reason: "source-deleted",
      at: AT,
      liftedAt: null,
    });
    expect(readChangeSeq(db)).toBe(seq + 1);
    expect(db.all("SELECT source_id FROM source_versions")).toEqual([{ source_id: mail }]);
    expect(db.all("SELECT value FROM facts")).toEqual([{ value: "2026-12-05" }]);
    const records = listInvalidations(db).filter((r) => r.sourceId === chat);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      changeKind: "source-deleted",
      changeSeq: seq + 1,
      at: AT,
      removedByKind: { source: 2, evidence: 2, fact: 2 },
    });
  });

  it("propagates once for each outcome that changes the tombstone and never for `unchanged`", () => {
    const kinds = () =>
      listInvalidations(db)
        .filter((r) => r.sourceId === chat)
        .map((r) => r.changeKind)
        .reverse();
    expect(apply("source-deleted", 7).outcome).toBe("created");
    expect(kinds()).toEqual(["source-deleted"]);
    const seq = readChangeSeq(db);

    expect(apply("source-deleted", 7, LATER).outcome).toBe("unchanged");
    expect(apply("access-revoked", 6, LATER).outcome).toBe("unchanged");
    expect(kinds()).toEqual(["source-deleted"]);

    // only the revision moves: the record names the reason the tombstone keeps
    expect(apply("access-revoked", 8, LATER)).toEqual({
      outcome: "revision-raised",
      sourceId: chat,
      coversVersion: 2,
    });
    expect(kinds()).toEqual(["source-deleted", "source-deleted"]);

    expect(apply("user-deleted", null, LATER).outcome).toBe("reason-changed");
    expect(kinds()).toEqual(["source-deleted", "source-deleted", "user-deleted"]);
    expect(readTombstoneState(db, chat)).toMatchObject({
      reason: "user-deleted",
      lastRevision: null,
      coversVersion: 2,
    });

    // a source reason never overwrites the user's: a greater revision raises
    // last_revision alone (I01-R11) and the record names the reason kept
    expect(apply("source-deleted", 99, AGAIN).outcome).toBe("revision-raised");
    expect(readTombstoneState(db, chat)).toMatchObject({
      reason: "user-deleted",
      lastRevision: 99,
      at: LATER,
    });
    expect(kinds()).toEqual(["source-deleted", "source-deleted", "user-deleted", "user-deleted"]);
    expect(apply("source-deleted", 99, AGAIN).outcome).toBe("unchanged");
    expect(apply("access-revoked", 98, AGAIN).outcome).toBe("unchanged");
    expect(kinds()).toHaveLength(4);
    // a reason or revision change removes nothing and is no content change
    expect(listInvalidations(db)[0]).toMatchObject({
      removedByKind: { source: 0, evidence: 0, fact: 0 },
    });
    expect(readChangeSeq(db)).toBe(seq);
  });

  it("covers version 0 for a source never seen, creating its row", () => {
    const before = { seq: readChangeSeq(db), sources: count("sources") };
    expect(findSourceId(db, "c1", "n", "ghost")).toBeUndefined();

    const result = apply("access-revoked", 3, AT, "ghost");

    const sourceId = findSourceId(db, "c1", "n", "ghost") as number;
    expect(result).toEqual({ outcome: "created", sourceId, coversVersion: 0 });
    expect(readTombstoneState(db, sourceId)).toMatchObject({
      coversVersion: 0,
      lastRevision: 3,
      reason: "access-revoked",
    });
    expect(readChangeSeq(db)).toBe(before.seq + 1);
    expect(count("sources")).toBe(before.sources + 1);
    expect(count("source_versions")).toBe(3);
    expect(listInvalidations(db)[0]).toMatchObject({ sourceId, changeKind: "access-revoked" });
    // the same event again finds the row it made
    expect(apply("access-revoked", 3, LATER, "ghost").outcome).toBe("unchanged");
    expect(count("sources")).toBe(before.sources + 1);
  });

  it("closes the source's open jobs when it changes the tombstone", () => {
    const registered = registerJob(db, { kind: "extract", sourceId: chat, fenceVersion: 2 });
    const other = registerJob(db, { kind: "extract", sourceId: mail, fenceVersion: 1 });
    if (!registered.registered || !other.registered) throw new Error("not registered");

    apply("source-deleted", 7);

    expect(readJob(db, registered.job.id)).toMatchObject({
      status: "superseded",
      reason: "source-closed",
    });
    expect(readJob(db, other.job.id)?.status).toBe("queued");
  });

  it("refuses a time that is no date before writing anything, for a known and an unknown source", () => {
    const before = snapshot();
    expect(() => apply("source-deleted", 7, "later")).toThrow(RangeError);
    expect(() => apply("source-deleted", 7, "later", "ghost")).toThrow(RangeError);
    expect(() => lift(chat, "later")).toThrow(RangeError);
    expect(snapshot()).toEqual(before);
  });

  it("is rolled back whole when the caller's transaction fails after it", () => {
    const before = snapshot();
    expect(() =>
      canonicalTransaction(db, (tx) => {
        applyTombstone(tx, {
          identity: identity(),
          reason: "user-deleted",
          lastRevision: null,
          at: AT,
        });
        applyTombstone(tx, {
          identity: identity("ghost"),
          reason: "source-deleted",
          lastRevision: 1,
          at: AT,
        });
        // I01's page transaction: a later record of the same page is refused
        throw new Error("refused record");
      }),
    ).toThrow("refused record");
    expect(snapshot()).toEqual(before);
    expect(readTombstoneState(db, chat)).toBeUndefined();
    expect(findSourceId(db, "c1", "n", "ghost")).toBeUndefined();
  });

  it("is rolled back whole when its own propagation fails", () => {
    db.exec(`CREATE TEMP TRIGGER fail_purge BEFORE DELETE ON facts
             BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    const before = snapshot();
    expect(() => apply("source-deleted", 7)).toThrow(/injected/);
    expect(snapshot()).toEqual(before);
  });
});

describe("tombstone.rules: liftTombstone and what follows it", () => {
  it("writes lifted_at without propagating, recording or raising the sequence", () => {
    apply("source-deleted", 7);
    const before = snapshot();

    expect(lift(chat)).toEqual({ outcome: "lifted" });

    expect(readTombstoneState(db, chat)).toMatchObject({
      coversVersion: 2,
      reason: "source-deleted",
      lastRevision: 7,
      liftedAt: LATER,
    });
    expect(snapshot()).toEqual({
      ...before,
      tombstones: [{ ...before.tombstones[0], lifted_at: LATER }],
    });
    // lifted already, or no tombstone to lift
    expect(lift(chat, AGAIN)).toEqual({ outcome: "unchanged" });
    expect(readTombstoneState(db, chat)?.liftedAt).toBe(LATER);
    expect(lift(mail)).toEqual({ outcome: "unchanged" });
    expect(readTombstoneState(db, mail)).toBeUndefined();
  });

  it.each(["user-deleted", "source-deleted"] as const)(
    "keeps the cover on a %s deletion after purge and lift: reason-changed, lifted_at cleared",
    (reason) => {
      apply("access-revoked", 7);
      expect(count("source_versions")).toBe(1); // every version of the source is gone
      lift(chat);
      const seq = readChangeSeq(db);
      const revision = reason === "user-deleted" ? null : 8;

      expect(apply(reason, revision, AGAIN)).toEqual({
        outcome: "reason-changed",
        sourceId: chat,
        coversVersion: 2,
      });

      expect(readTombstoneState(db, chat)).toEqual({
        sourceId: chat,
        coversVersion: 2,
        lastRevision: revision,
        reason,
        at: AGAIN,
        liftedAt: null,
      });
      expect(readChangeSeq(db)).toBe(seq);
      expect(listInvalidations(db)[0]).toMatchObject({ sourceId: chat, changeKind: reason });
    },
  );

  it("numbers the version that arrives after a lift covers_version + 1, and a deletion then extends the cover", () => {
    apply("source-deleted", 7);
    const record = { namespace: "n", externalId: "chat", title: "chat", body: "돌아옴" };
    expect(saveSourceRecord(db, "c1", record)).toEqual({ status: "refused", reason: "tombstoned" });
    lift(chat);
    expect(saveSourceRecord(db, "c1", record)).toEqual({
      status: "created",
      sourceId: chat,
      version: 3,
    });
    const seq = readChangeSeq(db);

    expect(apply("source-deleted", 9, AGAIN)).toEqual({
      outcome: "cover-extended",
      sourceId: chat,
      coversVersion: 3,
    });
    expect(readTombstoneState(db, chat)).toMatchObject({ coversVersion: 3, liftedAt: null });
    expect(readChangeSeq(db)).toBe(seq + 1);
    expect(db.all("SELECT source_id FROM source_versions")).toEqual([{ source_id: mail }]);
  });
});

describe("purge.idempotent: the same deletion event twice (I04-R12)", () => {
  it.each([
    ["source-deleted", 7],
    ["access-revoked", 7],
    ["user-deleted", null],
  ] as const)(
    "leaves the sequence, every row count and the records as they are (%s)",
    (reason, revision) => {
      const registered = registerJob(db, { kind: "extract", sourceId: chat, fenceVersion: 2 });
      if (!registered.registered) throw new Error("not registered");
      expect(apply(reason, revision).outcome).toBe("created");
      const before = snapshot();

      expect(apply(reason, revision, LATER)).toEqual({
        outcome: "unchanged",
        sourceId: chat,
        coversVersion: 2,
      });

      expect(snapshot()).toEqual(before);
    },
  );
});
