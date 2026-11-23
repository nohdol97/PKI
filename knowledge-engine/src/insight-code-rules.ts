// The product's entry to the Insight rules (P01-R6): the rules registered for every execution site (extraction,
// propagation, user action, a changed membership) and the one function that runs them. Acyclic layout:
// insight-rules.ts imports no rule, each rule file imports only the runner, this file imports them all.
//
// The three single-item rules below judge one merge group (S02-R13): the key is (representative, representative)
// and rows are read over every member (P01-R8). Dates and links are compared by this code; no LLM is called.
import {
  entityGroups,
  INVALID,
  linksOfFacts,
  readItem,
  supersedingStands,
  validRow,
  type InsightKey,
  type KnowledgeStatus,
  type MembershipListener,
  type SqlDriver,
  type UserInputRef,
  type ValidRow,
} from "@pki/storage";
import {
  COMPLETION_DATE,
  dependencyDelayRule,
  isDate,
  TARGET_DATE,
  validDates,
  type DatedRow,
} from "./dependency-delay.ts";
import {
  runInsightRules,
  type Desired,
  type InsightRule,
  type RuleScope,
} from "./insight-rules.ts";

/** The fact kinds whose replacement is an "important change" (P01-D4); a rule-file constant. */
export const CHANGE_KINDS: readonly string[] = [TARGET_DATE, COMPLETION_DATE];
/** A value in a fact line is cut at this many code points. */
const LINE_VALUE_LIMIT = 80;
const cut = (value: string) => {
  const points = [...value];
  return points.length <= LINE_VALUE_LIMIT
    ? value
    : `${points.slice(0, LINE_VALUE_LIMIT).join("")}…`;
};

/** The keys of a single-item type: each item's group representative, twice. */
const ownCandidates = (db: SqlDriver, items: readonly number[]) =>
  [...new Set(items.map((id) => entityGroups.representativeOf(db, id)))].map((id) => ({
    xItemId: id,
    yItemId: id,
  }));

/** The members of the key's group, or none when the key is not one group's own (a merge made it stale). */
function ownMembers(db: SqlDriver, key: InsightKey): readonly number[] {
  const { xItemId } = key;
  return key.yItemId === xItemId && entityGroups.representativeOf(db, xItemId) === xItemId
    ? entityGroups.membersOf(db, xItemId)
    : [];
}

interface Fact {
  id: number;
  kind: string;
  value: string;
  status: KnowledgeStatus;
}
const factsOf = (db: SqlDriver, items: readonly number[]): Map<number, Fact> =>
  new Map(
    db
      .all(
        `SELECT id, kind, value, status FROM facts
         WHERE item_id IN (SELECT value FROM json_each(?)) ORDER BY id`,
        [JSON.stringify(items)],
      )
      .map((r) => [
        r.id as number,
        {
          id: r.id as number,
          kind: r.kind as string,
          value: r.value as string,
          status: r.status as KnowledgeStatus,
        },
      ]),
  );
/** A fact that is valid (S01-R15): not superseded or rejected, with current evidence or standing as a user input. */
const validFact = (db: SqlDriver, f: Fact): (ValidRow & { ref: UserInputRef }) | undefined => {
  if (INVALID.has(f.status)) return undefined;
  const ref: UserInputRef = { kind: "fact", id: f.id };
  const row = validRow(db, ref);
  return row ? { ...row, ref } : undefined;
};

/** The parts of an active Insight that come from the rows it used, once each, in the stored order. */
function gather(rows: readonly (ValidRow & { ref: UserInputRef })[], linkIds: readonly number[]) {
  const seen = new Set<string>();
  const used = rows.filter((r) => {
    const k = `${r.ref.kind}:${r.ref.id}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
  return {
    evidenceIds: [...new Set(used.flatMap((r) => r.evidenceIds))].sort((a, b) => a - b),
    userInputs: used.flatMap((r) => (r.input ? [r.input] : [])),
    usedRows: used.map((r) => r.ref),
    linkIds: [...new Set(linkIds)].sort((a, b) => a - b),
  };
}

/** 일정 충돌 (P01-D3): a group's latest valid completion date is later than its earliest valid target date. */
export const scheduleConflictRule: InsightRule = {
  type: "schedule_conflict",
  candidates: ownCandidates,
  evaluate(db, key): Desired {
    const members = ownMembers(db, key);
    if (members.length === 0) return { state: "resolved" };
    const targets = validDates(db, members, TARGET_DATE);
    const completions = validDates(db, members, COMPLETION_DATE);
    const target = targets.rows.reduce<DatedRow | undefined>(
      (min, f) => (min && min.value <= f.value ? min : f),
      undefined,
    );
    const completion = completions.rows.reduce<DatedRow | undefined>(
      (max, f) => (max && max.value >= f.value ? max : f),
      undefined,
    );
    if (!target || !completion || !(completion.value > target.value)) return { state: "resolved" };
    const x = readItem(db, key.xItemId)?.name;
    return {
      state: "active",
      summary:
        `${x}의 완료일(${completion.value})이 목표일(${target.value})보다 늦어, ` +
        "일정이 서로 맞지 않습니다(추론).",
      factLines: [`${x}의 목표일: ${target.value}`, `${x}의 완료일: ${completion.value}`],
      reasoningSummary:
        "한 항목의 목표일과 완료일을 코드가 날짜로 비교해, 완료일이 목표일보다 늦음을 확인했습니다.",
      ...gather([target, completion], [...targets.linkIds, ...completions.linkIds]),
      urgencyDate: target.value,
    };
  },
};

/** 충돌: a CONTRADICTS link between two valid facts of one group; each link is one fact line. */
export const conflictRule: InsightRule = {
  type: "conflict",
  candidates: ownCandidates,
  evaluate(db, key): Desired {
    const members = ownMembers(db, key);
    if (members.length === 0) return { state: "resolved" };
    const facts = factsOf(db, members);
    const rows: (ValidRow & { ref: UserInputRef })[] = [];
    const lines: string[] = [];
    const linkIds: number[] = [];
    const x = readItem(db, key.xItemId)?.name;
    for (const link of linksOfFacts(db, [...facts.keys()])) {
      const from = facts.get(link.fromFactId);
      const to = facts.get(link.toFactId);
      if (link.type !== "CONTRADICTS" || !from || !to) continue;
      const a = validFact(db, from);
      const b = validFact(db, to);
      if (!a || !b) continue;
      rows.push(a, b);
      linkIds.push(link.id);
      lines.push(`${x}의 ${from.kind}: "${cut(from.value)}" ↔ "${cut(to.value)}"`);
    }
    if (lines.length === 0) return { state: "resolved" };
    return {
      state: "active",
      summary: `${x}에 서로 어긋나는 값이 ${lines.length}건 있어 확인이 필요합니다(추론).`,
      factLines: lines,
      reasoningSummary:
        "같은 항목의 같은 자리에 서로 다른 유효한 값이 있다고 코드가 기록한 어긋남 연결을 모았습니다.",
      ...gather(rows, linkIds),
      urgencyDate: null,
    };
  },
};

/** 중요 변경 (P01-D4): a date-kind fact replaced by another through a SUPERSEDES link whose newer side stands. */
export const importantChangeRule: InsightRule = {
  type: "important_change",
  candidates: ownCandidates,
  evaluate(db, key): Desired {
    const members = ownMembers(db, key);
    if (members.length === 0) return { state: "resolved" };
    const facts = factsOf(db, members);
    const rows: (ValidRow & { ref: UserInputRef })[] = [];
    const lines: string[] = [];
    const linkIds: number[] = [];
    const dates: string[] = [];
    const x = readItem(db, key.xItemId)?.name;
    for (const link of linksOfFacts(db, [...facts.keys()])) {
      const newer = facts.get(link.fromFactId);
      const older = facts.get(link.toFactId);
      if (
        link.type !== "SUPERSEDES" ||
        !newer ||
        !older ||
        !CHANGE_KINDS.includes(newer.kind) ||
        !supersedingStands(db, link)
      ) {
        continue;
      }
      const stands = validFact(db, newer);
      if (!stands) continue;
      const before = validFact(db, older);
      rows.push(stands, ...(before ? [before] : []));
      linkIds.push(link.id);
      lines.push(`${x}의 ${newer.kind}: ${cut(older.value)} → ${cut(newer.value)}`);
      if (isDate(newer.value)) dates.push(newer.value);
    }
    if (lines.length === 0) return { state: "resolved" };
    return {
      state: "active",
      summary: `${x}의 일정 값이 ${lines.length}건 바뀌었습니다(추론).`,
      factLines: lines,
      reasoningSummary:
        "같은 항목의 날짜 값을 새 값이 대신한다고 코드가 기록한 대체 연결을 모았습니다.",
      ...gather(rows, linkIds),
      urgencyDate: dates.sort().at(-1) ?? null,
    };
  },
};

export const INSIGHT_RULES: readonly InsightRule[] = [
  dependencyDelayRule,
  scheduleConflictRule,
  conflictRule,
  importantChangeRule,
];

/** Judges every registered rule again over the items and their merge groups (see `runInsightRules`). */
export const recomputeInsights = (
  db: Parameters<typeof runInsightRules>[0],
  itemIds: readonly number[],
  options: { scope?: RuleScope; at?: string } = {},
) => runInsightRules(db, itemIds, INSIGHT_RULES, options);

/**
 * The rules' receiver of a changed membership (S02-R13): it recomputes the groups the action reached, over
 * the scope the action handed it. A split's moved rows need no separate reach: every key they touch has
 * the original or the new item as one end, and both are in `change.items`. It only recomputes.
 */
export const insightsReceiver: MembershipListener = (tx, change, scope) => {
  const outcomes = recomputeInsights(tx, change.items, { scope });
  scope.recomputed?.("insight", outcomes.filter((o) => o.outcome !== "unchanged").length);
};
