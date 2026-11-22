// The user's entry to the Semantic registry's lifecycle (S01-R7, R8): approve, reject, dispute and
// undo, built on the gate's `applyTransition` with the actor `user`. It is exported from the package
// index but its value may be imported only by the composition point (backend/src/composition.ts),
// which hands it to the API layer (backend/src/server.ts, which may name its types only) (module-boundary
// lint, `lifecycle.actor-boundary`): extraction,
// propagation and the job runner reach the registry through `automatedLifecycle` alone, which has
// no function that approves or rejects. The transaction is the caller's.
//
// Adding a value and fixing one (T03) are built here later and undone by the same `undo`.
import {
  applyTransition,
  isUserAction,
  linesOf,
  readRow,
  writeLine,
  type EntryRef,
  type Outcome,
} from "./semantic-lifecycle.ts";
import type { SqlDriver } from "./sql-driver.ts";

export type UserAction = "approve" | "reject" | "dispute";

const TARGET = { approve: "verified", reject: "rejected", dispute: "disputed" } as const;

/** The user actions an undo reverts here: the three of T02. A value fix is T03's (it undoes a batch). */
const UNDOABLE: ReadonlySet<string> = new Set<UserAction>(["approve", "reject", "dispute"]);

/** The user's entry (the interface of the S01 spec, without what T03 adds). */
export interface UserDecisions {
  /** Approve, reject or dispute one row by the user's rows of the transition table. */
  decide(tx: SqlDriver, ref: EntryRef, action: UserAction, at?: string): Outcome;
  /**
   * Cancels the row's newest line when it is a user action: back to the state and the epistemic
   * type that line replaced, read from the line (S01-R8). `not-latest` when a later line of
   * another actor is newest, `nothing-to-undo` for a row with no line or whose newest line is an undo.
   */
  undo(tx: SqlDriver, ref: EntryRef, at?: string): Outcome;
}

export const userDecisions: UserDecisions = {
  decide: (tx, ref, action, at) => applyTransition(tx, ref, "user", TARGET[action], { at }),

  undo(tx, ref, at) {
    const row = readRow(tx, ref);
    if (!row) return { status: "refused", reason: "not-found" };
    const newest = linesOf(tx, ref).at(-1);
    if (!newest || newest.action === "undo")
      return { status: "refused", reason: "nothing-to-undo" };
    if (!isUserAction(newest)) return { status: "refused", reason: "not-latest" };
    if (!UNDOABLE.has(newest.action) || !newest.fromStatus || !newest.fromEpistemic) {
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
  },
};
