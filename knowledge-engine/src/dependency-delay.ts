// Deterministic rule "의존 업무 지연" (V02-R9), run by the shared Insight runner (P01-R6; the upkeep of its
// rows, V02-R10, is the runner's now). An item here is its merge group (S02-R13): the key is the
// representative, the dates and the dependency are read over every member. X has a target date, X depends on
// Y, Y has an expected completion date strictly later than X's target, and all three rows are valid: then one
// inferred Insight per (rule, X, Y) carries the three rows' current evidence.
// The comparison is this code's; no LLM is called. Reads are the fixed depth-1
// queries of @pki/storage (V02-R8).
import {
  entityGroups,
  INVALID,
  isDate,
  isValidRow,
  listFactsOfKind,
  listRelationPairs,
  listRelationsBetween,
  readItem,
  supersededAmong,
  validRow,
  type InsightKey,
  type SqlDriver,
  type UserInputRef,
  type ValidRow,
} from "@pki/storage";
import {
  runInsightRules,
  type Desired,
  type InsightRule,
  type RuleOutcome,
  type RuleScope,
} from "./insight-rules.ts";

/** The rule name, the golden labels' `insight_type` (fixtures/v02-expected.json). */
export const DEPENDENCY_DELAY = "dependency_delay";
/** Fact kinds and relation type the rule reads; extraction (T05) writes the same names. */
export const TARGET_DATE = "target_date";
export const COMPLETION_DATE = "completion_date";
export const DEPENDS_ON = "DEPENDS_ON";

/** The runner's types are re-exported: callers know them from this file. */
export type { RuleOutcome, RuleScope };

/** The one calendar-date check is storage's (ontology.ts); the rule's own reading of a date is the same. */
export { isDate };

/** The valid-row predicate is storage's (valid-row.ts); the promotion's condition 5 and other callers import it from here too. */
export { isValidRow };

export interface DatedRow extends ValidRow {
  value: string;
  /** the fact itself, for the confidence of the Insight that used it */
  ref: UserInputRef;
}

/**
 * The valid dates of a kind over these items, without a fact a SUPERSEDES link replaced (S02-R19, decision 10).
 * `linkIds` are the links that took a valid date out: the Insight rests on them (`insight_link_inputs`).
 */
export function validDates(
  db: SqlDriver,
  itemIds: readonly number[],
  kind: string,
): { rows: DatedRow[]; linkIds: number[] } {
  const candidates = itemIds.flatMap((itemId) =>
    listFactsOfKind(db, itemId, kind).flatMap((f) => {
      if (INVALID.has(f.status) || !isDate(f.value)) return [];
      const row = validRow(db, { kind: "fact", id: f.id });
      return row ? [{ id: f.id, value: f.value, ...row }] : [];
    }),
  );
  const superseded = supersededAmong(
    db,
    candidates.map((c) => c.id),
  );
  const out = new Set(superseded.map((s) => s.factId));
  return {
    rows: candidates
      .filter((c) => !out.has(c.id))
      .map(({ id, value, evidenceIds, input }) => ({
        value,
        evidenceIds,
        input,
        ref: { kind: "fact", id },
      })),
    linkIds: superseded.map((s) => s.linkId),
  };
}

/**
 * What the pair's row should hold. The pair is two groups (S02-R13): X and Y are their representatives,
 * and a key whose end is a member of a group, or whose two ends are one group, holds nothing. Dates and
 * the dependency are read over every member of the group. With several valid dates (different values are
 * different rows, V02-R8) the earliest target and the latest completion decide, (one row per item, kind
 * and value, so no ties); the condition holds iff some pair is late. Of several valid relations from X's
 * group to Y's, the one with the lowest id is the one cited.
 */
function evaluate(db: SqlDriver, { xItemId, yItemId }: InsightKey): Desired {
  const rx = entityGroups.representativeOf(db, xItemId);
  const ry = entityGroups.representativeOf(db, yItemId);
  if (rx !== xItemId || ry !== yItemId || rx === ry) return { state: "resolved" };
  const xs = entityGroups.membersOf(db, xItemId);
  const ys = entityGroups.membersOf(db, yItemId);
  let dependency: (ValidRow & { ref: UserInputRef }) | undefined;
  for (const r of listRelationsBetween(db, DEPENDS_ON, xs, ys)) {
    if (INVALID.has(r.status)) continue;
    const ref: UserInputRef = { kind: "relation", id: r.id };
    const row = validRow(db, ref);
    if (row) {
      dependency = { ...row, ref };
      break;
    }
  }
  const targets = validDates(db, xs, TARGET_DATE);
  const completions = validDates(db, ys, COMPLETION_DATE);
  const target = targets.rows.reduce<DatedRow | undefined>(
    (min, f) => (min && min.value <= f.value ? min : f),
    undefined,
  );
  const completion = completions.rows.reduce<DatedRow | undefined>(
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
  // the links that took a date out are part of why the Insight stands, so their lineage joins the runner's
  // scope judgement (S02-R19)
  const linkIds = [...new Set([...targets.linkIds, ...completions.linkIds])].sort((p, q) => p - q);
  return {
    state: "active",
    summary:
      `${y}의 예상 완료일(${completion.value})이 ${x}의 목표일(${target.value})보다 늦어, ` +
      `${x}의 목표 일정이 의존 업무의 지연으로 위험할 수 있습니다(추론).`,
    factLines: [
      `${x}의 목표일: ${target.value}`,
      `${x} → ${y} 의존(${DEPENDS_ON})`,
      `${y}의 예상 완료일: ${completion.value}`,
    ],
    reasoningSummary:
      "의존 관계가 있는 두 항목의 날짜를 코드가 비교해, 의존 업무의 예상 완료일이 목표일보다 늦음을 확인했습니다.",
    evidenceIds,
    userInputs,
    linkIds,
    usedRows: used.map((row) => row.ref),
    urgencyDate: target.value,
  };
}

/** The pairs a DEPENDS_ON relation of the items (or their groups) names, as the groups' representatives. */
function candidates(db: SqlDriver, items: readonly number[]) {
  const pairs: { xItemId: number; yItemId: number }[] = [];
  for (const p of listRelationPairs(db, DEPENDS_ON, items)) {
    // The key is the groups' representatives (S02-R13). A self-dependency, or two ends of one group, is
    // no other work being late (잠정): skipped, never stored.
    const x = entityGroups.representativeOf(db, p.xItemId);
    const y = entityGroups.representativeOf(db, p.yItemId);
    if (x !== y) pairs.push({ xItemId: x, yItemId: y });
  }
  return pairs;
}

export const dependencyDelayRule: InsightRule = { type: DEPENDENCY_DELAY, candidates, evaluate };

/**
 * The entry that runs this rule alone: callers and tests of V02·S02 prove its behaviour through this name.
 * The product runs every rule through `recomputeInsights` (insight-code-rules.ts).
 */
export function recomputeDependencyDelay(
  db: SqlDriver,
  itemIds: readonly number[],
  scope?: RuleScope,
): { key: InsightKey; outcome: RuleOutcome }[] {
  return runInsightRules(db, itemIds, [dependencyDelayRule], scope ? { scope } : {});
}
