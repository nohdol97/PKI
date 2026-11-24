// The lineage of an item, fact or relation: the source versions it came from (I04-R1). A row an
// extraction wrote is built from the evidence on it; an item from the evidence of every fact and
// relation on it. A row the user wrote has no evidence of its own that makes it (S01-R22): a fact's
// lineage is its item's, a relation's the union of its two items', and an item the user created has
// none, whatever extraction attached to it afterwards (the facts attached carry their own lineage).
import type { SourceVersionRef } from "./derivatives.ts";
import { keyedRead, preloadReads, type KeyedRead } from "./read-memo.ts";
import type { EntryRef } from "./semantic-lifecycle.ts";
import type { SqlDriver } from "./sql-driver.ts";

const EVIDENCE_VERSIONS = (where: string) =>
  `SELECT DISTINCT v.source_id, v.version FROM source_versions v
   WHERE v.id IN (SELECT e.source_version_id FROM evidence e WHERE ${where})
   ORDER BY v.source_id, v.version`;

const versionsOf = (db: SqlDriver, where: string, params: number[]): SourceVersionRef[] =>
  db
    .all(EVIDENCE_VERSIONS(where), params)
    .map((r) => ({ sourceId: r.source_id as number, version: r.version as number }));

/** The versions of every list, each once, in source and version order. */
export function unionOfVersions(...lists: readonly (readonly SourceVersionRef[])[]) {
  const seen = new Map<string, SourceVersionRef>();
  for (const v of lists.flat()) seen.set(`${v.sourceId}@${v.version}`, v);
  return [...seen.values()].sort((a, b) => a.sourceId - b.sourceId || a.version - b.version);
}

const TABLE = { item: "items", fact: "facts", relation: "relations" } as const;

/** Whether the user wrote the row, and its twin; the lifecycle's `userAuthored` asks the same text (ARB-R1). */
export const USER_AUTHORED_READS = {
  item: keyedRead({ columns: "user_authored", from: TABLE.item, key: "id" }),
  fact: keyedRead({ columns: "user_authored", from: TABLE.fact, key: "id" }),
  relation: keyedRead({ columns: "user_authored", from: TABLE.relation, key: "id" }),
};

const authored = (db: SqlDriver, ref: EntryRef): boolean =>
  db.all(USER_AUTHORED_READS[ref.kind].one, [ref.id])[0]?.user_authored === 1;

const evidenceVersions = (key: string): KeyedRead => ({
  one: EVIDENCE_VERSIONS(`${key} = ?`),
  many: `SELECT DISTINCT ${key} AS key, v.source_id, v.version
   FROM evidence e JOIN source_versions v ON v.id = e.source_version_id
   WHERE ${key} IN (SELECT value FROM json_each(?)) ORDER BY ${key}, v.source_id, v.version`,
});
/** The versions a fact's, a relation's and an evidence's own lineage reads, and their twins (ARB-R1). */
export const LINEAGE_READS = {
  fact: evidenceVersions("e.fact_id"),
  relation: evidenceVersions("e.relation_id"),
  evidence: evidenceVersions("e.id"),
};

/** The lineage of one evidence row: the version it cites. */
export const evidenceLineage = (db: SqlDriver, evidenceId: number): SourceVersionRef[] =>
  db
    .all(LINEAGE_READS.evidence.one, [evidenceId])
    .map((r) => ({ sourceId: r.source_id as number, version: r.version as number }));

/** Primes `rowLineage` of these facts or relations, and of these evidence rows with `evidenceLineage`. */
export function preloadLineage(
  db: SqlDriver,
  kind: keyof typeof LINEAGE_READS,
  ids: readonly number[],
): void {
  preloadReads(db, LINEAGE_READS[kind], ids);
  if (kind !== "evidence") preloadReads(db, USER_AUTHORED_READS[kind], ids);
}

export function rowLineage(db: SqlDriver, ref: EntryRef): SourceVersionRef[] {
  if (ref.kind === "item") {
    if (authored(db, ref)) return [];
    return versionsOf(
      db,
      `e.fact_id IN (SELECT id FROM facts WHERE item_id = ?)
       OR e.relation_id IN (SELECT id FROM relations WHERE subject_id = ? OR object_id = ?)`,
      [ref.id, ref.id, ref.id],
    );
  }
  if (!authored(db, ref)) {
    return versionsOf(db, ref.kind === "fact" ? "e.fact_id = ?" : "e.relation_id = ?", [ref.id]);
  }
  if (ref.kind === "fact") {
    const itemId = db.all("SELECT item_id FROM facts WHERE id = ?", [ref.id])[0]?.item_id;
    return typeof itemId === "number" ? rowLineage(db, { kind: "item", id: itemId }) : [];
  }
  const ends = db.all("SELECT subject_id, object_id FROM relations WHERE id = ?", [ref.id])[0];
  return ends
    ? unionOfVersions(
        rowLineage(db, { kind: "item", id: ends.subject_id as number }),
        rowLineage(db, { kind: "item", id: ends.object_id as number }),
      )
    : [];
}
