// The product's entry to the Insight rules (P01-R6): the rules registered for every execution site (extraction,
// propagation, user action, a changed membership) and the one function that runs them. Acyclic layout:
// insight-rules.ts imports no rule, each rule file imports only the runner, this file imports them all.
import type { MembershipListener } from "@pki/storage";
import { dependencyDelayRule } from "./dependency-delay.ts";
import { runInsightRules, type InsightRule, type RuleScope } from "./insight-rules.ts";

export const INSIGHT_RULES: readonly InsightRule[] = [dependencyDelayRule];

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
