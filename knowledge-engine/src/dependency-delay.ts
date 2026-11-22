// Deterministic rule "의존 업무 지연" (V02-R9) and the upkeep of its Insight rows
// (V02-R10). X has a target date, X depends on Y, Y has an expected completion
// date strictly later than X's target, and all three rows are valid: then one
// inferred Insight per (rule, X, Y) carries the three rows' current evidence.
// The comparison is this code's; no LLM is called. Reads are the fixed depth-1
// queries of @pki/storage (V02-R8).
import {
  findRelation,
  isDate,
  listEvidence,
  listEvidenceVersions,
  listFactsOfKind,
  listInsightKeys,
  listRelationPairs,
  readInsight,
  readItem,
  rowLineage,
  saveInsight,
  unionOfVersions,
  userInputKind,
  type EvidenceTarget,
  type InsightKey,
  type KnowledgeStatus,
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

interface DatedRow extends ValidRow {
  value: string;
}

function validDates(db: SqlDriver, itemId: number, kind: string): DatedRow[] {
  return listFactsOfKind(db, itemId, kind)
    .filter((f) => !INVALID.has(f.status) && isDate(f.value))
    .flatMap((f) => {
      const row = validRow(db, { kind: "fact", id: f.id });
      return row ? [{ value: f.value, ...row }] : [];
    });
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
 * What the pair's row should hold. With several valid dates (different values are
 * different rows, V02-R8) the earliest target and the latest completion decide,
 * (one row per item, kind and value, so no ties); the condition holds iff some pair is late.
 */
function evaluate(db: SqlDriver, { xItemId, yItemId }: InsightKey, scope?: RuleScope): Desired {
  const relation = findRelation(db, xItemId, DEPENDS_ON, yItemId);
  const dependency =
    relation && !INVALID.has(relation.status)
      ? validRow(db, { kind: "relation", id: relation.id })
      : undefined;
  const target = validDates(db, xItemId, TARGET_DATE).reduce<DatedRow | undefined>(
    (min, f) => (min && min.value <= f.value ? min : f),
    undefined,
  );
  const completion = validDates(db, yItemId, COMPLETION_DATE).reduce<DatedRow | undefined>(
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
 * Re-evaluates every (X, Y) pair that one of `itemIds` takes part in, through a
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
    const pairs = new Map<string, InsightKey>();
    for (const p of [
      ...listRelationPairs(db, DEPENDS_ON, itemIds),
      ...listInsightKeys(db, DEPENDENCY_DELAY, itemIds),
    ]) {
      // A self-dependency is no other work being late (잠정): skipped, never stored.
      if (p.xItemId === p.yItemId) continue;
      pairs.set(`${p.xItemId}:${p.yItemId}`, {
        rule: DEPENDENCY_DELAY,
        xItemId: p.xItemId,
        yItemId: p.yItemId,
      });
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
