// The rule runner every Insight type shares (P01-R6, R8, R9, R10). A rule says which keys are worth
// judging and what one key should hold; the runner widens the items to their merge groups, judges each key,
// puts the result under the scope policy, computes the confidence, and writes only what differs: created,
// updated, resolved (row kept, text and links emptied) and revived in place. No rule calls a Provider.
import { insightType } from "@pki/contracts";
import {
  listEvidenceVersions,
  listInsightKeys,
  readInsight,
  rowLineage,
  saveInsight,
  unionOfVersions,
  withGroups,
  type InsightKey,
  type SourceVersionRef,
  type SqlDriver,
  type UserInputRef,
} from "@pki/storage";

export type RuleOutcome = "created" | "updated" | "revived" | "resolved" | "unchanged";

/**
 * What a rule asks of the scope policy (I04-R14): whether the source versions an
 * Insight's evidence quotes may be put together. Without it every Insight may stand.
 */
export interface RuleScope {
  combinable(lineage: readonly SourceVersionRef[]): boolean;
}

/** What one key should hold: an active Insight with everything it rests on, or nothing. */
export type Desired =
  | {
      state: "active";
      /** the inference, shown as such (P01-R2) */
      summary: string;
      /** one line per row used, written by code from the rows' values */
      factLines: string[];
      /** which comparison led to the summary, templated by code; never a model's reasoning (P01-R5) */
      reasoningSummary: string;
      evidenceIds: number[];
      userInputs: UserInputRef[];
      linkIds: number[];
      /** every fact and relation the judgement read: the confidence is the lowest of them */
      usedRows: UserInputRef[];
      urgencyDate: string | null;
    }
  | { state: "resolved" };

export interface InsightRule {
  /** `insights.rule`: a name of the type table */
  type: string;
  /** Keys worth judging for these items (already widened to their groups); stored keys are added by the runner. */
  candidates(db: SqlDriver, items: readonly number[]): { xItemId: number; yItemId: number }[];
  /** What the key should hold now. Reads the database only. */
  evaluate(db: SqlDriver, key: InsightKey): Desired;
}

/** An Insight below this confidence is kept out of automatic notification (P01-R10, D5); P02 reads it. */
export const LOW_CONFIDENCE_BELOW = 50;
export const isAutoNotifyExcluded = (confidence: number | null): boolean =>
  confidence !== null && confidence < LOW_CONFIDENCE_BELOW;

/** A row's confidence: approved 100, disputed 30, a candidate its own number (50 when it has none). */
export function rowConfidence(db: SqlDriver, ref: UserInputRef): number {
  const row = db.all(
    `SELECT status, confidence FROM ${ref.kind === "fact" ? "facts" : "relations"} WHERE id = ?`,
    [ref.id],
  )[0];
  if (row?.status === "verified") return 100;
  if (row?.status === "disputed") return 30;
  return typeof row?.confidence === "number" ? Math.round(row.confidence * 100) : 50;
}

/** The lineage of each link: both facts' (S02-R18). */
const linkLineage = (db: SqlDriver, linkIds: readonly number[]): SourceVersionRef[][] =>
  linkIds.flatMap((id) =>
    db
      .all("SELECT from_fact_id, to_fact_id FROM assertion_links WHERE id = ?", [id])
      .map((r) =>
        unionOfVersions(
          rowLineage(db, { kind: "fact", id: r.from_fact_id as number }),
          rowLineage(db, { kind: "fact", id: r.to_fact_id as number }),
        ),
      ),
  );

const sameIds = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);
const sameLines = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((line, i) => line === b[i]);
const sameInputs = (a: readonly UserInputRef[], b: readonly UserInputRef[]) =>
  a.length === b.length && a.every((r, i) => r.kind === b[i]?.kind && r.id === b[i]?.id);
/** facts before relations, by id: the order `readInsight` reads them in */
const inOrder = (inputs: readonly UserInputRef[]) =>
  [...inputs].sort((p, q) => (p.kind === q.kind ? p.id - q.id : p.kind === "fact" ? -1 : 1));

/**
 * Judges again, in one transaction, every key the rules find for the items or a member of their groups, plus
 * every stored key of those rules in any state (a key a merge made stale is found there, to be resolved). A rule
 * whose type is not `supported` in the type table makes no Insight. Reports each key it judged except one that
 * neither holds nor has a row. With `scope`, an Insight whose evidence comes from sources the policy will not let
 * be put together is resolved like one that does not hold. `at` is the time a changed Insight is stamped with.
 */
export function runInsightRules(
  db: SqlDriver,
  itemIds: readonly number[],
  rules: readonly InsightRule[],
  options: { scope?: RuleScope; at?: string } = {},
): { key: InsightKey; outcome: RuleOutcome }[] {
  return db.transaction(() => {
    const at = options.at ?? new Date().toISOString();
    const all = withGroups(db, itemIds);
    const results: { key: InsightKey; outcome: RuleOutcome }[] = [];
    for (const rule of rules) {
      if (insightType(rule.type)?.status !== "supported") continue;
      const keys = new Map<string, InsightKey>();
      const keep = (xItemId: number, yItemId: number) =>
        keys.set(`${xItemId}:${yItemId}`, { rule: rule.type, xItemId, yItemId });
      for (const c of rule.candidates(db, all)) keep(c.xItemId, c.yItemId);
      for (const k of listInsightKeys(db, rule.type, all)) keep(k.xItemId, k.yItemId);
      for (const key of keys.values()) {
        let desired = rule.evaluate(db, key);
        if (desired.state === "active" && options.scope) {
          const lineage = unionOfVersions(
            listEvidenceVersions(db, desired.evidenceIds),
            ...desired.userInputs.map((input) => rowLineage(db, input)),
            ...linkLineage(db, desired.linkIds),
          );
          if (!options.scope.combinable(lineage)) desired = { state: "resolved" };
        }
        const stored = readInsight(db, key);
        if (desired.state === "resolved") {
          if (!stored) continue;
          const outcome = stored.state === "resolved" ? "unchanged" : "resolved";
          if (outcome !== "unchanged") saveInsight(db, key, { state: "resolved" });
          results.push({ key, outcome });
          continue;
        }
        const inputs = new Set(desired.userInputs.map((r) => `${r.kind}:${r.id}`));
        const confidence = Math.min(
          100,
          ...desired.usedRows.map((r) =>
            inputs.has(`${r.kind}:${r.id}`) ? 100 : rowConfidence(db, r),
          ),
        );
        const userInputs = inOrder(desired.userInputs);
        const textChanged =
          !stored ||
          stored.state !== "active" ||
          stored.changedAt === null ||
          stored.summary !== desired.summary ||
          !sameLines(stored.factLines, desired.factLines);
        const same =
          stored?.state === "active" &&
          !textChanged &&
          stored.reasoningSummary === desired.reasoningSummary &&
          stored.confidence === confidence &&
          stored.urgencyDate === desired.urgencyDate &&
          sameIds(stored.evidenceIds, desired.evidenceIds) &&
          sameInputs(stored.userInputs, userInputs) &&
          sameIds(stored.linkIds, desired.linkIds);
        const outcome: RuleOutcome = !stored
          ? "created"
          : stored.state === "resolved"
            ? "revived"
            : same
              ? "unchanged"
              : "updated";
        if (outcome !== "unchanged") {
          saveInsight(db, key, {
            state: "active",
            summary: desired.summary,
            factLines: desired.factLines,
            reasoningSummary: desired.reasoningSummary,
            confidence,
            urgencyDate: desired.urgencyDate,
            evidenceIds: desired.evidenceIds,
            userInputs,
            linkIds: desired.linkIds,
            ...(textChanged ? { changedAt: at } : {}),
          });
        }
        results.push({ key, outcome });
      }
    }
    return results;
  });
}
