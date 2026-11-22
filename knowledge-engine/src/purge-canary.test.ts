// I04-R6, R7, R10 (I04-T07; I04-C3): after a deletion no file of a file-based data
// directory holds the deleted text, and the identity of a purged source is a keyed
// hash. Tests: purge.canary-files, identity.hash (entry level), retention.
// Canaries share no prefix with each other or with any other stored word.
import {
  addEvidence,
  canonicalTransaction,
  findSourceId,
  identityKey,
  insertItem,
  prepareCanonicalDb,
  readTombstoneState,
  registerConnectorInstance,
  saveFact,
  saveInsight,
  saveSourceRecord,
  searchKeyword,
  type KnowledgeAttributes,
  type SqlDriver,
  type TombstoneReason,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { canariesLeft } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteSource } from "./deletion.ts";
import { COMPLETION_DATE, DEPENDENCY_DELAY } from "./dependency-delay.ts";
import { applyTombstone } from "./tombstone-entry.ts";

const CANARY = {
  body: "jwxbody", // ① the current version's text
  old: "mbvold", // ② a value only an earlier version held
  word: "Qzmword", // ③ stored mixed-case; the index keeps it lowercased
  quote: "pqyquote", // ④ an evidence quote
  insight: "xfginsight", // ⑥ the Insight's explanation
  externalId: "hrtextid", // ⑦ the external identifier
  namespace: "lknspace", // ⑦ and its namespace
};
// ⑤ (author, a block's locator) are columns I01 adds; none exists on this schema.
const ALL = Object.values(CANARY);
const AT = "2026-11-22T00:00:00.000Z";
const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
};

let dir: string;
let db: SqlDriver;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-purge-"));
  db = open();
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
function open(): SqlDriver {
  const opened = openBetterSqlite3(join(dir, "pki.sqlite"));
  prepareCanonicalDb(opened);
  return opened;
}
const IDENTITY = {
  connectorInstanceId: "c1",
  namespace: CANARY.namespace,
  externalId: CANARY.externalId,
};
const OLD_BODY = `값 ${CANARY.old} 입니다`;
const NEW_BODY = `이제 ${CANARY.body} 와 ${CANARY.word} 그리고 ${CANARY.quote} 입니다`;

/** One source, two versions (the first with the old value), a fact on each, one Insight. */
function seed() {
  const record = (body: string) => ({
    namespace: CANARY.namespace,
    externalId: CANARY.externalId,
    title: "t",
    body,
  });
  const first = saveSourceRecord(db, "c1", record(OLD_BODY));
  const second = saveSourceRecord(db, "c1", record(NEW_BODY));
  if (first.status !== "created" || second.status !== "created") throw new Error("seed");
  const versionId = (v: number) =>
    db.all("SELECT id FROM source_versions WHERE source_id = ? AND version = ?", [
      first.sourceId,
      v,
    ])[0]?.id as number;
  const x = insertItem(db, { type: "Project", name: "X 항목", ...attrs });
  const y = insertItem(db, { type: "System", name: "Y 항목", ...attrs });
  const fact = (itemId: number, value: string, v: number, body: string, quote: string) => {
    const id = saveFact(db, { itemId, kind: COMPLETION_DATE, value, ...attrs }).id;
    const start = body.indexOf(quote);
    return addEvidence(db, {
      target: { factId: id },
      sourceVersionId: versionId(v),
      start,
      end: start + quote.length,
      quote,
    });
  };
  const evidenceOld = fact(x, "2026-12-10", 1, OLD_BODY, CANARY.old);
  const evidenceNew = fact(y, "2026-12-12", 2, NEW_BODY, CANARY.quote);
  saveInsight(
    db,
    { rule: DEPENDENCY_DELAY, xItemId: x, yItemId: y },
    {
      state: "active",
      summary: `${CANARY.insight} 지연`,
      evidenceIds: [evidenceOld, evidenceNew],
    },
  );
  return first.sourceId;
}
const entry = (reason: TombstoneReason) =>
  canonicalTransaction(db, (tx) =>
    applyTombstone(tx, { identity: IDENTITY, reason, lastRevision: null, at: AT }),
  );
/** What the files hold once every connection is closed (an open reader must not mask residue). */
const residue = () => {
  db.close();
  const left = canariesLeft(dir, ALL);
  db = open();
  return left;
};

describe("purge.canary-files", () => {
  it("every canary is in the file before the deletion (else the checks below prove nothing)", () => {
    seed();
    expect(residue()).toEqual(ALL);
  });

  it.each([["source-deleted"], ["access-revoked"], ["user-deleted"]] as const)(
    "leaves no canary in any file after a %s deletion",
    (reason) => {
      seed();
      entry(reason);
      expect(residue()).toEqual([]);
      expect(searchKeyword(db, CANARY.word.toLowerCase())).toEqual([]);
    },
  );

  it("is the same for the V02 entry, deleteSource", () => {
    const sourceId = seed();
    deleteSource(db, sourceId, { reason: "user-deleted", at: AT });
    expect(residue()).toEqual([]);
  });

  it("control: with PRAGMA secure_delete off the current text stays (①)", () => {
    seed();
    db.exec("PRAGMA secure_delete = OFF");
    entry("user-deleted");
    expect(residue()).toContain(CANARY.body);
  });

  it("control: with the FTS secure-delete off the indexed word stays (③)", () => {
    seed();
    db.run("INSERT INTO keyword_index (keyword_index, rank) VALUES ('secure-delete', 0)");
    db.exec("PRAGMA secure_delete = OFF");
    entry("user-deleted");
    expect(residue()).toContain(CANARY.word);
  });
});

describe("identity.hash: the entry", () => {
  it("writes no plain identity for a source never seen, and finds it by identityKey", () => {
    const { sourceId } = entry("source-deleted");
    const hash = identityKey(db, "c1", CANARY.namespace, CANARY.externalId);
    expect(db.all("SELECT namespace, external_id, identity_hashed FROM sources")).toEqual([
      { namespace: hash, external_id: hash, identity_hashed: 1 },
    ]);
    expect(findSourceId(db, "c1", CANARY.namespace, CANARY.externalId)).toBe(sourceId);
    expect(entry("source-deleted").outcome).toBe("unchanged");
    expect(db.all("SELECT count(*) AS n FROM sources")[0]?.n).toBe(1);
    expect(residue()).toEqual([]);
  });

  it("hashes a purged source's identity in the same transaction as the purge", () => {
    const sourceId = seed();
    entry("source-deleted");
    const hash = identityKey(db, "c1", CANARY.namespace, CANARY.externalId);
    expect(db.all("SELECT external_id FROM sources WHERE id = ?", [sourceId])).toEqual([
      { external_id: hash },
    ]);
  });
});

describe("retention", () => {
  it("keeps earlier versions and their text when a new one arrives", () => {
    seed();
    const third = saveSourceRecord(db, "c1", {
      namespace: CANARY.namespace,
      externalId: CANARY.externalId,
      title: "t",
      body: "또 다른 내용",
    });
    expect(third.status).toBe("created");
    expect(db.all("SELECT version, body FROM source_versions ORDER BY version")).toEqual([
      { version: 1, body: OLD_BODY },
      { version: 2, body: NEW_BODY },
      { version: 3, body: "또 다른 내용" },
    ]);
  });

  it("keeps the tombstone after the purge and across a restart; the cover took the versions", () => {
    const sourceId = seed();
    entry("user-deleted");
    expect(db.all("SELECT count(*) AS n FROM source_versions")[0]?.n).toBe(0);
    const state = readTombstoneState(db, sourceId);
    expect(state).toMatchObject({ coversVersion: 2, reason: "user-deleted", liftedAt: null });
    db.close();
    db = open();
    expect(readTombstoneState(db, sourceId)).toEqual(state);
  });
});
