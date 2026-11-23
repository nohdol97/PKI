// "유효" (S01-R15) for a fact or relation: the predicate the dependency-delay rule reads and
// the automatic promotion's condition 5 and the conflict reads ask too. It lives in storage because the
// analytical gate (S03) and the conflict reads are storage code.
import { listEvidence, type EvidenceTarget, type KnowledgeStatus } from "./knowledge.ts";
import type { UserInputRef } from "./insights.ts";
import { userInputKind } from "./semantic-lifecycle.ts";
import type { SqlDriver } from "./sql-driver.ts";

/** Neither superseded nor rejected counts as valid (a candidate does). */
export const INVALID: ReadonlySet<KnowledgeStatus> = new Set(["superseded", "rejected"]);

const currentEvidence = (db: SqlDriver, target: EvidenceTarget): number[] =>
  listEvidence(db, target)
    .filter((e) => e.current)
    .map((e) => e.id);

/**
 * A valid fact or relation. `evidenceIds` are the current evidence it cites; `input` is set when it
 * stands as a user input instead (nothing of its evidence is cited, the user's row is tied to the
 * Insight by `insight_user_inputs`). A row the user wrote is an input whatever evidence an extraction
 * attached; a row the user approved with no current evidence is one only while it has none.
 */
export interface ValidRow {
  evidenceIds: number[];
  input: UserInputRef | null;
}

export function validRow(db: SqlDriver, ref: UserInputRef): ValidRow | undefined {
  const evidenceIds = currentEvidence(
    db,
    ref.kind === "fact" ? { factId: ref.id } : { relationId: ref.id },
  );
  const kind = userInputKind(db, ref);
  const input = kind === "authored" || (kind === "approved" && evidenceIds.length === 0);
  if (input) return { evidenceIds: [], input: ref };
  return evidenceIds.length > 0 ? { evidenceIds, input: null } : undefined;
}

/** Whether a fact or relation of this status is "valid": not superseded or rejected, and current evidence or a user input. */
export const isValidRow = (db: SqlDriver, ref: UserInputRef, status: KnowledgeStatus): boolean =>
  !INVALID.has(status) && validRow(db, ref) !== undefined;
