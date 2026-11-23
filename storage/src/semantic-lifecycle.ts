// The Semantic registry's lifecycle gate (S01-R5, R6, R11, R12): the one module that changes the
// status, the epistemic type or the user_authored mark of an item, fact or relation. Every change
// writes one history line first and then updates the row; the schema's gate trigger (migration v20)
// lets an UPDATE through only when the row's newest history line says that very change, so a bare
// UPDATE elsewhere fails. An INSERT is not blocked: a creation writes its line with `created`.
//
// `automatedLifecycle` is what extraction, propagation and policy code may call (exported from the
// package index). `applyTransition` takes any actor, the user's included, and is what the user
// actions of `semantic-user.ts` are built on; it is not exported from the index. The transaction is
// the caller's (commitDerived's write, the propagation), never opened here.
//
// The protection of the rows the user decided (S01-R12) is in `applyTransition` and the automated
// entries, ahead of every same-state shortcut: an automated call on such a row is refused with
// `user-override` and writes nothing, except the few the rule names.
//
// A history line holds numbers and codes only, never a name, value or quote (R6).
import { analyticalRowChanged } from "./analytical-check-lines.ts";
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
  | "existing-data-violation"
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
  raiseDispute(
    tx: SqlDriver,
    ref: EntryRef,
    basis: Basis | null,
    at?: string,
    reason?: string,
  ): Outcome;
  /**
   * Policy (S01-R9): a candidate fact or relation becomes verified. The conditions are the caller's
   * (knowledge-engine/auto-verify.ts); the gate refuses an item, a row that is not a candidate, and a
   * row the user decided or wrote (`user-override`, ahead of every other answer).
   */
  autoVerify(tx: SqlDriver, ref: EntryRef, at?: string): Outcome;
  /**
   * Policy (S01-R9, R5 restore): a row the policy verified goes back to the state and epistemic type it
   * had before, because `lost` no longer holds. A row the policy did not verify is `unchanged`.
   */
  autoVerifyLost(tx: SqlDriver, ref: EntryRef, lost: AutoVerifyLoss, at?: string): Outcome;
}

/** The conditions of S01-R9 a promoted row can lose, as the reason code of the restore line. */
export type AutoVerifyLoss = "independent-sources" | "conflicting-value";

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
  // the value fix retires a candidate or disputed value by rejecting it (R7); the line is `replace` too
  { from: "candidate", to: "rejected", actor: "user", action: "replace", kinds: FACT_OR_RELATION },
  { from: "disputed", to: "rejected", actor: "user", action: "replace", kinds: FACT_OR_RELATION },
];

export const NO_CURRENT_EVIDENCE_APPROVAL = "accepted-without-current-evidence";
const EVIDENCE_LOST = "no-current-evidence";

export interface Row {
  status: KnowledgeStatus;
  epistemic: EpistemicType;
}

export function readRow(tx: SqlDriver, ref: EntryRef): Row | undefined {
  const row = tx.all(`SELECT status, epistemic FROM ${TABLES[ref.kind].table} WHERE id = ?`, [
    ref.id,
  ])[0];
  return row
    ? { status: row.status as KnowledgeStatus, epistemic: row.epistemic as EpistemicType }
    : undefined;
}

export interface Line {
  to: Row;
  from: Row | null;
  actor: Actor;
  action: string;
  reason?: string | null;
  basis?: Basis | null;
  batch?: number | null;
  revertsSeq?: number | null;
  at?: string | undefined;
  /** Sets `user_authored` in the same UPDATE; the schema's gate allows it behind an `undo` line only (R8). */
  userAuthored?: 0 | 1;
}

/** Writes the history line, then the row: the order the schema's gate trigger requires. */
export function writeLine(tx: SqlDriver, ref: EntryRef, line: Line): number {
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
    tx.run(
      `UPDATE ${table} SET status = ?, epistemic = ?${
        line.userAuthored === undefined ? "" : ", user_authored = ?"
      } WHERE id = ?`,
      [
        line.to.status,
        line.to.epistemic,
        ...(line.userAuthored === undefined ? [] : [line.userAuthored]),
        ref.id,
      ],
    );
  }
  // a fact or relation a check line reads was made or changed state: erase what read it, queue what reaches it
  analyticalRowChanged(tx, ref, line.at ? new Date(line.at) : undefined);
  return seq;
}

interface TransitionOptions {
  basis?: Basis | null;
  batch?: number | null;
  at?: string | undefined;
  /** Picks the table row of this action when several rows share the pair (the value fix's `replace`). */
  action?: string;
  /** The line's reason code when the transition sets none of its own (a policy dispute's `contradiction`). */
  reason?: string;
}

/**
 * What a user action line is: the actions the user takes (S01-R7), the direct add's creation line
 * (`created` by the user) included. A test seed's line is not one.
 */
const USER_ACTIONS: ReadonlySet<string> = new Set([
  "approve",
  "reject",
  "dispute",
  "replace",
  "created",
]);
export const isUserAction = (l: StoredLine) => l.actor === "user" && USER_ACTIONS.has(l.action);

/**
 * The user actions on a row that no undo cancelled, oldest first (S01 "사용자가 정한 행"). An undo
 * line names the line it reverted; undoing is only possible on the newest line, so a cancelled
 * action is always followed directly by its undo.
 */
function standingUserActions(lines: readonly StoredLine[]): StoredLine[] {
  const cancelled = new Set(lines.filter((l) => l.action === "undo").map((l) => l.revertsSeq));
  return lines.filter((l) => isUserAction(l) && !cancelled.has(l.seq));
}

/** Whether the row carries a user action no undo cancelled: automated code may touch it only as R12 lists. */
export const isUserDecided = (tx: SqlDriver, ref: EntryRef): boolean =>
  standingUserActions(linesOf(tx, ref)).length > 0;

const userAuthored = (tx: SqlDriver, ref: EntryRef): boolean =>
  tx.all(`SELECT user_authored FROM ${TABLES[ref.kind].table} WHERE id = ?`, [ref.id])[0]
    ?.user_authored === 1;

/**
 * The refusal an automated call on a row gets when the user decided it (S01-R12), undefined when it
 * may go on. Two calls pass here: the propagation's supersede and a policy's dispute (whose basis
 * the caller checks). The restore (`evidenceReturned`) does not come through here: it reads the
 * history itself. The supersede is skipped for a row the user wrote and for a row the user approved
 * with no current evidence while that approval is the last standing user action (R12 1).
 */
function automatedRefusal(
  tx: SqlDriver,
  ref: EntryRef,
  actor: Actor,
  to: KnowledgeStatus,
): Outcome | undefined {
  const standing = standingUserActions(linesOf(tx, ref));
  const written = userAuthored(tx, ref);
  if (standing.length === 0 && !written) return undefined;
  const refused: Outcome = { status: "refused", reason: "user-override" };
  if (actor === "policy" && to === "disputed") return undefined;
  if (actor !== "propagation" || to !== "superseded") return refused;
  return written || acceptedWithoutEvidence(standing) ? refused : undefined;
}

/**
 * The row's last standing user action is an approval that rested on no current evidence (R12 1, R15):
 * the user took the value knowing no source of the latest version states it.
 */
function acceptedWithoutEvidence(standing: readonly StoredLine[]): boolean {
  const last = standing.at(-1);
  return last?.action === "approve" && last.reason === NO_CURRENT_EVIDENCE_APPROVAL;
}

/**
 * How a fact or relation is a user input to the rule (S01-R15): `authored` for a row the user wrote,
 * `approved` for a verified row whose approval rested on no current evidence while it is the last
 * standing user action, else null. A row of the second kind that has current evidence again is
 * the caller's to read as an ordinary one: this does not look at the evidence.
 */
export function userInputKind(tx: SqlDriver, ref: EntryRef): "authored" | "approved" | null {
  if (ref.kind === "item") return null;
  if (userAuthored(tx, ref)) return "authored";
  return readRow(tx, ref)?.status === "verified" &&
    acceptedWithoutEvidence(standingUserActions(linesOf(tx, ref)))
    ? "approved"
    : null;
}

/**
 * The line that made a verified row verified when the policy did (S01-R9): the newest line that
 * explains the status, read through cancellations (an undo names the line it reverted) and through
 * evidence returning (a restore names the supersede it reverted, so the status is the one before that
 * supersede). Undefined when the status has another origin or no line explains it.
 */
function policyVerifiedLine(lines: readonly StoredLine[]): StoredLine | undefined {
  let upto = lines;
  for (;;) {
    const line = upto[upto.length - 1];
    if (!line) return undefined;
    if (line.action === "undo" || line.action === "evidence-returned") {
      if (line.revertsSeq === null) return undefined;
      const before: number = line.revertsSeq;
      upto = upto.filter((l) => l.seq < before);
      continue;
    }
    // only the policy writes this action, and only into verified (the table has no other row for it)
    return line.action === "auto-verify" ? line : undefined;
  }
}

/**
 * Moves a row to status `to` by the transition table for `actor`. An automated actor on a row the
 * user decided is refused first (R12: `user-override`, before the same-state shortcut), then
 * `unchanged` when the row already has that status, `invalid-transition` when the table has no such
 * row for the actor and the kind. A policy's dispute needs the source version it rests on. A user
 * approval makes the epistemic type `user-approved`; a fact or relation approved with no current
 * evidence carries the reason code `accepted-without-current-evidence` (R7), which the propagation
 * and the rule (R12, R15) read.
 */
export function applyTransition(
  tx: SqlDriver,
  ref: EntryRef,
  actor: Actor,
  to: KnowledgeStatus,
  options: TransitionOptions = {},
): Outcome {
  const { action: wanted, reason: given, ...lineOptions } = options;
  if (actor === "policy" && to === "disputed" && !options.basis) {
    return { status: "refused", reason: "basis-required" };
  }
  const row = readRow(tx, ref);
  if (!row) return { status: "refused", reason: "not-found" };
  if (actor !== "user") {
    const refusal = automatedRefusal(tx, ref, actor, to);
    if (refusal) return refusal;
  }
  // The user approving a row the policy verified is the one same-state request that is an action: it
  // makes the row the user's (user-approved, a standing user action), so a later loss of the policy's
  // conditions cannot take back what the user approved (S01-T05 decision 5).
  const approvesPolicyRow =
    actor === "user" &&
    to === "verified" &&
    row.status === "verified" &&
    policyVerifiedLine(stateLinesOf(tx, ref)) !== undefined;
  if (row.status === to && !approvesPolicyRow) return { status: "unchanged" };
  const found = approvesPolicyRow
    ? { action: "approve" }
    : TRANSITIONS.find(
        (t) =>
          t.from === row.status &&
          t.to === to &&
          t.actor === actor &&
          t.kinds.includes(ref.kind) &&
          (wanted === undefined || t.action === wanted),
      );
  if (!found) return { status: "refused", reason: "invalid-transition" };
  const approving = actor === "user" && to === "verified";
  const noCurrentEvidence =
    approving &&
    ref.kind !== "item" &&
    !listEvidence(tx, ref.kind === "fact" ? { factId: ref.id } : { relationId: ref.id }).some(
      (e) => e.current,
    );
  const seq = writeLine(tx, ref, {
    from: row,
    to: { status: to, epistemic: approving ? "user-approved" : row.epistemic },
    actor,
    action: found.action,
    reason: noCurrentEvidence
      ? NO_CURRENT_EVIDENCE_APPROVAL
      : found.action === "supersede"
        ? EVIDENCE_LOST
        : (given ?? null),
    ...lineOptions,
  });
  return { status: "applied", seq };
}

export interface StoredLine {
  seq: number;
  actor: Actor;
  action: string;
  reason: string | null;
  fromStatus: KnowledgeStatus | null;
  fromEpistemic: EpistemicType | null;
  toStatus: KnowledgeStatus;
  batch: number | null;
  revertsSeq: number | null;
}

/**
 * The history actions that change neither a status nor an epistemic type (S02-R11, R15, R17,
 * provisional decision 18): a merge, an unmerge, a split and a validity fix. The undo does not revert
 * them and every search for "the last action" (the line to undo, the line that made the state, the
 * last user action) reads past them, so one of them never ends an approval's undo or its protection.
 */
export const STATE_NEUTRAL_ACTIONS: ReadonlySet<string> = new Set([
  "merge",
  "unmerge",
  "split",
  "set-validity",
]);

/** The lines of a row without the state-neutral ones: what the undo and the restore read. */
export const stateLinesOf = (tx: SqlDriver, ref: EntryRef): StoredLine[] =>
  linesOf(tx, ref).filter((l) => !STATE_NEUTRAL_ACTIONS.has(l.action));

export const linesOf = (tx: SqlDriver, ref: EntryRef): StoredLine[] => {
  const { history, fk } = TABLES[ref.kind];
  return tx
    .all(
      `SELECT seq, actor, action, reason, from_status, from_epistemic, to_status, batch, reverts_seq
       FROM ${history} WHERE ${fk} = ? ORDER BY seq`,
      [ref.id],
    )
    .map((r: SqlRow) => ({
      seq: r.seq as number,
      actor: r.actor as Actor,
      action: r.action as string,
      reason: r.reason as string | null,
      fromStatus: r.from_status as KnowledgeStatus | null,
      fromEpistemic: r.from_epistemic as EpistemicType | null,
      toStatus: r.to_status as KnowledgeStatus,
      batch: r.batch as number | null,
      revertsSeq: r.reverts_seq as number | null,
    }));
};

/**
 * The line that made the row's current state. A cancellation is read as the line before the
 * action it reverted (R5: the line that made the state it returned to), and so on through
 * cancellations of cancellations. Undefined when no line explains the state (a row from before
 * S01, or one never changed), "unreadable" for a cancellation that names no line.
 */
function stateMaker(lines: readonly StoredLine[]): StoredLine | undefined | "unreadable" {
  let line = lines[lines.length - 1];
  while (line?.action === "undo") {
    // the gate always names the line it reverted; one that does not is no history to restore from
    if (line.revertsSeq === null) return "unreadable";
    const reverted: number = line.revertsSeq;
    // the line before it: a state-neutral line between the two (S02-R11) is no state to restore
    line = lines.findLast((l) => l.seq < reverted);
  }
  return line;
}

/** Only facts and relations hold evidence, so only they can have it return or be stated explicit. */
const holdsEvidence = (ref: EntryRef) => FACT_OR_RELATION.includes(ref.kind);

export const automatedLifecycle: AutomatedLifecycle = {
  created(tx, ref, actor, basis, at) {
    // the user's creation line is the direct add's (semantic-user.ts) and counts as a user action (R12)
    if (actor === "user")
      throw new Error("a creation line by the user is written by the user entry");
    const row = readRow(tx, ref);
    if (!row) throw new Error(`${ref.kind} ${ref.id} not found`);
    writeLine(tx, ref, { from: null, to: row, actor, action: "created", basis, at });
  },

  supersede: (tx, ref, basis, at) =>
    applyTransition(tx, ref, "propagation", "superseded", { basis, at }),

  evidenceReturned(tx, ref, basis, at) {
    if (!holdsEvidence(ref)) return { status: "refused", reason: "invalid-transition" };
    const row = readRow(tx, ref);
    if (!row) return { status: "refused", reason: "not-found" };
    if (row.status !== "superseded") return { status: "unchanged" };
    const maker = stateMaker(stateLinesOf(tx, ref));
    if (maker === "unreadable") return { status: "refused", reason: "invalid-transition" };
    // a row from before S01 has no line: the cautious state is a candidate
    let to: Row = { status: "candidate", epistemic: row.epistemic };
    if (maker) {
      if (maker.actor === "user") return { status: "refused", reason: "user-override" };
      if (maker.actor !== "propagation" || maker.toStatus !== "superseded" || !maker.fromStatus) {
        return { status: "refused", reason: "invalid-transition" };
      }
      to = { status: maker.fromStatus, epistemic: maker.fromEpistemic as EpistemicType };
    }
    const seq = writeLine(tx, ref, {
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
    // R12: a row the user decided is never raised, and the refusal comes before the shortcut
    if (isUserDecided(tx, ref)) return { status: "refused", reason: "user-override" };
    if (row.epistemic !== "hypothesis") return { status: "unchanged" };
    const seq = writeLine(tx, ref, {
      from: row,
      to: { status: row.status, epistemic: "explicit" },
      actor: "extraction",
      action: "explicit-evidence",
      basis,
      at,
    });
    return { status: "applied", seq };
  },

  raiseDispute: (tx, ref, basis, at, reason) =>
    applyTransition(tx, ref, "policy", "disputed", { basis, at, ...(reason ? { reason } : {}) }),

  autoVerify: (tx, ref, at) => applyTransition(tx, ref, "policy", "verified", { at }),

  autoVerifyLost(tx, ref, lost, at) {
    if (!holdsEvidence(ref)) return { status: "refused", reason: "invalid-transition" };
    const row = readRow(tx, ref);
    if (!row) return { status: "refused", reason: "not-found" };
    // R12: a row the user decided or wrote (its creation line is a user action) is never taken back
    if (isUserDecided(tx, ref)) {
      return { status: "refused", reason: "user-override" };
    }
    const promoted = policyVerifiedLine(stateLinesOf(tx, ref));
    if (row.status !== "verified" || !promoted || !promoted.fromStatus) {
      return { status: "unchanged" };
    }
    const seq = writeLine(tx, ref, {
      from: row,
      to: { status: promoted.fromStatus, epistemic: promoted.fromEpistemic as EpistemicType },
      actor: "policy",
      action: "auto-verify-reverted",
      reason: lost,
      revertsSeq: promoted.seq, // the line that verified it (R6: a restore names what it reverts)
      at,
    });
    return { status: "applied", seq };
  },
};
