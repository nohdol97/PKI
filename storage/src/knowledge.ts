// Canonical knowledge (V02-R3, ADR 0002): items, facts and relations, and the
// evidence tying a fact or relation to a span of one immutable source version.
// Same-row rules (V02-R8) are the tables' unique keys: saving the same row again
// returns the stored one unchanged, so a caller only adds evidence to it.
import type { SqlDriver, SqlRow } from "./sql-driver.ts";

export type EpistemicType = "explicit" | "user-approved" | "inferred" | "hypothesis";
export type KnowledgeStatus = "candidate" | "verified" | "disputed" | "superseded" | "rejected";

export interface KnowledgeAttributes {
  epistemic: EpistemicType;
  status: KnowledgeStatus;
  /** When the knowledge holds, if known. */
  validAt: string | null;
  /** When it was observed (recorded). */
  observedAt: string;
}

export interface NewItem extends KnowledgeAttributes {
  type: string;
  name: string;
}
export interface NewFact extends KnowledgeAttributes {
  itemId: number;
  kind: string;
  /** Already normalized by the caller (a date is YYYY-MM-DD). */
  value: string;
}
export interface NewRelation extends KnowledgeAttributes {
  subjectId: number;
  type: string;
  objectId: number;
}
export type StoredItem = NewItem & { id: number };
export type StoredFact = NewFact & { id: number };
export type StoredRelation = NewRelation & { id: number };

const ATTRIBUTES = "epistemic, status, valid_at, observed_at";
const attributeValues = (k: KnowledgeAttributes) => [
  k.epistemic,
  k.status,
  k.validAt,
  k.observedAt,
];
const attributesOf = (row: SqlRow): KnowledgeAttributes => ({
  epistemic: row.epistemic as EpistemicType,
  status: row.status as KnowledgeStatus,
  validAt: row.valid_at as string | null,
  observedAt: row.observed_at as string,
});

export function insertItem(db: SqlDriver, item: NewItem): number {
  return db.run(`INSERT INTO items (type, name, ${ATTRIBUTES}) VALUES (?, ?, ?, ?, ?, ?)`, [
    item.type,
    item.name,
    ...attributeValues(item),
  ]).lastInsertRowid;
}

export function readItem(db: SqlDriver, id: number): StoredItem | undefined {
  const row = db.all(`SELECT id, type, name, ${ATTRIBUTES} FROM items WHERE id = ?`, [id])[0];
  if (!row) return undefined;
  return { id, type: row.type as string, name: row.name as string, ...attributesOf(row) };
}

/** Inserts the row unless one with the same key exists; either way returns its id. */
function saveUnique(
  db: SqlDriver,
  table: "facts" | "relations",
  keyColumns: readonly [string, string, string],
  key: readonly [number | string, string, number | string],
  attributes: KnowledgeAttributes,
): { id: number; created: boolean } {
  const { changes } = db.run(
    `INSERT INTO ${table} (${keyColumns.join(", ")}, ${ATTRIBUTES}) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [...key, ...attributeValues(attributes)],
  );
  const id = db.all(
    `SELECT id FROM ${table} WHERE ${keyColumns.map((c) => `${c} = ?`).join(" AND ")}`,
    [...key],
  )[0]?.id as number;
  return { id, created: changes === 1 };
}

export function saveFact(db: SqlDriver, fact: NewFact): { id: number; created: boolean } {
  return saveUnique(
    db,
    "facts",
    ["item_id", "kind", "value"],
    [fact.itemId, fact.kind, fact.value],
    fact,
  );
}

export function readFact(db: SqlDriver, id: number): StoredFact | undefined {
  const row = db.all(`SELECT item_id, kind, value, ${ATTRIBUTES} FROM facts WHERE id = ?`, [id])[0];
  if (!row) return undefined;
  return {
    id,
    itemId: row.item_id as number,
    kind: row.kind as string,
    value: row.value as string,
    ...attributesOf(row),
  };
}

export function saveRelation(
  db: SqlDriver,
  relation: NewRelation,
): { id: number; created: boolean } {
  return saveUnique(
    db,
    "relations",
    ["subject_id", "type", "object_id"],
    [relation.subjectId, relation.type, relation.objectId],
    relation,
  );
}

export function readRelation(db: SqlDriver, id: number): StoredRelation | undefined {
  const row = db.all(
    `SELECT subject_id, type, object_id, ${ATTRIBUTES} FROM relations WHERE id = ?`,
    [id],
  )[0];
  if (!row) return undefined;
  return {
    id,
    subjectId: row.subject_id as number,
    type: row.type as string,
    objectId: row.object_id as number,
    ...attributesOf(row),
  };
}

const TABLES = { item: "items", fact: "facts", relation: "relations" } as const;

export function setKnowledgeStatus(
  db: SqlDriver,
  kind: keyof typeof TABLES,
  id: number,
  status: KnowledgeStatus,
): void {
  if (db.run(`UPDATE ${TABLES[kind]} SET status = ? WHERE id = ?`, [status, id]).changes !== 1) {
    throw new Error(`${kind} ${id} not found`);
  }
}

export type EvidenceTarget = { factId: number } | { relationId: number };

export interface NewEvidence {
  target: EvidenceTarget;
  sourceVersionId: number;
  /** [start, end) in Unicode code points of the version's body. */
  start: number;
  end: number;
  quote: string;
}
export interface StoredEvidence extends NewEvidence {
  id: number;
  /** The version is its source's latest ("현재 근거"); otherwise past evidence. */
  current: boolean;
}

/** Whether version `v` of an evidence row is its source's latest ("현재 근거"). */
const CURRENT = "v.id = (SELECT max(id) FROM source_versions WHERE source_id = v.source_id)";

const targetValues = (t: EvidenceTarget) =>
  "factId" in t ? [t.factId, null] : [null, t.relationId];

/**
 * Records evidence once per row, version and span; returns its id. The span must
 * select exactly the quote in the stored body, counted in code points (SQLite's
 * substr() and length() count characters of TEXT, not UTF-16 units).
 */
export function addEvidence(db: SqlDriver, evidence: NewEvidence): number {
  const { start, end, quote, sourceVersionId } = evidence;
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new Error("evidence span must be integer code point offsets");
  }
  const row = db.all(
    "SELECT substr(body, ? + 1, ? - ?) AS selected, length(body) AS n FROM source_versions WHERE id = ?",
    [start, end, start, sourceVersionId],
  )[0];
  if (!row) throw new Error(`source version ${sourceVersionId} not found`);
  if (row.selected !== quote || end > (row.n as number)) {
    throw new Error(`span [${start}, ${end}) does not select the quote`);
  }
  const target = targetValues(evidence.target);
  db.run(
    `INSERT INTO evidence (source_version_id, fact_id, relation_id, start_offset, end_offset, quote)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    [sourceVersionId, ...target, start, end, quote],
  );
  return db.all(
    `SELECT id FROM evidence WHERE source_version_id = ? AND fact_id IS ? AND relation_id IS ?
       AND start_offset = ? AND end_offset = ?`,
    [sourceVersionId, ...target, start, end],
  )[0]?.id as number;
}

/** Evidence of one fact or relation, oldest first, with whether each is current. */
export function listEvidence(db: SqlDriver, target: EvidenceTarget): StoredEvidence[] {
  const column = "factId" in target ? "fact_id" : "relation_id";
  return db
    .all(
      `SELECT e.id, e.source_version_id, e.start_offset, e.end_offset, e.quote,
         ${CURRENT} AS current
       FROM evidence e JOIN source_versions v ON v.id = e.source_version_id
       WHERE e.${column} = ? ORDER BY e.id`,
      [targetValues(target).find((v) => v !== null) as number],
    )
    .map((row) => ({
      id: row.id as number,
      target,
      sourceVersionId: row.source_version_id as number,
      start: row.start_offset as number,
      end: row.end_offset as number,
      quote: row.quote as string,
      current: row.current === 1,
    }));
}

/**
 * After a new version of source `sourceId` (V02-R11): every fact and relation
 * with evidence on one of that source's versions that now has no current evidence
 * at all becomes superseded. The evidence stays on its version as past evidence
 * (it is immutable). Rejected and already superseded rows are left alone. Returns
 * the rows changed, and the items of every row the source's versions cite (a
 * fact's item, a relation's subject and object), ascending: a row another source
 * keeps valid has past evidence too, which its Insight must drop.
 */
export function supersedeUnsupported(
  db: SqlDriver,
  sourceId: number,
): { facts: number[]; relations: number[]; itemIds: number[] } {
  const cited = (table: "facts" | "relations", column: "fact_id" | "relation_id", items: string) =>
    db.all(
      `SELECT t.id, t.status, ${items},
         EXISTS (SELECT 1 FROM evidence e JOIN source_versions v ON v.id = e.source_version_id
                 WHERE e.${column} = t.id AND ${CURRENT}) AS supported
       FROM ${table} t
       WHERE t.id IN (SELECT e.${column} FROM evidence e
                      JOIN source_versions v ON v.id = e.source_version_id
                      WHERE v.source_id = ?)
       ORDER BY t.id`,
      [sourceId],
    );
  const stale = (rows: SqlRow[]) =>
    rows
      .filter((r) => r.supported === 0 && r.status !== "superseded" && r.status !== "rejected")
      .map((r) => r.id as number);
  const factRows = cited("facts", "fact_id", "t.item_id AS a, NULL AS b");
  const relationRows = cited("relations", "relation_id", "t.subject_id AS a, t.object_id AS b");
  const facts = stale(factRows);
  const relations = stale(relationRows);
  for (const id of facts) setKnowledgeStatus(db, "fact", id, "superseded");
  for (const id of relations) setKnowledgeStatus(db, "relation", id, "superseded");
  const itemIds = new Set<number>();
  for (const row of [...factRows, ...relationRows]) {
    for (const id of [row.a, row.b]) if (id !== null) itemIds.add(id as number);
  }
  return { facts, relations, itemIds: [...itemIds].sort((x, y) => x - y) };
}

/**
 * Brings a superseded fact or relation back as a candidate when an extraction
 * gives it current evidence again (V02-R11; provisional: the status before it was
 * superseded is not kept). Any other status is left alone; returns whether it changed.
 */
export function reviveSuperseded(db: SqlDriver, target: EvidenceTarget): boolean {
  const [table, id] =
    "factId" in target ? ["facts", target.factId] : ["relations", target.relationId];
  return (
    db.run(`UPDATE ${table} SET status = 'candidate' WHERE id = ? AND status = 'superseded'`, [id])
      .changes === 1
  );
}
