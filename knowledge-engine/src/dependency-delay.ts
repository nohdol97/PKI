// Deterministic rule "의존 업무 지연" (V02-R9) and the upkeep of its Insight rows
// (V02-R10). An item here is its merge group (S02-R13): the key is the representative, the dates and
// the dependency are read over every member. X has a target date, X depends on Y, Y has an expected completion
// date strictly later than X's target, and all three rows are valid: then one
// inferred Insight per (rule, X, Y) carries the three rows' current evidence.
// The comparison is this code's; no LLM is called. Reads are the fixed depth-1
// queries of @pki/storage (V02-R8).
import {
  entityGroups,
  isDate,
  listEvidence,
  listEvidenceVersions,
  listFactsOfKind,
  listInsightKeys,
  listRelationPairs,
  listRelationsBetween,
  readInsight,
  readItem,
  rowLineage,
  saveInsight,
  unionOfVersions,
  userInputKind,
  withGroups,
  type EvidenceTarget,
  type InsightKey,
  type KnowledgeStatus,
  type MembershipListener,
  type SourceVersionRef,
  type SqlDriver,
  type UserInputRef,
} from "@pki/storage";

/** The rule name, the golden labels' `insight_type` (fixtures/v02-expected.json). */
export const DEPENDENCY_DELAY = "dependency_delay";
/** Fact kinds and relation type the rule reads; extraction (T05) writes the same names. */
export const TARGET_DATE = "target_date";
export const COMPLETION_DATE = "completion_date";
export const DEPENDS_ON = "DEPENDS_ON";

export type RuleOutcome = "created" | "updated" | "revived" | "resolved" | "unchanged";

/**
 * "유효" (S01-R15): neither superseded nor rejected (candidate counts), and some current evidence,
 * or a user input: a row the user wrote, or one the user approved with no current evidence.
 */
const INVALID: ReadonlySet<KnowledgeStatus> = new Set(["superseded", "rejected"]);

const currentEvidence = (db: SqlDriver, target: EvidenceTarget): number[] =>
  listEvidence(db, target)
    .filter((e) => e.current)
    .map((e) => e.id);

/** The one calendar-date check is storage's (ontology.ts); the rule's own reading of a date is the same. */
export { isDate };

/**
 * A valid fact or relation the rule reads. `evidenceIds` are the current evidence it cites; `input` is
 * set when it stands as a user input instead (nothing of its evidence is cited, the user's row is tied
 * to the Insight by `insight_user_inputs`). A row the user wrote is an input whatever evidence an
 * extraction attached; a row the user approved with no current evidence is one only while it has none.
 */
interface ValidRow {
  evidenceIds: number[];
  input: UserInputRef | null;
}

function validRow(db: SqlDriver, ref: UserInputRef): ValidRow | undefined {
  const evidenceIds = currentEvidence(
    db,
    ref.kind === "fact" ? { factId: ref.id } : { relationId: ref.id },
  );
  const kind = userInputKind(db, ref);
  const input = kind === "authored" || (kind === "approved" && evidenceIds.length === 0);
  if (input) return { evidenceIds: [], input: ref };
  return evidenceIds.length > 0 ? { evidenceIds, input: null } : undefined;
}

/**
 * Whether a fact or relation of this status is "valid" (S01-R15) — the predicate the rule reads, which
 * the automatic promotion's condition 5 asks too (S01-T04 hand-off 10): not superseded or rejected,
 * and current evidence or a user input.
 */
export const isValidRow = (db: SqlDriver, ref: UserInputRef, status: KnowledgeStatus): boolean =>
  !INVALID.has(status) && validRow(db, ref) !== undefined;

interface DatedRow extends ValidRow {
  value: string;
}

function validDates(db: SqlDriver, itemIds: readonly number[], kind: string): DatedRow[] {
  return itemIds.flatMap((itemId) =>
    listFactsOfKind(db, itemId, kind)
      .filter((f) => !INVALID.has(f.status) && isDate(f.value))
      .flatMap((f) => {
        const row = validRow(db, { kind: "fact", id: f.id });
        return row ? [{ value: f.value, ...row }] : [];
      }),
  );
}

type Desired =
  | { state: "active"; summary: string; evidenceIds: number[]; userInputs: UserInputRef[] }
  | { state: "resolved" };

/**
 * What the rule asks of the scope policy (I04-R14): whether the source versions an
 * Insight's evidence quotes may be put together. Without it every Insight may stand.
 */
export interface RuleScope {
  combinable(lineage: readonly SourceVersionRef[]): boolean;
}

/**
 * What the pair's row should hold. The pair is two groups (S02-R13): X and Y are their representatives,
 * and a key whose end is a member of a group, or whose two ends are one group, holds nothing. Dates and
 * the dependency are read over every member of the group. With several valid dates (different values are
 * different rows, V02-R8) the earliest target and the latest completion decide, (one row per item, kind
 * and value, so no ties); the condition holds iff some pair is late. Of several valid relations from X's
 * group to Y's, the one with the lowest id is the one cited.
 */
function evaluate(db: SqlDriver, { xItemId, yItemId }: InsightKey, scope?: RuleScope): Desired {
  const rx = entityGroups.representativeOf(db, xItemId);
  const ry = entityGroups.representativeOf(db, yItemId);
  if (rx !== xItemId || ry !== yItemId || rx === ry) return { state: "resolved" };
  const xs = entityGroups.membersOf(db, xItemId);
  const ys = entityGroups.membersOf(db, yItemId);
  const dependency = listRelationsBetween(db, DEPENDS_ON, xs, ys)
    .filter((r) => !INVALID.has(r.status))
    .map((r) => validRow(db, { kind: "relation", id: r.id }))
    .find((row) => row !== undefined);
  const target = validDates(db, xs, TARGET_DATE).reduce<DatedRow | undefined>(
    (min, f) => (min && min.value <= f.value ? min : f),
    undefined,
  );
  const completion = validDates(db, ys, COMPLETION_DATE).reduce<DatedRow | undefined>(
    (max, f) => (max && max.value >= f.value ? max : f),
    undefined,
  );
  if (!dependency || !target || !completion) return { state: "resolved" };
  if (!(completion.value > target.value)) return { state: "resolved" };
  const x = readItem(db, xItemId)?.name;
  const y = readItem(db, yItemId)?.name;
  const used = [target, dependency, completion];
  const evidenceIds = [...new Set(used.flatMap((row) => row.evidenceIds))].sort((a, b) => a - b);
  const userInputs = used.flatMap((row) => (row.input ? [row.input] : []));
  // sources that may not be put together make no Insight; it is resolved in its row and
  // comes back there when the scopes allow it (I04-R14, R15). A user input brings the lineage of its
  // own (S01-R15, R22): the item's sources for a row the user wrote, its own evidence's for an approved one
  const lineage = unionOfVersions(
    listEvidenceVersions(db, evidenceIds),
    ...userInputs.map((input) => rowLineage(db, input)),
  );
  if (scope && !scope.combinable(lineage)) return { state: "resolved" };
  return {
    state: "active",
    summary:
      `${y}의 예상 완료일(${completion.value})이 ${x}의 목표일(${target.value})보다 늦어, ` +
      `${x}의 목표 일정이 의존 업무의 지연으로 위험할 수 있습니다(추론).`,
    evidenceIds,
    userInputs,
  };
}

const sameIds = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);
const sameInputs = (a: readonly UserInputRef[], b: readonly UserInputRef[]) =>
  a.length === b.length && a.every((r, i) => r.kind === b[i]?.kind && r.id === b[i]?.id);
/** facts before relations, by id: the order `readInsight` reads them in */
const inOrder = (inputs: readonly UserInputRef[]) =>
  [...inputs].sort((p, q) => (p.kind === q.kind ? p.id - q.id : p.kind === "fact" ? -1 : 1));

/**
 * Re-evaluates every (X, Y) pair that one of `itemIds` or a member of its group takes part in, through a
 * DEPENDS_ON relation or an existing Insight row, in one transaction. Writes only
 * what differs: no row is created for a pair that does not hold, an unchanged
 * row is not written, a broken one is resolved (summary and evidence emptied,
 * row kept) and a resolved one revived in place. Reports each pair it judged
 * except a pair that neither holds nor has a row. X = Y pairs are skipped. With
 * `scope`, a pair whose evidence comes from sources the policy will not let be put
 * together is resolved like a pair that does not hold.
 */
export function recomputeDependencyDelay(
  db: SqlDriver,
  itemIds: readonly number[],
  scope?: RuleScope,
): { key: InsightKey; outcome: RuleOutcome }[] {
  return db.transaction(() => {
    const all = withGroups(db, itemIds);
    const pairs = new Map<string, InsightKey>();
    const keep = (xItemId: number, yItemId: number) =>
      pairs.set(`${xItemId}:${yItemId}`, { rule: DEPENDENCY_DELAY, xItemId, yItemId });
    for (const p of listRelationPairs(db, DEPENDS_ON, all)) {
      // The key is the groups' representatives (S02-R13). A self-dependency, or two ends of one group, is
      // no other work being late (잠정): skipped, never stored.
      const x = entityGroups.representativeOf(db, p.xItemId);
      const y = entityGroups.representativeOf(db, p.yItemId);
      if (x !== y) keep(x, y);
    }
    // A stored key as it is stored: one a merge made stale is found here, to be resolved.
    for (const p of listInsightKeys(db, DEPENDENCY_DELAY, all)) {
      if (p.xItemId !== p.yItemId) keep(p.xItemId, p.yItemId);
    }
    const results: { key: InsightKey; outcome: RuleOutcome }[] = [];
    for (const key of pairs.values()) {
      const desired = evaluate(db, key, scope);
      const stored = readInsight(db, key);
      let outcome: RuleOutcome;
      if (desired.state === "resolved") {
        if (!stored) continue;
        outcome = stored.state === "resolved" ? "unchanged" : "resolved";
      } else if (!stored) {
        outcome = "created";
      } else if (stored.state === "resolved") {
        outcome = "revived";
      } else {
        const same =
          stored.state === "active" &&
          stored.summary === desired.summary &&
          sameIds(stored.evidenceIds, desired.evidenceIds) &&
          sameInputs(stored.userInputs, inOrder(desired.userInputs));
        outcome = same ? "unchanged" : "updated";
      }
      if (outcome !== "unchanged") saveInsight(db, key, desired);
      results.push({ key, outcome });
    }
    return results;
  });
}

/**
 * The rule's receiver of a changed membership (S02-R13): it recomputes the groups the action reached, over
 * the scope the action handed it. A split's moved rows need no separate reach: every pair they touch has
 * the original or the new item as one end, and both are in `change.items`. It only recomputes.
 */
export const dependencyDelayReceiver: MembershipListener = (tx, change, scope) => {
  recomputeDependencyDelay(tx, change.items, scope);
};
