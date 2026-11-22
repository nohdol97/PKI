// I04-R6, R7, R10 (I04-T07; I04-C3): after a deletion no file of a file-based data
// directory holds the deleted text, and the identity of a purged source is a keyed
// hash. Tests: purge.canary-files, identity.hash (entry level), retention.
// Canaries share no prefix with each other or with any other stored word.
import {
  addEvidence,
  canonicalTransaction,
  closeJob,
  setAnalyticalProfile,
  DATASET_PROFILE_KIND,
  findSourceId,
  identityKey,
  insertItem,
  leaseNextJob,
  prepareCanonicalDb,
  readTombstoneState,
  registerConnectorInstance,
  registerJob,
  saveFact,
  saveInsight,
  saveSourceRecord,
  searchKeyword,
  type KnowledgeAttributes,
  type SqlDriver,
  type StoredRecord,
  type TombstoneReason,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { canariesLeft } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatasetProfileHandler } from "./dataset-profile.ts";
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
  author: "wqpauthor", // ⑤ provenance an earlier version holds (I01-R13)
  locator: "hnxlocator", // ⑤ the locator of a block of the current version (I01-R7)
  alias: "vsjalias", // ⑧ a surface form, the value of an `alias.*` fact (S01-R2)
  definition: "ndzdefinition", // ⑧ a definition, the value of a `definition` fact (S01-R3)
  context: "kfbcontext", // ⑧ a definition's context tag (S01-R3)
};
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
const NEW_BODY = `이제 ${CANARY.body} 와 ${CANARY.word} 그리고 ${CANARY.quote} 입니다 ${CANARY.alias} ${CANARY.definition}`;

/** One source, two versions (the first with the old value), a fact on each, one Insight. */
function seed() {
  const record = (body: string, extra: Partial<StoredRecord> = {}): StoredRecord => ({
    namespace: CANARY.namespace,
    externalId: CANARY.externalId,
    title: "t",
    body,
    ...extra,
  });
  const first = saveSourceRecord(
    db,
    "c1",
    record(OLD_BODY, { provenance: { author: CANARY.author } }),
  );
  const second = saveSourceRecord(
    db,
    "c1",
    record(NEW_BODY, {
      blocks: [{ start: 0, end: 2, locator: { format: "xlsx", sheet: CANARY.locator } }],
    }),
  );
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
  // a concept with a surface form and a definition that has a context tag, both from the current version
  const concept = insertItem(db, { type: "Concept", name: "Z 개념", ...attrs });
  const vocabulary = (kind: string, value: string, context: string | null) => {
    const id = saveFact(db, { itemId: concept, kind, value, context, ...attrs }).id;
    const start = NEW_BODY.indexOf(value);
    addEvidence(db, {
      target: { factId: id },
      sourceVersionId: versionId(2),
      start,
      end: start + value.length,
      quote: value,
    });
  };
  vocabulary("alias.synonym", CANARY.alias, null);
  vocabulary("definition", CANARY.definition, CANARY.context);
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

  it("leaves no surface form, definition or context tag in any file after the deletion (S01-R22)", () => {
    seed();
    const rows = () =>
      db.all(
        "SELECT kind, value, context FROM facts WHERE kind IN ('alias.synonym', 'definition') ORDER BY id",
      );
    expect(rows()).toEqual([
      { kind: "alias.synonym", value: CANARY.alias, context: null },
      { kind: "definition", value: CANARY.definition, context: CANARY.context },
    ]);
    entry("user-deleted");
    expect(rows()).toEqual([]);
    expect(db.all("SELECT 1 FROM items WHERE type = 'Concept'")).toEqual([]);
    const left = residue();
    for (const canary of [CANARY.alias, CANARY.definition, CANARY.context]) {
      expect(left).not.toContain(canary);
    }
  });

  it("control: with PRAGMA secure_delete off the current text stays (①)", () => {
    seed();
    db.exec("PRAGMA secure_delete = OFF");
    entry("user-deleted");
    expect(residue()).toContain(CANARY.body);
  });

  it("control: with the FTS secure-delete off the indexed word stays (③)", () => {
    seed();
    // only the FTS option is off: the page-level overwrite stays on, so the word
    // can only be left by the index's own segments
    db.run("INSERT INTO keyword_index (keyword_index, rank) VALUES ('secure-delete', 0)");
    entry("user-deleted");
    expect(residue()).toContain(CANARY.word);
  });
});

// S03-R17: the names a table's profile writes (a column name, the sheet's name) are gone with the table's source.
// The Dataset item is named `title:sheet`, so its name goes with its item, which no other source holds here
// (the case that another source's row holds it is S03-T05's).
describe("purge.canary-files: a table source's profile (S03-R17)", () => {
  const TABLE = {
    column: "zqkcolumn", // a header cell: a `dataset.column` fact's value and its evidence's quote
    other: "wvfheader", // a second header cell
    sheet: "bnmsheet", // the sheet's name: a locator's field, `dataset_tables`'s key, the Dataset item's name
    title: "ptdtitle", // the source's title: the Dataset item's name
    cell: "xrlvalue", // a data cell
    external: "ghsexternal",
  };
  const TABLE_CANARIES = Object.values(TABLE);
  const WORKBOOK_BODY = `${TABLE.column}\t${TABLE.other}\n${TABLE.cell}\t1`;

  /** One workbook of one sheet, profiled: its Dataset, columns and `dataset_tables` row are written. */
  async function seedTable(): Promise<number> {
    setAnalyticalProfile(db, true, new Date(AT)); // the job reads the switch when it runs
    const cell = (text: string, row: number, column: number, start: number) => ({
      start,
      end: start + text.length,
      locator: {
        format: "xlsx" as const,
        sheet: TABLE.sheet,
        cell: `${"AB"[column - 1]}${row}`,
        row,
        column,
      },
    });
    const blocks = [
      cell(TABLE.column, 1, 1, 0),
      cell(TABLE.other, 1, 2, TABLE.column.length + 1),
      cell(TABLE.cell, 2, 1, TABLE.column.length + TABLE.other.length + 2),
      cell("1", 2, 2, TABLE.column.length + TABLE.other.length + TABLE.cell.length + 3),
    ];
    const saved = saveSourceRecord(db, "c1", {
      namespace: "",
      externalId: TABLE.external,
      title: TABLE.title,
      body: WORKBOOK_BODY,
      blocks,
    });
    if (saved.status !== "created") throw new Error("seed");
    registerJob(db, {
      kind: DATASET_PROFILE_KIND,
      sourceId: saved.sourceId,
      fenceVersion: saved.version,
      at: new Date(AT),
    });
    const job = leaseNextJob(db, {
      kinds: [DATASET_PROFILE_KIND],
      now: new Date(AT),
      leaseMs: 60_000,
    });
    if (!job) throw new Error("no job");
    const result = await createDatasetProfileHandler({ db, now: () => new Date(AT) })(job);
    if (result.status !== "succeeded" || closeJob(db, job, result, new Date(AT)) !== "succeeded") {
      throw new Error("profile");
    }
    return saved.sourceId;
  }
  const tableEntry = (reason: TombstoneReason) =>
    canonicalTransaction(db, (tx) =>
      applyTombstone(tx, {
        identity: { connectorInstanceId: "c1", namespace: "", externalId: TABLE.external },
        reason,
        lastRevision: null,
        at: AT,
      }),
    );
  const left = () => {
    db.close();
    const found = canariesLeft(dir, TABLE_CANARIES);
    db = open();
    return found;
  };

  it("every canary is in the file once the table is profiled (else the checks below prove nothing)", async () => {
    await seedTable();
    expect(db.all("SELECT table_key, row_count FROM dataset_tables")).toEqual([
      { table_key: TABLE.sheet, row_count: 1 },
    ]);
    expect(db.all("SELECT name FROM items")).toEqual([{ name: `${TABLE.title}:${TABLE.sheet}` }]);
    expect(left()).toEqual(TABLE_CANARIES);
  });

  it.each([["source-deleted"], ["access-revoked"], ["user-deleted"]] as const)(
    "leaves no column name, sheet name, title or cell in any file after a %s deletion, and no Dataset or table row",
    async (reason) => {
      await seedTable();
      tableEntry(reason);
      expect(left()).toEqual([]);
      expect(db.all("SELECT 1 FROM items")).toEqual([]);
      expect(db.all("SELECT 1 FROM facts")).toEqual([]);
      expect(db.all("SELECT 1 FROM dataset_tables")).toEqual([]);
    },
  );

  it("a prose source's deletion leaves a table's names alone", async () => {
    await seedTable();
    seed();
    entry("user-deleted");
    expect(db.all("SELECT table_key FROM dataset_tables")).toEqual([{ table_key: TABLE.sheet }]);
    expect(db.all("SELECT type FROM items WHERE type = 'Dataset'")).toHaveLength(1);
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
