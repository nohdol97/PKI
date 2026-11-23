// The product's entry to the Insight rules (P01-R6): the rules registered for every execution site (extraction,
// propagation, user action, a changed membership) and the one function that runs them. Acyclic layout:
// insight-rules.ts imports no rule, each rule file imports only the runner, this file imports them all.
//
// The three single-item rules below judge one merge group (S02-R13): the key is (representative, representative)
// and rows are read over every member (P01-R8). Dates and links are compared by this code; no LLM is called.
import { WORK_STATUSES } from "@pki/contracts";
import {
  entityGroups,
  INVALID,
  linksOfFacts,
  OPPORTUNITY_RULE,
  readInsight,
  listFactsOfKind,
  listRelationPairs,
  listRelationsBetween,
  readItem,
  readRelation,
  supersededAmong,
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
/** The fact kind of a decision's or rule's current content, the kind of a work item's status (P01-D21, D22). */
export const CONCLUSION_KIND = "conclusion";
export const STATUS_KIND = "status";
/** The `status` values that mean the work is not done (P01-D21); a rule-file constant next to the value type's list. */
export const OPEN_STATUSES: readonly string[] = ["open", "in_progress"];
/** The relation types a "new relation" is looked for among (P01-D24); a rule-file constant. */
export const NEW_RELATION_TYPES: readonly string[] = [
  "DEPENDS_ON",
  "RESPONSIBLE_FOR",
  "BELONGS_TO",
  "DECIDED",
  "CAUSED_BY",
];
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

/** The same, for a type that exists only for items of one type (the group's representative decides). */
const ownCandidatesOfType = (itemType: string) => (db: SqlDriver, items: readonly number[]) =>
  ownCandidates(db, items).filter((c) => readItem(db, c.xItemId)?.type === itemType);

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
  /** the day the fact starts to hold (`valid_at`), when it has one */
  validAt: string | null;
}
const factsOf = (db: SqlDriver, items: readonly number[]): Map<number, Fact> =>
  new Map(
    db
      .all(
        `SELECT id, kind, value, status, valid_at FROM facts
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
          validAt: r.valid_at as string | null,
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

/**
 * A replaced fact of one of `kinds` on an item of `itemType` (any when null): a SUPERSEDES link whose newer side
 * stands. The three change types differ only in what they look at and how they word it (P01-R12).
 */
function changeRule(spec: {
  type: string;
  kinds: readonly string[];
  itemType: string | null;
  summary: (x: string | undefined, count: number) => string;
  reasoningSummary: string;
  /** the day the newest change is about, or null */
  urgency: (newer: readonly Fact[]) => string | null;
}): InsightRule {
  return {
    type: spec.type,
    candidates: spec.itemType === null ? ownCandidates : ownCandidatesOfType(spec.itemType),
    evaluate(db, key): Desired {
      const members = ownMembers(db, key);
      if (members.length === 0) return { state: "resolved" };
      if (spec.itemType !== null && readItem(db, key.xItemId)?.type !== spec.itemType) {
        return { state: "resolved" };
      }
      const facts = factsOf(db, members);
      const rows: (ValidRow & { ref: UserInputRef })[] = [];
      const lines: string[] = [];
      const linkIds: number[] = [];
      const newer: Fact[] = [];
      const x = readItem(db, key.xItemId)?.name;
      for (const link of linksOfFacts(db, [...facts.keys()])) {
        const to = facts.get(link.fromFactId);
        const older = facts.get(link.toFactId);
        if (
          link.type !== "SUPERSEDES" ||
          !to ||
          !older ||
          !spec.kinds.includes(to.kind) ||
          !supersedingStands(db, link)
        ) {
          continue;
        }
        const stands = validFact(db, to);
        if (!stands) continue;
        const before = validFact(db, older);
        rows.push(stands, ...(before ? [before] : []));
        linkIds.push(link.id);
        lines.push(`${x}의 ${to.kind}: ${cut(older.value)} → ${cut(to.value)}`);
        newer.push(to);
      }
      if (lines.length === 0) return { state: "resolved" };
      return {
        state: "active",
        summary: spec.summary(x, lines.length),
        factLines: lines,
        reasoningSummary: spec.reasoningSummary,
        ...gather(rows, linkIds),
        urgencyDate: spec.urgency(newer),
      };
    },
  };
}

/** 중요 변경 (P01-D4): a date-kind fact replaced by another through a SUPERSEDES link whose newer side stands. */
export const importantChangeRule = changeRule({
  type: "important_change",
  kinds: CHANGE_KINDS,
  itemType: null,
  summary: (x, count) => `${x}의 일정 값이 ${count}건 바뀌었습니다(추론).`,
  reasoningSummary:
    "같은 항목의 날짜 값을 새 값이 대신한다고 코드가 기록한 대체 연결을 모았습니다.",
  urgency: (newer) =>
    newer
      .map((f) => f.value)
      .filter(isDate)
      .sort()
      .at(-1) ?? null,
});

/** The day the newest superseding fact starts to hold; the change types without a date value read it (P01-R12). */
const startOfNewest = (newer: readonly Fact[]): string | null =>
  newer
    .map((f) => f.validAt)
    .filter((d): d is string => d !== null && isDate(d))
    .sort()
    .at(-1) ?? null;

/** 의사결정 변경 (P01-D22): a Decision's `conclusion` replaced through a SUPERSEDES link whose newer side stands. */
export const decisionChangeRule = changeRule({
  type: "decision_change",
  kinds: [CONCLUSION_KIND],
  itemType: "Decision",
  summary: (x, count) => `${x}의 결정 내용이 ${count}건 바뀌었습니다(추론).`,
  reasoningSummary:
    "같은 결정의 현재 내용을 새 내용이 대신한다고 코드가 기록한 대체 연결을 모았습니다.",
  urgency: startOfNewest,
});

/** 정책 변화 (P01-D22): a BusinessRule's `conclusion` replaced through a SUPERSEDES link whose newer side stands. */
export const policyChangeRule = changeRule({
  type: "policy_change",
  kinds: [CONCLUSION_KIND],
  itemType: "BusinessRule",
  summary: (x, count) => `${x}의 규칙 내용이 ${count}건 바뀌었습니다(추론).`,
  reasoningSummary:
    "같은 업무 규칙의 현재 내용을 새 내용이 대신한다고 코드가 기록한 대체 연결을 모았습니다.",
  urgency: startOfNewest,
});

/** The valid `status` rows of a group, a value another case writes read as its value, without a replaced one. */
function validStatuses(db: SqlDriver, members: readonly number[]) {
  const candidates = members.flatMap((itemId) =>
    listFactsOfKind(db, itemId, STATUS_KIND).flatMap((f) => {
      const value = f.value.trim().toLowerCase();
      if (INVALID.has(f.status) || !(WORK_STATUSES as readonly string[]).includes(value)) return [];
      const row = validRow(db, { kind: "fact", id: f.id });
      return row ? [{ id: f.id, value, ...row }] : [];
    }),
  );
  const superseded = supersededAmong(
    db,
    candidates.map((c) => c.id),
  );
  const out = new Set(superseded.map((o) => o.factId));
  return {
    rows: candidates
      .filter((c) => !out.has(c.id))
      .map(({ id, value, evidenceIds, input }) => ({
        value,
        evidenceIds,
        input,
        ref: { kind: "fact", id } as UserInputRef,
      })),
    linkIds: superseded.map((o) => o.linkId),
  };
}

/**
 * 미처리 요청·미해결 이슈 (P01-D21): a group of `itemType` with at least one valid `status` and every one an
 * open value (`OPEN_STATUSES`). A closed value, or a closed and an open one at once, makes it stand down (the
 * latter is the conflict type's). A request's earliest valid target date is the urgency; it is cited as a row.
 */
function openWorkRule(spec: {
  type: string;
  itemType: string;
  withTargetDate: boolean;
  summary: (x: string | undefined) => string;
  reasoningSummary: string;
}): InsightRule {
  return {
    type: spec.type,
    candidates: ownCandidatesOfType(spec.itemType),
    evaluate(db, key): Desired {
      const members = ownMembers(db, key);
      if (members.length === 0 || readItem(db, key.xItemId)?.type !== spec.itemType) {
        return { state: "resolved" };
      }
      const statuses = validStatuses(db, members);
      if (
        statuses.rows.length === 0 ||
        !statuses.rows.every((r) => OPEN_STATUSES.includes(r.value))
      ) {
        return { state: "resolved" };
      }
      const x = readItem(db, key.xItemId)?.name;
      const rows: (ValidRow & { ref: UserInputRef })[] = [...statuses.rows];
      const lines = statuses.rows.map((r) => `${x}의 상태: ${r.value}`);
      const linkIds = [...statuses.linkIds];
      let urgencyDate: string | null = null;
      if (spec.withTargetDate) {
        const targets = validDates(db, members, TARGET_DATE);
        const earliest = targets.rows.reduce<DatedRow | undefined>(
          (min, f) => (min && min.value <= f.value ? min : f),
          undefined,
        );
        if (earliest) {
          rows.push(earliest);
          lines.push(`${x}의 목표일: ${earliest.value}`);
          linkIds.push(...targets.linkIds);
          urgencyDate = earliest.value;
        }
      }
      return {
        state: "active",
        summary: spec.summary(x),
        factLines: lines,
        reasoningSummary: spec.reasoningSummary,
        ...gather(rows, linkIds),
        urgencyDate,
      };
    },
  };
}

export const pendingRequestRule = openWorkRule({
  type: "pending_request",
  itemType: "Request",
  withTargetDate: true,
  summary: (x) => `${x} 요청이 아직 처리되지 않았습니다(추론).`,
  reasoningSummary:
    "요청의 유효한 상태 값이 모두 열린 값임을 코드가 확인했습니다. 닫힌 값이 하나라도 있으면 성립하지 않습니다.",
});

export const openIssueRule = openWorkRule({
  type: "open_issue",
  itemType: "Issue",
  withTargetDate: false,
  summary: (x) => `${x} 이슈가 아직 해결되지 않았습니다(추론).`,
  reasoningSummary:
    "이슈의 유효한 상태 값이 모두 열린 값임을 코드가 확인했습니다. 닫힌 값이 하나라도 있으면 성립하지 않습니다.",
});

/** The pairs a relation of the new-relation types names, as the groups' representatives (a pair of one group is none). */
function newRelationCandidates(db: SqlDriver, items: readonly number[]) {
  const pairs: { xItemId: number; yItemId: number }[] = [];
  for (const type of NEW_RELATION_TYPES) {
    for (const p of listRelationPairs(db, type, items)) {
      const x = entityGroups.representativeOf(db, p.xItemId);
      const y = entityGroups.representativeOf(db, p.yItemId);
      if (x !== y) pairs.push({ xItemId: x, yItemId: y });
    }
  }
  return pairs;
}

const instant = (value: string) => Date.parse(value);

/**
 * 새 관계 (P01-D24): a still-`candidate`, valid relation of a new-relation type between two groups whose
 * `observed_at` is later than that of both end items: the items were known before the relation was seen. The
 * rule never reads the clock; the ranking's novelty axis lowers an old one.
 */
export const newRelationRule: InsightRule = {
  type: "new_relation",
  candidates: newRelationCandidates,
  evaluate(db, { xItemId, yItemId }): Desired {
    const rx = entityGroups.representativeOf(db, xItemId);
    const ry = entityGroups.representativeOf(db, yItemId);
    if (rx !== xItemId || ry !== yItemId || rx === ry) return { state: "resolved" };
    const xs = entityGroups.membersOf(db, xItemId);
    const ys = entityGroups.membersOf(db, yItemId);
    const rows: (ValidRow & { ref: UserInputRef })[] = [];
    const lines: string[] = [];
    const x = readItem(db, xItemId)?.name;
    const y = readItem(db, yItemId)?.name;
    for (const type of NEW_RELATION_TYPES) {
      for (const { id } of listRelationsBetween(db, type, xs, ys)) {
        const relation = readRelation(db, id);
        const from = relation && readItem(db, relation.subjectId);
        const to = relation && readItem(db, relation.objectId);
        if (!relation || !from || !to || relation.status !== "candidate") continue;
        if (!(
          instant(relation.observedAt) > instant(from.observedAt) &&
          instant(relation.observedAt) > instant(to.observedAt)
        )) {
          continue;
        }
        const ref: UserInputRef = { kind: "relation", id };
        const row = validRow(db, ref);
        if (!row) continue;
        rows.push({ ...row, ref });
        lines.push(`${x} → ${y} 관계(${type})`);
      }
    }
    if (lines.length === 0) return { state: "resolved" };
    return {
      state: "active",
      summary: `${x}와(과) ${y} 사이에 새로 관측된, 아직 확인되지 않은 관계가 ${lines.length}건 있습니다(추론).`,
      factLines: lines,
      reasoningSummary:
        "이미 있던 두 항목 사이에 뒤늦게 관측되어 아직 확인되지 않은 관계임을, 코드가 관측 시각을 비교해 확인했습니다.",
      ...gather(rows, []),
      urgencyDate: null,
    };
  },
};

/** An `opportunity` is at most this confident (P01-D18), so it is always kept out of automatic notification. */
export const OPPORTUNITY_CONFIDENCE_CAP = 40;

/**
 * 기회 (P01-D18): the interpretation job proposes it and writes it with the parent's evidence and fact lines; this
 * rule only keeps it. It stands while an active Insight a rule judged on the same key still has the fact lines and
 * input ids the opportunity copied; otherwise it is resolved, and a resolved row stays so (its text is gone).
 * Last in the list: it reads the rows the other rules wrote in the same run.
 */
export const opportunityRule: InsightRule = {
  type: OPPORTUNITY_RULE,
  candidates: () => [],
  evaluate(db, key): Desired {
    const stored = readInsight(db, key);
    if (stored?.state !== "active" || stored.summary === null) return { state: "resolved" };
    const parent = db
      .all(
        `SELECT rule FROM insights WHERE x_item_id = ? AND y_item_id = ? AND state = 'active' AND rule <> ? ORDER BY id`,
        [key.xItemId, key.yItemId, OPPORTUNITY_RULE],
      )
      .map((r) => readInsight(db, { ...key, rule: r.rule as string }))
      .find(
        (p) =>
          p !== undefined &&
          sameValues(p.factLines, stored.factLines) &&
          sameValues(p.evidenceIds, stored.evidenceIds) &&
          sameValues(p.linkIds, stored.linkIds) &&
          sameValues(
            p.userInputs.map((u) => `${u.kind}:${u.id}`),
            stored.userInputs.map((u) => `${u.kind}:${u.id}`),
          ),
      );
    if (!parent) return { state: "resolved" };
    return {
      state: "active",
      summary: stored.summary,
      factLines: stored.factLines,
      reasoningSummary: stored.reasoningSummary ?? "",
      evidenceIds: stored.evidenceIds,
      userInputs: stored.userInputs,
      linkIds: stored.linkIds,
      usedRows: [],
      urgencyDate: stored.urgencyDate,
      confidenceCap: Math.min(OPPORTUNITY_CONFIDENCE_CAP, parent.confidence ?? 100),
    };
  },
};

const sameValues = (a: readonly (string | number)[], b: readonly (string | number)[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

export const INSIGHT_RULES: readonly InsightRule[] = [
  dependencyDelayRule,
  scheduleConflictRule,
  conflictRule,
  importantChangeRule,
  decisionChangeRule,
  policyChangeRule,
  pendingRequestRule,
  openIssueRule,
  newRelationRule,
  opportunityRule,
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
