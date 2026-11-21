// Deterministic rule "의존 업무 지연" (V02-R9) and the upkeep of its Insight rows
// (V02-R10). X has a target date, X depends on Y, Y has an expected completion
// date strictly later than X's target, and all three rows are valid: then one
// inferred Insight per (rule, X, Y) carries the three rows' current evidence.
// The comparison is this code's; no LLM is called. Reads are the fixed depth-1
// queries of @pki/storage (V02-R8).
import {
  findRelation,
  listEvidence,
  listFactsOfKind,
  listInsightKeys,
  listRelationPairs,
  readInsight,
  readItem,
  saveInsight,
  type EvidenceTarget,
  type InsightKey,
  type KnowledgeStatus,
  type SqlDriver,
} from "@pki/storage";

/** The rule name, the golden labels' `insight_type` (fixtures/v02-expected.json). */
export const DEPENDENCY_DELAY = "dependency_delay";
/** Fact kinds and relation type the rule reads; extraction (T05) writes the same names. */
export const TARGET_DATE = "target_date";
export const COMPLETION_DATE = "completion_date";
export const DEPENDS_ON = "DEPENDS_ON";

export type RuleOutcome = "created" | "updated" | "revived" | "resolved" | "unchanged";

/** "유효": neither superseded nor rejected (candidate counts), and some current evidence. */
const INVALID: ReadonlySet<KnowledgeStatus> = new Set(["superseded", "rejected"]);

const currentEvidence = (db: SqlDriver, target: EvidenceTarget): number[] =>
  listEvidence(db, target)
    .filter((e) => e.current)
    .map((e) => e.id);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A normalized calendar date (YYYY-MM-DD) that exists; such strings order as dates. */
function isDate(value: string): boolean {
  const time = DATE.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
  return !Number.isNaN(time) && new Date(time).toISOString().startsWith(value);
}

interface DatedRow {
  value: string;
  evidenceIds: number[];
}

function validDates(db: SqlDriver, itemId: number, kind: string): DatedRow[] {
  return listFactsOfKind(db, itemId, kind)
    .filter((f) => !INVALID.has(f.status) && isDate(f.value))
    .map((f) => ({ value: f.value, evidenceIds: currentEvidence(db, { factId: f.id }) }))
    .filter((f) => f.evidenceIds.length > 0);
}

type Desired = { state: "active"; summary: string; evidenceIds: number[] } | { state: "resolved" };

/**
 * What the pair's row should hold. With several valid dates (different values are
 * different rows, V02-R8) the earliest target and the latest completion decide,
 * (one row per item, kind and value, so no ties); the condition holds iff some pair is late.
 */
function evaluate(db: SqlDriver, { xItemId, yItemId }: InsightKey): Desired {
  const relation = findRelation(db, xItemId, DEPENDS_ON, yItemId);
  const relationEvidence =
    relation && !INVALID.has(relation.status)
      ? currentEvidence(db, { relationId: relation.id })
      : [];
  const target = validDates(db, xItemId, TARGET_DATE).reduce<DatedRow | undefined>(
    (min, f) => (min && min.value <= f.value ? min : f),
    undefined,
  );
  const completion = validDates(db, yItemId, COMPLETION_DATE).reduce<DatedRow | undefined>(
    (max, f) => (max && max.value >= f.value ? max : f),
    undefined,
  );
  if (relationEvidence.length === 0 || !target || !completion) return { state: "resolved" };
  if (!(completion.value > target.value)) return { state: "resolved" };
  const x = readItem(db, xItemId)?.name;
  const y = readItem(db, yItemId)?.name;
  return {
    state: "active",
    summary:
      `${y}의 예상 완료일(${completion.value})이 ${x}의 목표일(${target.value})보다 늦어, ` +
      `${x}의 목표 일정이 의존 업무의 지연으로 위험할 수 있습니다(추론).`,
    evidenceIds: [
      ...new Set([...target.evidenceIds, ...relationEvidence, ...completion.evidenceIds]),
    ].sort((a, b) => a - b),
  };
}

const sameIds = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * Re-evaluates every (X, Y) pair that one of `itemIds` takes part in, through a
 * DEPENDS_ON relation or an existing Insight row, in one transaction. Writes only
 * what differs: no row is created for a pair that does not hold, an unchanged
 * row is not written, a broken one is resolved (summary and evidence emptied,
 * row kept) and a resolved one revived in place. Reports each pair it judged
 * except a pair that neither holds nor has a row. X = Y pairs are skipped.
 */
export function recomputeDependencyDelay(
  db: SqlDriver,
  itemIds: readonly number[],
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
      const desired = evaluate(db, key);
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
          sameIds(stored.evidenceIds, desired.evidenceIds);
        outcome = same ? "unchanged" : "updated";
      }
      if (outcome !== "unchanged") saveInsight(db, key, desired);
      results.push({ key, outcome });
    }
    return results;
  });
}
