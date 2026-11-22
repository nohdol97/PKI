// The Semantic registry's lifecycle gate (S01-R5, R6, R11, R12): the one module that changes the
// status, the epistemic type or the user_authored mark of an item, fact or relation. Every change
// writes one history line first and then updates the row; the schema's gate trigger (migration v20)
// lets an UPDATE through only when the row's newest history line says that very change, so a bare
// UPDATE elsewhere fails. An INSERT is not blocked: a creation writes its line with `created`.
//
// `automatedLifecycle` is what extraction, propagation and policy code may call (exported from the
// package index). `applyTransition` takes any actor, the user's included, and is what the user
// actions of S01-T02 are built on; it is not exported from the index. The transaction is the
// caller's (commitDerived's write, the propagation), never opened here.
//
// A history line holds numbers and codes only, never a name, value or quote (R6).
import { listEvidence, type EpistemicType, type KnowledgeStatus } from "./knowledge.ts";
import type { SqlDriver, SqlRow } from "./sql-driver.ts";

export type Actor = "user" | "extraction" | "propagation" | "policy";
export type EntryKind = "item" | "fact" | "relation";
export interface EntryRef {
  kind: EntryKind;
  id: number;
}
/** The source version a change rests on: a number pair, not text. */
export interface Basis {
  sourceId: number;
  version: number;
}
export type Refusal =
  | "invalid-transition"
  | "user-override"
  | "basis-required"
  | "not-latest"
  | "nothing-to-undo"
  | "value-exists"
  | "not-found";
export type Outcome =
  /** `seq` is the history line the change wrote. */
  | { status: "applied"; seq: number }
  /** Already in that state; no line is written. */
  | { status: "unchanged" }
  | { status: "refused"; reason: Refusal };

/** What extraction, propagation and policy code may call (the interface of the S01 spec). */
export interface AutomatedLifecycle {
  /** Writes the creation line of a row just inserted. */
  created(tx: SqlDriver, ref: EntryRef, actor: Actor, basis: Basis | null, at?: string): void;
  /** Propagation: a row left without current evidence becomes superseded. */
  supersede(tx: SqlDriver, ref: EntryRef, basis: Basis, at?: string): Outcome;
  /** Extraction: restores a row propagation superseded to the state it had before. */
  evidenceReturned(tx: SqlDriver, ref: EntryRef, basis: Basis, at?: string): Outcome;
  /** Extraction: a hypothesis row that gets evidence stated as explicit becomes explicit. */
  explicitEvidence(tx: SqlDriver, ref: EntryRef, basis: Basis, at?: string): Outcome;
  /** Policy: verified becomes disputed; needs the source version it rests on. */
  raiseDispute(tx: SqlDriver, ref: EntryRef, basis: Basis | null, at?: string): Outcome;
}

const TABLES = {
  item: { table: "items", history: "item_history", fk: "item_id" },
  fact: { table: "facts", history: "fact_history", fk: "fact_id" },
  relation: { table: "relations", history: "relation_history", fk: "relation_id" },
} as const;

const ALL: readonly EntryKind[] = ["item", "fact", "relation"];
const FACT_OR_RELATION: readonly EntryKind[] = ["fact", "relation"];

interface Transition {
  from: KnowledgeStatus;
  to: KnowledgeStatus;
  actor: Actor;
  action: string;
  kinds: readonly EntryKind[];
}

/**
 * The transitions of S01-R5, one row each. An item takes only the user's rows (it has no evidence
 * to lose and is not promoted by policy, provisional decision 12). The user's `verified` ->
 * `superseded` is the value fix, which a fact or relation has. Restores (cancelling a user action,
 * evidence returning, an auto-promotion losing its basis) are not transitions and are not listed.
 */
export const TRANSITIONS: readonly Transition[] = [
  { from: "candidate", to: "verified", actor: "user", action: "approve", kinds: ALL },
  {
    from: "candidate",
    to: "verified",
    actor: "policy",
    action: "auto-verify",
    kinds: FACT_OR_RELATION,
  },
  { from: "candidate", to: "rejected", actor: "user", action: "reject", kinds: ALL },
  { from: "verified", to: "disputed", actor: "user", action: "dispute", kinds: ALL },
  { from: "verified", to: "disputed", actor: "policy", action: "dispute", kinds: FACT_OR_RELATION },
  { from: "disputed", to: "verified", actor: "user", action: "approve", kinds: ALL },
  { from: "disputed", to: "rejected", actor: "user", action: "reject", kinds: ALL },
  { from: "superseded", to: "verified", actor: "user", action: "approve", kinds: ALL },
  { from: "rejected", to: "verified", actor: "user", action: "approve", kinds: ALL },
  ...(["candidate", "verified", "disputed"] as const).map((from): Transition => ({
    from,
    to: "superseded",
    actor: "propagation",
    action: "supersede",
    kinds: FACT_OR_RELATION,
  })),
  { from: "verified", to: "superseded", actor: "user", action: "replace", kinds: FACT_OR_RELATION },
];

export const NO_CURRENT_EVIDENCE_APPROVAL = "accepted-without-current-evidence";
const EVIDENCE_LOST = "no-current-evidence";

interface Row {
  status: KnowledgeStatus;
  epistemic: EpistemicType;
}

function readRow(tx: SqlDriver, ref: EntryRef): Row | undefined {
  const row = tx.all(`SELECT status, epistemic FROM ${TABLES[ref.kind].table} WHERE id = ?`, [
    ref.id,
  ])[0];
  return row
    ? { status: row.status as KnowledgeStatus, epistemic: row.epistemic as EpistemicType }
    : undefined;
}

interface Line {
  to: Row;
  from: Row | null;
  actor: Actor;
  action: string;
  reason?: string | null;
  basis?: Basis | null;
  batch?: number | null;
  revertsSeq?: number | null;
  at?: string | undefined;
}

/** Writes the history line, then the row: the order the schema's gate trigger requires. */
function write(tx: SqlDriver, ref: EntryRef, line: Line): number {
  const { table, history, fk } = TABLES[ref.kind];
  const seq =
    (tx.all(`SELECT coalesce(max(seq), 0) + 1 AS next FROM ${history} WHERE ${fk} = ?`, [ref.id])[0]
      ?.next as number) ?? 1;
  tx.run(
    `INSERT INTO ${history} (${fk}, seq, at, actor, action, from_status, to_status, from_epistemic,
       to_epistemic, reason, basis_source_id, basis_version, batch, reverts_seq)
     VALUES (?, ?, coalesce(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ref.id,
      seq,
      line.at ?? null,
      line.actor,
      line.action,
      line.from?.status ?? null,
      line.to.status,
      line.from?.epistemic ?? null,
      line.to.epistemic,
      line.reason ?? null,
      line.basis?.sourceId ?? null,
      line.basis?.version ?? null,
      line.batch ?? null,
      line.revertsSeq ?? null,
    ],
  );
  if (line.from) {
    tx.run(`UPDATE ${table} SET status = ?, epistemic = ? WHERE id = ?`, [
      line.to.status,
      line.to.epistemic,
      ref.id,
    ]);
  }
  return seq;
}

interface TransitionOptions {
  basis?: Basis | null;
  batch?: number | null;
  at?: string | undefined;
}

/**
 * Moves a row to status `to` by the transition table for `actor`: `unchanged` when it already has
 * that status, `invalid-transition` when the table has no such row for the actor and the kind. A
 * user approval makes the epistemic type `user-approved`; a fact or relation approved with no
 * current evidence carries the reason code `accepted-without-current-evidence` (R7), which the
 * propagation and the rule (R12, R15) read. The user's guards of R12 belong to S01-T02.
 */
export function applyTransition(
  tx: SqlDriver,
  ref: EntryRef,
  actor: Actor,
  to: KnowledgeStatus,
  options: TransitionOptions = {},
): Outcome {
  const row = readRow(tx, ref);
  if (!row) return { status: "refused", reason: "not-found" };
  if (row.status === to) return { status: "unchanged" };
  const found = TRANSITIONS.find(
    (t) => t.from === row.status && t.to === to && t.actor === actor && t.kinds.includes(ref.kind),
  );
  if (!found) return { status: "refused", reason: "invalid-transition" };
  const approving = actor === "user" && to === "verified";
  const noCurrentEvidence =
    approving &&
    ref.kind !== "item" &&
    !listEvidence(tx, ref.kind === "fact" ? { factId: ref.id } : { relationId: ref.id }).some(
      (e) => e.current,
    );
  const seq = write(tx, ref, {
    from: row,
    to: { status: to, epistemic: approving ? "user-approved" : row.epistemic },
    actor,
    action: found.action,
    reason: noCurrentEvidence
      ? NO_CURRENT_EVIDENCE_APPROVAL
      : found.action === "supersede"
        ? EVIDENCE_LOST
        : null,
    ...options,
  });
  return { status: "applied", seq };
}

interface StoredLine {
  seq: number;
  actor: Actor;
  action: string;
  fromStatus: KnowledgeStatus | null;
  fromEpistemic: EpistemicType | null;
  toStatus: KnowledgeStatus;
  revertsSeq: number | null;
}

const linesOf = (tx: SqlDriver, ref: EntryRef): StoredLine[] => {
  const { history, fk } = TABLES[ref.kind];
  return tx
    .all(
      `SELECT seq, actor, action, from_status, from_epistemic, to_status, reverts_seq
       FROM ${history} WHERE ${fk} = ? ORDER BY seq`,
      [ref.id],
    )
    .map((r: SqlRow) => ({
      seq: r.seq as number,
      actor: r.actor as Actor,
      action: r.action as string,
      fromStatus: r.from_status as KnowledgeStatus | null,
      fromEpistemic: r.from_epistemic as EpistemicType | null,
      toStatus: r.to_status as KnowledgeStatus,
      revertsSeq: r.reverts_seq as number | null,
    }));
};

/**
 * The line that made the row's current state. A cancellation is read as the line before the
 * action it reverted (R5: the line that made the state it returned to), and so on through
 * cancellations of cancellations. Undefined when no line explains the state (a row from before
 * S01, or one never changed).
 */
function stateMaker(lines: readonly StoredLine[]): StoredLine | undefined {
  let line = lines[lines.length - 1];
  while (line?.action === "undo") {
    const before: number = (line.revertsSeq ?? 1) - 1;
    line = lines.find((l) => l.seq === before);
  }
  return line;
}

/** Only facts and relations hold evidence, so only they can have it return or be stated explicit. */
const holdsEvidence = (ref: EntryRef) => FACT_OR_RELATION.includes(ref.kind);

export const automatedLifecycle: AutomatedLifecycle = {
  created(tx, ref, actor, basis, at) {
    const row = readRow(tx, ref);
    if (!row) throw new Error(`${ref.kind} ${ref.id} not found`);
    write(tx, ref, { from: null, to: row, actor, action: "created", basis, at });
  },

  supersede: (tx, ref, basis, at) =>
    applyTransition(tx, ref, "propagation", "superseded", { basis, at }),

  evidenceReturned(tx, ref, basis, at) {
    if (!holdsEvidence(ref)) return { status: "refused", reason: "invalid-transition" };
    const row = readRow(tx, ref);
    if (!row) return { status: "refused", reason: "not-found" };
    if (row.status !== "superseded") return { status: "unchanged" };
    const maker = stateMaker(linesOf(tx, ref));
    // a row from before S01 has no line: the cautious state is a candidate
    let to: Row = { status: "candidate", epistemic: row.epistemic };
    if (maker) {
      if (maker.actor === "user") return { status: "refused", reason: "user-override" };
      if (maker.actor !== "propagation" || maker.toStatus !== "superseded" || !maker.fromStatus) {
        return { status: "refused", reason: "invalid-transition" };
      }
      to = { status: maker.fromStatus, epistemic: maker.fromEpistemic as EpistemicType };
    }
    const seq = write(tx, ref, {
      from: row,
      to,
      actor: "extraction",
      action: "evidence-returned",
      basis,
      revertsSeq: maker?.seq ?? null, // the line that superseded it (R6: a restore names what it reverts)
      at,
    });
    return { status: "applied", seq };
  },

  explicitEvidence(tx, ref, basis, at) {
    if (!holdsEvidence(ref)) return { status: "refused", reason: "invalid-transition" };
    const row = readRow(tx, ref);
    if (!row) return { status: "refused", reason: "not-found" };
    if (row.epistemic !== "hypothesis") return { status: "unchanged" };
    const seq = write(tx, ref, {
      from: row,
      to: { status: row.status, epistemic: "explicit" },
      actor: "extraction",
      action: "explicit-evidence",
      basis,
      at,
    });
    return { status: "applied", seq };
  },

  raiseDispute(tx, ref, basis, at) {
    if (!basis) return { status: "refused", reason: "basis-required" };
    return applyTransition(tx, ref, "policy", "disputed", { basis, at });
  },
};
