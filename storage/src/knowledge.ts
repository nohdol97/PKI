// Canonical knowledge (V02-R3, ADR 0002): items, facts and relations, and the
// evidence tying a fact or relation to a span of one immutable source version.
// Same-row rules (V02-R8) are the tables' unique keys: saving the same row again
// returns the stored one unchanged, so a caller only adds evidence to it.
import { analyticalRowChanged } from "./analytical-check-lines.ts";
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
  /** The model's own 0..1 number, never read to decide a status or epistemic type (S01-R10); read back as null when absent. */
  confidence?: number | null;
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
  /** A definition's short context tag (S01-R3); written when the row is created, never changed here. */
  context?: string | null;
  /** The end of the valid interval `[validAt, validUntil)` (S02-R17); null when unknown. */
  validUntil?: string | null;
}
export interface NewRelation extends KnowledgeAttributes {
  subjectId: number;
  type: string;
  objectId: number;
  /** The end of the valid interval `[validAt, validUntil)` (S02-R17); null when unknown. */
  validUntil?: string | null;
}
export type StoredItem = NewItem & { id: number };
export type StoredFact = NewFact & { id: number };
export type StoredRelation = NewRelation & { id: number };

const ATTRIBUTES = "epistemic, status, valid_at, observed_at, confidence";
const attributeValues = (k: KnowledgeAttributes) => [
  k.epistemic,
  k.status,
  k.validAt,
  k.observedAt,
  k.confidence ?? null,
];
const attributesOf = (row: SqlRow): KnowledgeAttributes => ({
  epistemic: row.epistemic as EpistemicType,
  status: row.status as KnowledgeStatus,
  validAt: row.valid_at as string | null,
  observedAt: row.observed_at as string,
  confidence: row.confidence as number | null,
});

export function insertItem(db: SqlDriver, item: NewItem): number {
  const values = [item.type, item.name, ...attributeValues(item)];
  return db.run(
    `INSERT INTO items (type, name, ${ATTRIBUTES}) VALUES (${values.map(() => "?").join(", ")})`,
    values,
  ).lastInsertRowid;
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
  extras: readonly { column: string; value: string | null }[] = [],
): { id: number; created: boolean } {
  // `valid_until` (v26) is written only when stated, so a row written before it existed needs no column of it
  const stated = extras.filter((e) => e.column !== "valid_until" || e.value !== null);
  const values = [...key, ...attributeValues(attributes), ...stated.map((e) => e.value)];
  const { changes } = db.run(
    `INSERT INTO ${table} (${keyColumns.join(", ")}, ${ATTRIBUTES}${stated.map((e) => `, ${e.column}`).join("")})
     VALUES (${values.map(() => "?").join(", ")}) ON CONFLICT DO NOTHING`,
    values,
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
    [
      { column: "context", value: fact.context ?? null },
      { column: "valid_until", value: fact.validUntil ?? null },
    ],
  );
}

export function readFact(db: SqlDriver, id: number): StoredFact | undefined {
  const row = db.all(
    `SELECT item_id, kind, value, valid_until, ${ATTRIBUTES} FROM facts WHERE id = ?`,
    [id],
  )[0];
  if (!row) return undefined;
  return {
    id,
    itemId: row.item_id as number,
    kind: row.kind as string,
    value: row.value as string,
    validUntil: row.valid_until as string | null,
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
    [{ column: "valid_until", value: relation.validUntil ?? null }],
  );
}

export function readRelation(db: SqlDriver, id: number): StoredRelation | undefined {
  const row = db.all(
    `SELECT subject_id, type, object_id, valid_until, ${ATTRIBUTES} FROM relations WHERE id = ?`,
    [id],
  )[0];
  if (!row) return undefined;
  return {
    id,
    subjectId: row.subject_id as number,
    type: row.type as string,
    objectId: row.object_id as number,
    validUntil: row.valid_until as string | null,
    ...attributesOf(row),
  };
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
  const added = db.run(
    `INSERT INTO evidence (source_version_id, fact_id, relation_id, start_offset, end_offset, quote)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    [sourceVersionId, ...target, start, end, quote],
  );
  // a row a check line reads gained evidence (S03-R11); the same evidence again changes nothing
  if (added.changes === 1) {
    analyticalRowChanged(
      db,
      "factId" in evidence.target
        ? { kind: "fact", id: evidence.target.factId }
        : { kind: "relation", id: evidence.target.relationId },
    );
  }
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
