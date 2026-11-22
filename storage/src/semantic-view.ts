// The Semantic registry as the API reads it (S01-R23, T02): the rows with their status, epistemic
// type, confidence, evidence count and whether the user decided or wrote them, and a row's history.
// These are plain reads; they judge nothing about visibility. The read gate (backend/src/read-gate.ts)
// asks the registry's `visible` before any of it leaves the backend (S01-R22).
import { listEvidence, type EpistemicType, type KnowledgeStatus } from "./knowledge.ts";
import {
  isUserDecided,
  readRow,
  type Actor,
  type EntryKind,
  type EntryRef,
  type Row,
} from "./semantic-lifecycle.ts";
import type { SqlDriver, SqlRow } from "./sql-driver.ts";

export interface SemanticRowView {
  id: number;
  status: KnowledgeStatus;
  epistemic: EpistemicType;
  confidence: number | null;
  userDecided: boolean;
  userAuthored: boolean;
}
export interface SemanticFactView extends SemanticRowView {
  kind: string;
  value: string;
  context: string | null;
  evidenceCount: number;
}
export interface SemanticRelationView extends SemanticRowView {
  type: string;
  subjectId: number;
  objectId: number;
  evidenceCount: number;
}
export interface SemanticItemView extends SemanticRowView {
  type: string;
  name: string;
}

const rowOf = (db: SqlDriver, kind: EntryKind, r: SqlRow): SemanticRowView => ({
  id: r.id as number,
  status: r.status as KnowledgeStatus,
  epistemic: r.epistemic as EpistemicType,
  confidence: r.confidence as number | null,
  userDecided: isUserDecided(db, { kind, id: r.id as number }),
  userAuthored: r.user_authored === 1,
});

const COLUMNS = "id, status, epistemic, confidence, user_authored";

/** The first `limit` items, by id. */
export function listSemanticItems(db: SqlDriver, limit: number): SemanticItemView[] {
  return db
    .all(`SELECT ${COLUMNS}, type, name FROM items ORDER BY id LIMIT ?`, [limit])
    .map((r) => ({ ...rowOf(db, "item", r), type: r.type as string, name: r.name as string }));
}

export function listSemanticFacts(db: SqlDriver, itemId: number): SemanticFactView[] {
  return db
    .all(`SELECT ${COLUMNS}, kind, value, context FROM facts WHERE item_id = ? ORDER BY id`, [
      itemId,
    ])
    .map((r) => ({
      ...rowOf(db, "fact", r),
      kind: r.kind as string,
      value: r.value as string,
      context: r.context as string | null,
      evidenceCount: listEvidence(db, { factId: r.id as number }).filter((e) => e.current).length,
    }));
}

/** The relations whose subject is `subjectId`. */
export function listSemanticRelations(db: SqlDriver, subjectId: number): SemanticRelationView[] {
  return db
    .all(
      `SELECT ${COLUMNS}, type, subject_id, object_id FROM relations WHERE subject_id = ? ORDER BY id`,
      [subjectId],
    )
    .map((r) => ({
      ...rowOf(db, "relation", r),
      type: r.type as string,
      subjectId: r.subject_id as number,
      objectId: r.object_id as number,
      evidenceCount: listEvidence(db, { relationId: r.id as number }).filter((e) => e.current)
        .length,
    }));
}

/** The row's status and epistemic type now; undefined when it is not stored. */
export const readSemanticState = (db: SqlDriver, ref: EntryRef): Row | undefined =>
  readRow(db, ref);

export interface SemanticHistoryLine {
  seq: number;
  at: string;
  actor: Actor;
  action: string;
  fromStatus: KnowledgeStatus | null;
  toStatus: KnowledgeStatus;
  fromEpistemic: EpistemicType | null;
  toEpistemic: EpistemicType;
  reason: string | null;
  basisSourceId: number | null;
  basisVersion: number | null;
  batch: number | null;
  revertsSeq: number | null;
}

const HISTORY = { item: "item_history", fact: "fact_history", relation: "relation_history" };
const FK = { item: "item_id", fact: "fact_id", relation: "relation_id" };

/** A row's history, oldest first: numbers and closed codes only (S01-R6). */
export function readSemanticHistory(db: SqlDriver, ref: EntryRef): SemanticHistoryLine[] {
  return db
    .all(
      `SELECT seq, at, actor, action, from_status, to_status, from_epistemic, to_epistemic, reason,
         basis_source_id, basis_version, batch, reverts_seq
       FROM ${HISTORY[ref.kind]} WHERE ${FK[ref.kind]} = ? ORDER BY seq`,
      [ref.id],
    )
    .map((r) => ({
      seq: r.seq as number,
      at: r.at as string,
      actor: r.actor as Actor,
      action: r.action as string,
      fromStatus: r.from_status as KnowledgeStatus | null,
      toStatus: r.to_status as KnowledgeStatus,
      fromEpistemic: r.from_epistemic as EpistemicType | null,
      toEpistemic: r.to_epistemic as EpistemicType,
      reason: r.reason as string | null,
      basisSourceId: r.basis_source_id as number | null,
      basisVersion: r.basis_version as number | null,
      batch: r.batch as number | null,
      revertsSeq: r.reverts_seq as number | null,
    }));
}
