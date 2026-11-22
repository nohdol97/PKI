// The user's entry to the Semantic registry's lifecycle (S01-R7, R8): approve, reject, dispute, the
// direct add, the value fix and undo, built on the gate's `applyTransition` and `writeLine` with the
// actor `user`. It is exported from the package
// index but its value may be imported only by the composition point (backend/src/composition.ts),
// which hands it to the API layer (backend/src/server.ts, which may name its types only) (module-boundary
// lint, `lifecycle.actor-boundary`): extraction,
// propagation and the job runner reach the registry through `automatedLifecycle` alone, which has
// no function that approves or rejects. The transaction is the caller's.
//
// A direct add makes a row the user wrote (`user_authored`, verified, user-approved, no evidence).
// A value fix is one batch: the old fact is retired by the user (superseded when it was verified,
// rejected when it was a candidate or disputed) and the new value is added; one undo takes both back.
// The type definitions' user operations (ontology.ts, S01-T07) and entity resolution's (entity-decisions.ts,
// S02-T04: merge, unmerge, the distinct mark) travel in the same object, so the one lint-guarded name
// `userDecisions` (and its constructor `createUserDecisions`, which the composition root calls) is the only way to them.
import { listEvidence } from "./knowledge.ts";
import { findSameForm, isSurfaceFormKind } from "./surface-form.ts";
import {
  applyTransition,
  isUserAction,
  readRow,
  stateLinesOf,
  writeLine,
  type EntryRef,
  type Outcome,
  type Refusal,
  type Row,
} from "./semantic-lifecycle.ts";
import {
  createEntityDecisions,
  type EntityDecisions,
  type EntityDecisionsOptions,
} from "./entity-decisions.ts";
import { scopesOfVersions } from "./derivatives.ts";
import { defaultScopePolicy, mayCombine } from "./scope-policy.ts";
import { userOntology, type UserOntologyDecisions } from "./ontology.ts";
import type { SqlDriver } from "./sql-driver.ts";

export type UserAction = "approve" | "reject" | "dispute";

const TARGET = { approve: "verified", reject: "rejected", dispute: "disputed" } as const;

/** The user actions an undo reverts on a single row: approve, reject, dispute. */
const UNDOABLE: ReadonlySet<string> = new Set<UserAction>(["approve", "reject", "dispute"]);

/** What a direct add writes (S01-R7): the value of an item, fact or relation, as the user typed it. */
export type UserEntry =
  | { kind: "item"; type: string; name: string }
  | { kind: "fact"; itemId: number; factKind: string; value: string }
  | { kind: "relation"; subjectId: number; type: string; objectId: number };

export type AddResult =
  | { status: "applied"; ref: EntryRef; seq: number }
  /** The row with that key exists in any status: nothing was written; approving `existing` is the next step. */
  | { status: "refused"; reason: "value-exists"; existing: EntryRef }
  /** The item a fact belongs to, or a relation's subject or object, is not stored. */
  | { status: "refused"; reason: "not-found" };

export type ReplaceResult =
  | { status: "applied"; replaced: EntryRef; added: EntryRef; seq: number }
  | { status: "refused"; reason: Refusal; existing?: EntryRef };

/** What hangs on an item (S02-R11): the rows, merge lines, distinct marks and split records that name it. */
export interface HeldCounts {
  facts: number;
  relations: number;
  merges: number;
  distinct: number;
  splitMoves: number;
}

/**
 * `removed`: the undo deleted the row (a direct add nothing had touched), so there is no state to report.
 * `existing-data-violation` carries the counts of what hangs on the item, never a name or a value.
 */
export type UndoResult =
  | Outcome
  | { status: "removed" }
  | { status: "refused"; reason: "existing-data-violation"; held: HeldCounts };

/** The user's entry (the interface of the S01 spec). */
export interface UserDecisions {
  /** Approve, reject or dispute one row by the user's rows of the transition table. */
  decide(tx: SqlDriver, ref: EntryRef, action: UserAction, at?: string): Outcome;
  /**
   * Adds a row the user wrote: verified, user-approved, user_authored, no evidence (S01-R7). The
   * key of the row (the item's type and name, a fact's item, kind and value, a relation's triple)
   * must be free in every status; otherwise `value-exists` with the row that has it.
   */
  add(tx: SqlDriver, entry: UserEntry, at?: string): AddResult;
  /**
   * Fixes a fact's value: one batch of the old fact retired by the user (a verified one is
   * superseded, a candidate or disputed one rejected) and the new value added as a user-written
   * row (S01-R7). A superseded or rejected fact is `invalid-transition`; a value the item already
   * has in any status is `value-exists`.
   */
  replaceValue(tx: SqlDriver, fact: EntryRef, value: string, at?: string): ReplaceResult;
  /**
   * Cancels the row's newest line when it is a user action: back to the state and the epistemic
   * type that line replaced, read from the line (S01-R8). The rows of a value fix go back together
   * or not at all (`not-latest` when any of them has a later line). Cancelling a direct add deletes
   * the row (`removed`), or keeps it as an extraction's candidate hypothesis when evidence was
   * added meanwhile (provisional decision 6). `not-latest` when a later line of another actor is
   * newest, `nothing-to-undo` for a row with no line or whose newest line is an undo.
   */
  undo(tx: SqlDriver, ref: EntryRef, at?: string): UndoResult;
  /** The type definitions' user operations (S01-T07): change, approve and reject a candidate, undo. */
  readonly ontology: UserOntologyDecisions;
  /** Entity resolution's user operations (S02-T04): merge, unmerge, the distinct mark. */
  readonly entities: EntityDecisions;
}

const TABLE = { item: "items", fact: "facts", relation: "relations" } as const;
const NOW = "coalesce(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";

/** The row that holds the entry's key, if any: the same-row rule of V02-R8 in every status. */
function existingKey(tx: SqlDriver, entry: UserEntry): EntryRef | undefined {
  const found =
    entry.kind === "item"
      ? tx.all("SELECT id FROM items WHERE type = ? AND name = ? ORDER BY id LIMIT 1", [
          entry.type,
          entry.name,
        ])[0]
      : entry.kind === "fact" && isSurfaceFormKind(entry.factKind)
        ? // a surface form is the same row by the V02-R7 processing, as extraction judges it (S01-R2)
          (() => {
            const id = findSameForm(tx, entry.itemId, entry.factKind, entry.value);
            return id === undefined ? undefined : { id };
          })()
        : entry.kind === "fact"
          ? tx.all("SELECT id FROM facts WHERE item_id = ? AND kind = ? AND value = ?", [
              entry.itemId,
              entry.factKind,
              entry.value,
            ])[0]
          : tx.all("SELECT id FROM relations WHERE subject_id = ? AND type = ? AND object_id = ?", [
              entry.subjectId,
              entry.type,
              entry.objectId,
            ])[0];
  return found ? { kind: entry.kind, id: found.id as number } : undefined;
}

const itemStored = (tx: SqlDriver, id: number) =>
  tx.all("SELECT 1 FROM items WHERE id = ?", [id]).length === 1;

/** Inserts the row the user wrote and its creation line; `batch` ties it to the fix that made it. */
function insertAuthored(
  tx: SqlDriver,
  entry: UserEntry,
  at: string | undefined,
  batch: number | null,
) {
  const common = ["'user-approved'", "'verified'", "NULL", NOW, "NULL", "1"];
  const columns = "epistemic, status, valid_at, observed_at, confidence, user_authored";
  const id = (
    entry.kind === "item"
      ? tx.run(`INSERT INTO items (type, name, ${columns}) VALUES (?, ?, ${common.join(", ")})`, [
          entry.type,
          entry.name,
          at ?? null,
        ])
      : entry.kind === "fact"
        ? tx.run(
            `INSERT INTO facts (item_id, kind, value, ${columns}) VALUES (?, ?, ?, ${common.join(", ")})`,
            [entry.itemId, entry.factKind, entry.value, at ?? null],
          )
        : tx.run(
            `INSERT INTO relations (subject_id, type, object_id, ${columns})
             VALUES (?, ?, ?, ${common.join(", ")})`,
            [entry.subjectId, entry.type, entry.objectId, at ?? null],
          )
  ).lastInsertRowid;
  const ref: EntryRef = { kind: entry.kind, id };
  const seq = writeLine(tx, ref, {
    from: null,
    to: { status: "verified", epistemic: "user-approved" },
    actor: "user",
    action: "created",
    batch,
    at,
  });
  return { ref, seq };
}

/** The next batch number: the fact history is where a value fix writes its lines. */
const nextBatch = (tx: SqlDriver): number =>
  (tx.all("SELECT coalesce(max(batch), 0) + 1 AS next FROM fact_history")[0]?.next as number) ?? 1;

/** What names the item: its facts and relations, merge lines, distinct marks and split records (S02-R11). */
function heldBy(tx: SqlDriver, id: number): HeldCounts {
  const count = (sql: string, params: number[]) => tx.all(sql, params)[0]?.n as number;
  return {
    facts: count("SELECT count(*) AS n FROM facts WHERE item_id = ?", [id]),
    relations: count("SELECT count(*) AS n FROM relations WHERE subject_id = ? OR object_id = ?", [
      id,
      id,
    ]),
    merges: count(
      "SELECT count(*) AS n FROM item_merges WHERE member_id = ? OR representative_id = ?",
      [id, id],
    ),
    distinct: count("SELECT count(*) AS n FROM item_distinct WHERE item_a = ? OR item_b = ?", [
      id,
      id,
    ]),
    splitMoves: count(
      "SELECT count(*) AS n FROM item_split_moves WHERE from_item_id = ? OR to_item_id = ?",
      [id, id],
    ),
  };
}

/**
 * Cancels the creation line of a row the user wrote. Nothing came to it: the row goes (its history
 * with it). Evidence an extraction attached meanwhile keeps it, as a candidate hypothesis that is no
 * longer the user's (provisional decision 6). An item that anything hangs on is kept as it is, the
 * counts are the answer: `existing-data-violation` (S02-R11), the same code the type definitions' undo
 * refuses with. Deleting it would take the user's moved rows and merge lines with it.
 */
function undoCreated(
  tx: SqlDriver,
  ref: EntryRef,
  row: Row,
  created: { seq: number },
  at: string | undefined,
): UndoResult {
  if (ref.kind === "item") {
    const held = heldBy(tx, ref.id);
    if (Object.values(held).some((n) => n > 0)) {
      return { status: "refused", reason: "existing-data-violation", held };
    }
    tx.run("DELETE FROM items WHERE id = ?", [ref.id]);
    return { status: "removed" };
  }
  const held =
    listEvidence(tx, ref.kind === "fact" ? { factId: ref.id } : { relationId: ref.id }).length > 0;
  if (!held) {
    tx.run(`DELETE FROM ${TABLE[ref.kind]} WHERE id = ?`, [ref.id]);
    return { status: "removed" };
  }
  const seq = writeLine(tx, ref, {
    from: row,
    to: { status: "candidate", epistemic: "hypothesis" },
    actor: "user",
    action: "undo",
    revertsSeq: created.seq,
    userAuthored: 0,
    at,
  });
  return { status: "applied", seq };
}

/** Cancels one user action line of a row, back to the state before it. */
function revertLine(
  tx: SqlDriver,
  ref: EntryRef,
  row: Row,
  newest: ReturnType<typeof stateLinesOf>[number],
  at: string | undefined,
): UndoResult {
  if (newest.action === "created") return undoCreated(tx, ref, row, newest, at);
  if (!newest.fromStatus || !newest.fromEpistemic) {
    return { status: "refused", reason: "invalid-transition" };
  }
  const seq = writeLine(tx, ref, {
    from: row,
    to: { status: newest.fromStatus, epistemic: newest.fromEpistemic },
    actor: "user",
    action: "undo",
    revertsSeq: newest.seq,
    at,
  });
  return { status: "applied", seq };
}

/**
 * Undoes the batch of the line `newest` carries: every row of it must still have that line as its
 * newest, and all go back or none does (S01-R8). The answer is the requested row's.
 */
function undoBatch(
  tx: SqlDriver,
  ref: EntryRef,
  newest: ReturnType<typeof stateLinesOf>[number],
  at: string | undefined,
): UndoResult {
  if (ref.kind !== "fact" || newest.batch === null) {
    return { status: "refused", reason: "invalid-transition" };
  }
  const members = tx
    .all("SELECT fact_id, seq FROM fact_history WHERE batch = ? ORDER BY fact_id", [newest.batch])
    .map((r) => ({
      ref: { kind: "fact", id: r.fact_id as number } as EntryRef,
      seq: r.seq as number,
    }));
  const lines = members.map((m) => ({ m, newest: stateLinesOf(tx, m.ref).at(-1) }));
  // a member deleted since leaves fewer rows than the fix made; one with a later line is not at its fix
  const whole = members.length >= 2 && lines.every((l) => l.newest?.seq === l.m.seq);
  if (!whole) return { status: "refused", reason: "not-latest" };
  let answer: UndoResult | undefined;
  // from here a member may already be reverted: a refusal would be committed by a caller that keeps
  // returned values, so what cannot be reverted throws and the caller's transaction rolls back
  for (const { m, newest: line } of lines) {
    const row = readRow(tx, m.ref);
    if (!row || !line) throw new Error("a row of the batch vanished during its undo");
    const result = revertLine(tx, m.ref, row, line, at);
    if (result.status === "refused")
      throw new Error(`a row of the batch cannot be reverted: ${result.reason}`);
    if (m.ref.id === ref.id) answer = result;
  }
  if (!answer) throw new Error("the requested row is not in its batch");
  return answer;
}

const buildUserDecisions = (entities: EntityDecisions): UserDecisions => ({
  ontology: userOntology,
  entities,

  decide: (tx, ref, action, at) => applyTransition(tx, ref, "user", TARGET[action], { at }),

  add(tx, entry, at) {
    const stored =
      entry.kind === "item"
        ? true
        : entry.kind === "fact"
          ? itemStored(tx, entry.itemId)
          : itemStored(tx, entry.subjectId) && itemStored(tx, entry.objectId);
    if (!stored) return { status: "refused", reason: "not-found" };
    const existing = existingKey(tx, entry);
    if (existing) return { status: "refused", reason: "value-exists", existing };
    const { ref, seq } = insertAuthored(tx, entry, at, null);
    return { status: "applied", ref, seq };
  },

  replaceValue(tx, fact, value, at) {
    const old = tx.all("SELECT item_id, kind, value, status FROM facts WHERE id = ?", [fact.id])[0];
    if (fact.kind !== "fact" || !old) return { status: "refused", reason: "not-found" };
    if (old.status !== "candidate" && old.status !== "verified" && old.status !== "disputed") {
      return { status: "refused", reason: "invalid-transition" };
    }
    const entry: UserEntry = {
      kind: "fact",
      itemId: old.item_id as number,
      factKind: old.kind as string,
      value,
    };
    const existing = existingKey(tx, entry);
    if (existing) return { status: "refused", reason: "value-exists", existing };
    const batch = nextBatch(tx);
    const retired = applyTransition(
      tx,
      fact,
      "user",
      old.status === "verified" ? "superseded" : "rejected",
      { action: "replace", batch, at },
    );
    if (retired.status !== "applied") {
      return {
        status: "refused",
        reason: retired.status === "refused" ? retired.reason : "invalid-transition",
      };
    }
    const added = insertAuthored(tx, entry, at, batch);
    return { status: "applied", replaced: fact, added: added.ref, seq: added.seq };
  },

  undo(tx, ref, at) {
    const row = readRow(tx, ref);
    if (!row) return { status: "refused", reason: "not-found" };
    // a merge, an unmerge, a split or a validity fix is read past (S02-R11): it is no state to go back to
    const newest = stateLinesOf(tx, ref).at(-1);
    if (!newest || newest.action === "undo")
      return { status: "refused", reason: "nothing-to-undo" };
    if (!isUserAction(newest)) return { status: "refused", reason: "not-latest" };
    if (newest.batch !== null) return undoBatch(tx, ref, newest, at);
    if (newest.action !== "created" && !UNDOABLE.has(newest.action)) {
      // a `replace` line with no batch is no value fix this entry made
      return { status: "refused", reason: "invalid-transition" };
    }
    return revertLine(tx, ref, row, newest, at);
  },
});

/**
 * The user's entry as the composition root builds it: the scope policy and the fixed list of membership
 * listeners are its own (S02-R13). The module-boundary lint lets the composition root and the API layer's
 * types hold this name and no other code.
 */
export const createUserDecisions = (
  options: Omit<EntityDecisionsOptions, "createItem">,
): UserDecisions =>
  buildUserDecisions(
    createEntityDecisions({
      ...options,
      // a split's new item is a direct add; its name may equal the original's (no key stops that), so the
      // value-exists check of `add` is not asked
      createItem: (tx, type, name, at) =>
        insertAuthored(tx, { kind: "item", type, name }, at, null).ref.id,
    }),
  );

/** The entry with the public default policy (it refuses nothing) and no listener: what a test without a composition point uses. */
export const userDecisions: UserDecisions = createUserDecisions({
  combinable: (db, lineage) => mayCombine(defaultScopePolicy, scopesOfVersions(db, lineage)),
  listeners: [],
});
