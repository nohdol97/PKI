// The canonical derivative kinds (I04-R1, I04-T03) and the product's derivative
// registry. Ten kinds live in the canonical file (the last two are entity resolution's, S02-T04, below) and run inside the transaction
// that changed the source: source versions with their keyword index rows (the
// version delete trigger), evidence, facts, relations, items and Insights. A
// deletion's phase 1 collects what the source's evidence reaches before anything
// is deleted (V02 "T02가 넘기는 것" 5); phase 2 runs the layers in order, each
// kind on its own collection and on the state the lower layers left: deleting
// the versions cascades their evidence and the Insights' evidence links, and
// deleting an item cascades its Insights, so those kinds count the rows of their
// collection the cascades took. A new version supersedes what lost its current
// evidence and recomputes the rule (V02-R11); nothing is deleted and the earlier
// versions stay (I04-R10). Facts and relations a deletion leaves are judged again
// by the same rule (I04-R8), except the ones the user wrote, which skip it and go only with their item
// (S01-R14): an item left with no row from a source is deleted, the user's rows on it with it, unless
// the user created the item. The two projection kinds (projection-kinds.ts) follow them in the
// product registry; they register the removal jobs after the canonical purge.
//
// The entries, applyTombstone and propagateNewVersion, keep their results (the ids
// each kind touched and the rule's outcomes); the kinds note those for the entry
// that runs the registry, by its transaction, beside the counts the record keeps.
import {
  automatedLifecycle,
  checkLinesReading,
  claimCandidates,
  judgeClaims,
  createDerivativeRegistry,
  defaultScopePolicy,
  EXTRACT_JOB_KIND,
  lineageOfItems,
  listEvidence,
  notifyMembership,
  OPPORTUNITY_RULE,
  queueChecksAround,
  registerJob,
  rejudgeGroups,
  rowLineage,
  saveInsight,
  unionOfVersions,
  userInputsOf,
  type Affected,
  type DerivativeKind,
  type DerivativeRegistry,
  type DerivedRef,
  type InsightKey,
  type InvalidationContext,
  type MembershipListener,
  type Propagation as RegistryPropagation,
  type ScopePolicy,
  type SourceChange,
  type SourceVersionRef,
  type SqlDriver,
  type SqlValue,
  withGroups,
} from "@pki/storage";
import { assessAfterPropagation } from "./auto-verify.ts";
import { refreshConflicts } from "./conflicts.ts";
import { recomputeInsights } from "./insight-code-rules.ts";
import type { RuleOutcome } from "./insight-rules.ts";
import { refreshCandidates } from "./entity-resolution.ts";
import { projectionKinds, type PermanentlyAbsent } from "./projection-kinds.ts";
import { WIKI_PAGE_KIND } from "./wiki-kind.ts";

/** What one propagation did, by id, for V02's entries (ascending ids). */
export interface CanonicalReport {
  /** Version rows deleted. */
  versions: number;
  facts: number[];
  relations: number[];
  items: number[];
  /** Kept rows that lost their last current evidence and became superseded. */
  superseded: { facts: number[]; relations: number[] };
  /** Collected items still stored: the rule recomputed their pairs. */
  remainingItemIds: number[];
  insights: { key: InsightKey; outcome: RuleOutcome }[];
}

/**
 * The propagation propagateCanonical is running (propagate is synchronous, so
 * one at a time; a nested one saves and restores it): the report the kinds note
 * ids in, whatever driver object they are handed, the time of its record, and
 * the records the kinds were called for (one, or the run fails loudly).
 */
interface Run {
  report: CanonicalReport;
  at: string;
  invalidationIds: Set<number>;
  /** Rows of a kind that a membership receiver changed inside this propagation (the kind's own count adds them). */
  byReceivers: Map<string, number>;
  /** The items the `insight` kind's collection reached with their groups, as they were before anything changed. */
  groupBefore: number[];
}
let running: Run | undefined;

function noting(ctx: InvalidationContext): CanonicalReport | undefined {
  running?.invalidationIds.add(ctx.invalidationId);
  return running?.report;
}

const ascending = (values: Iterable<number>) => [...new Set(values)].sort((a, b) => a - b);

/**
 * The change kinds the canonical kinds propagate: the three tombstone reasons are one
 * "deletion". A prune (I04-T12) names the version it keeps (`change.version`, the latest);
 * the versions it takes are those below it.
 */
function supported(change: SourceChange): "new-version" | "scope-changed" | "deletion" | "pruned" {
  if (change.kind === "old-versions-pruned") return "pruned";
  if (change.kind === "new-version" || change.kind === "scope-changed") return change.kind;
  return "deletion";
}

/**
 * The source version a propagation's supersede rests on (S01-R6): the new version, the version a
 * tombstone covers, or the version a prune keeps.
 */
const basisOf = (change: Exclude<SourceChange, { kind: "scope-changed" }>) => ({
  sourceId: change.sourceId,
  version: "coversVersion" in change ? change.coversVersion : change.version,
});

/** A prune takes the versions below the one it keeps; every other deletion takes all of them. */
const below = (change: SourceChange, column = "") =>
  change.kind === "old-versions-pruned" ? `AND ${column}version < ?` : "";
const belowParams = (change: SourceChange): SqlValue[] =>
  change.kind === "old-versions-pruned" ? [change.version] : [];

const versionsOf = (db: SqlDriver, sql: string, params: SqlValue[]): SourceVersionRef[] =>
  db
    .all(sql, params)
    .map((r) => ({ sourceId: r.source_id as number, version: r.version as number }));

const collect = (db: SqlDriver, kind: string, sql: string, params: SqlValue[]): Affected =>
  db.all(sql, params).map((r) => {
    const ref = { kind, id: String(r.id) };
    return { ref, lineage: lineageOf[kind]?.(db, Number(r.id)) ?? [] };
  });

const stored = (db: SqlDriver, table: string, id: number) =>
  db.all(`SELECT 1 FROM ${table} WHERE id = ?`, [id]).length === 1;

/** The ids of a collection whose rows the cascades or this kind took. */
const gone = (db: SqlDriver, table: string, snapshot: Affected) =>
  snapshot.map((a) => Number(a.ref.id)).filter((id) => !stored(db, table, id));

const VERSIONS = (where: string) =>
  `SELECT DISTINCT v.source_id, v.version FROM source_versions v WHERE ${where}
   ORDER BY v.source_id, v.version`;
const EVIDENCE_VERSIONS = (where: string) =>
  VERSIONS(`v.id IN (SELECT e.source_version_id FROM evidence e WHERE ${where})`);
/**
 * Facts and relations some evidence on a version of the source cites. `limit` narrows the versions (a prune
 * takes only those below the one it keeps: `below(change, "v.")`, its parameters after the source's).
 */
const CITED = (column: "fact_id" | "relation_id", limit = "") =>
  `SELECT e.${column} FROM evidence e JOIN source_versions v ON v.id = e.source_version_id
   WHERE v.source_id = ? ${limit} AND e.${column} IS NOT NULL`;
/** Items of those rows: a fact's item, a relation's subject and object. */
const citedItems = (limit = "") => `
  SELECT item_id AS id FROM facts WHERE id IN (${CITED("fact_id", limit)})
  UNION SELECT subject_id FROM relations WHERE id IN (${CITED("relation_id", limit)})
  UNION SELECT object_id FROM relations WHERE id IN (${CITED("relation_id", limit)})`;
const CITED_ITEMS = citedItems();

const lineageOf: Record<string, (db: SqlDriver, id: number) => SourceVersionRef[]> = {
  source: (db, id) => versionsOf(db, VERSIONS("v.id = ?"), [id]),
  evidence: (db, id) => versionsOf(db, EVIDENCE_VERSIONS("e.id = ?"), [id]),
  // a row the user wrote has the lineage of the item it is on, and an item the user created none
  // (S01-R22); the three share one definition with the rule's lineage of a user input (storage)
  fact: (db, id) => rowLineage(db, { kind: "fact", id }),
  relation: (db, id) => rowLineage(db, { kind: "relation", id }),
  item: (db, id) => rowLineage(db, { kind: "item", id }),
  "scope-drop": (db, id) =>
    versionsOf(db, "SELECT source_id, version FROM scope_policy_drops WHERE id = ?", [id]),
  // the evidence the Insight cites, and the lineage of each user input it used (S01-R15): a row the
  // user wrote or approved with no current evidence cites nothing, yet its sources are the Insight's
  insight: (db, id) =>
    unionOfVersions(
      versionsOf(
        db,
        EVIDENCE_VERSIONS(
          "e.id IN (SELECT evidence_id FROM insight_evidence WHERE insight_id = ?)",
        ),
        [id],
      ),
      ...userInputsOf(db, id).map((input) => rowLineage(db, input)),
      // the links that took a value out of the rule's reading (S02-R19)
      ...db
        .all("SELECT link_id FROM insight_link_inputs WHERE insight_id = ?", [id])
        .map((r) => linkLineage(db, r.link_id as number)),
    ),
  // only a candidate or a rejected type definition follows its source; a verified one (and a retired
  // one, which was verified) is a rule the user accepted and holds no lineage (S01-R20, R22)
  ontology: (db, id) =>
    versionsOf(
      db,
      `SELECT b.source_id, b.version FROM ontology_basis b JOIN ontology_elements e ON e.id = b.element_id
       WHERE b.element_id = ? AND e.status IN ('candidate', 'rejected') ORDER BY b.source_id, b.version`,
      [id],
    ),
};

const lineage = (kind: string) => (db: SqlDriver, ref: DerivedRef) =>
  lineageOf[kind]?.(db, Number(ref.id)) ?? [];

const base = (kind: string, layer: DerivativeKind["layer"]) =>
  ({
    kind,
    layer,
    references: [],
    storage: "canonical",
    dataPaths: [],
    lineage: lineage(kind),
  }) as const;

/** Source versions and their keyword index rows (I04-R3 `등록 종류 source`). */
const SOURCE: DerivativeKind = {
  ...base("source", "source"),
  affected: (tx, change) => {
    const mode = supported(change);
    if (mode === "new-version" || mode === "scope-changed") return []; // every version stays (I04-R10, R15)
    return collect(
      tx,
      "source",
      `SELECT id FROM source_versions WHERE source_id = ? ${below(change)} ORDER BY id`,
      [change.sourceId, ...belowParams(change)],
    );
  },
  // the delete trigger takes the version's keyword index row; the cascades its
  // evidence and the Insights' links to that evidence
  invalidate: (ctx, snapshot) => {
    let removed = 0;
    for (const { ref } of snapshot) {
      removed += ctx.tx.run("DELETE FROM source_versions WHERE id = ?", [Number(ref.id)]).changes;
    }
    const report = noting(ctx);
    if (report) report.versions += removed;
    return { removed, recomputed: 0 };
  },
};

const EVIDENCE: DerivativeKind = {
  ...base("evidence", "evidence"),
  affected: (tx, change) => {
    const mode = supported(change);
    if (mode === "new-version" || mode === "scope-changed") {
      return []; // evidence is immutable; on an earlier version it becomes past evidence by itself
    }
    return collect(
      tx,
      "evidence",
      `SELECT e.id FROM evidence e JOIN source_versions v ON v.id = e.source_version_id
       WHERE v.source_id = ? ${below(change, "v.")} ORDER BY e.id`,
      [change.sourceId, ...belowParams(change)],
    );
  },
  // the version delete cascaded it; whatever a schema without the cascade kept goes here
  invalidate: (ctx, snapshot) => {
    noting(ctx);
    const { tx } = ctx;
    for (const { ref } of snapshot) tx.run("DELETE FROM evidence WHERE id = ?", [Number(ref.id)]);
    return { removed: gone(tx, "evidence", snapshot).length, recomputed: 0 };
  },
};

/**
 * Whether a row from a source (not one the user wrote, S01-R14) is on the item: its facts, and the
 * relations it is the subject or the object of, except the rows this propagation deletes (`going`: the
 * cited rows of the collection that are left with no evidence, which their own kind deletes). The same
 * answer before and after those deletions, so the kinds before the item kind can judge the item.
 * Evidence attached to a row the user wrote does not hold the item: it states the user's value, and
 * the item's name came from the source rows (the deletion guarantee reads first).
 */
const SOURCE_ROW_ON_ITEM = `
  SELECT 1 FROM facts f WHERE f.item_id = ? AND f.user_authored = 0
    AND f.id NOT IN (SELECT value FROM json_each(?))
  UNION ALL SELECT 1 FROM relations r
    WHERE (r.subject_id = ? OR r.object_id = ?) AND r.user_authored = 0
    AND r.id NOT IN (SELECT value FROM json_each(?)) LIMIT 1`;

/** The collected rows of a kind that a source row left with no evidence: deleted by that kind. */
function going(ctx: InvalidationContext, kind: "fact" | "relation"): number[] {
  const table = kind === "fact" ? "facts" : "relations";
  const target = (id: number) => (kind === "fact" ? { factId: id } : { relationId: id });
  return (ctx.collected.get(kind) ?? [])
    .map((a) => Number(a.ref.id))
    .filter(
      (id) =>
        ctx.tx.all(`SELECT 1 FROM ${table} WHERE id = ? AND user_authored = 0`, [id]).length ===
          1 && listEvidence(ctx.tx, target(id)).length === 0,
    );
}

/** The ids of the rows this propagation deletes for lack of evidence, as the JSON lists the query binds. */
interface Going {
  facts: string;
  relations: string;
}
const goingOf = (ctx: InvalidationContext): Going => ({
  facts: JSON.stringify(going(ctx, "fact")),
  relations: JSON.stringify(going(ctx, "relation")),
});

/** An item no row from a source holds any more, and the user did not create (a created one stays). */
function withoutSource(tx: SqlDriver, id: number, leaving: Going): boolean {
  if (!stored(tx, "items", id)) return false;
  if (tx.all("SELECT 1 FROM items WHERE id = ? AND user_authored = 1", [id]).length === 1) {
    return false;
  }
  return tx.all(SOURCE_ROW_ON_ITEM, [id, leaving.facts, id, id, leaving.relations]).length === 0;
}

/**
 * The collected items a deletion or a prune leaves with no row from a source (S01-R14): the items the
 * item kind deletes, and whose rows the user wrote go with them. A new version deletes nothing.
 */
function doomedItems(ctx: InvalidationContext, change: SourceChange): number[] {
  const mode = supported(change);
  if (mode !== "deletion" && mode !== "pruned") return [];
  const leaving = goingOf(ctx);
  return (ctx.collected.get("item") ?? [])
    .map((a) => Number(a.ref.id))
    .filter((id) => withoutSource(ctx.tx, id, leaving));
}

/**
 * A fact or relation the source's evidence cites, judged again (V02-R11, I04-R8):
 * left without any evidence it is deleted, whatever its status and epistemic type
 * (a user-approved value came from the deleted source); left with no current
 * evidence it becomes superseded (rejected and superseded rows stay). Its
 * epistemic type never changes. After a new version nothing loses its evidence.
 * A row the user wrote skips both rules (S01-R14): its value is the user's, not the source's, so it
 * stays at no evidence and is never superseded. It goes with its item, which is judged by the item
 * kind: the rows the user wrote on an item left with no row from a source are deleted here, by their
 * own kind, so the record counts them as facts and relations.
 */
function knowledgeKind(kind: "fact" | "relation"): DerivativeKind {
  const table = kind === "fact" ? "facts" : "relations";
  const column = kind === "fact" ? "fact_id" : "relation_id";
  const target = (id: number) => (kind === "fact" ? { factId: id } : { relationId: id });
  return {
    ...base(kind, "knowledge"),
    // a scope change keeps the content: only Insight-layer kinds recompute (I04-R15)
    affected: (tx, change) => {
      if (supported(change) === "scope-changed") return [];
      return collect(
        tx,
        kind,
        `SELECT id FROM ${table} WHERE id IN (${CITED(column)}) ORDER BY id`,
        [change.sourceId],
      );
    },
    invalidate: (ctx, snapshot, change) => {
      const { tx } = ctx;
      const deleted: number[] = [];
      const superseded: number[] = [];
      // the items the rows reach, named before any row goes: the automatic promotion judges their facts after
      const reachedItems: number[] = [];
      for (const { ref } of snapshot) {
        const id = Number(ref.id);
        const row = tx.all(
          `SELECT status, user_authored${kind === "fact" ? ", item_id" : ""} FROM ${table} WHERE id = ?`,
          [id],
        )[0];
        if (row === undefined) continue;
        if (kind === "fact") reachedItems.push(row.item_id as number);
        const status = row.status;
        const evidence = listEvidence(tx, target(id));
        if (evidence.length === 0) {
          if (row.user_authored === 1) continue; // the user's value: only its item takes it (R14)
          tx.run(`DELETE FROM ${table} WHERE id = ?`, [id]);
          deleted.push(id);
        } else if (
          status !== "superseded" &&
          status !== "rejected" &&
          change.kind !== "scope-changed" && // nothing is collected for it; narrows the basis
          !evidence.some((e) => e.current)
        ) {
          const outcome = automatedLifecycle.supersede(
            tx,
            { kind, id },
            basisOf(change),
            running?.at,
          );
          if (outcome.status === "applied") superseded.push(id);
        }
      }
      // the rows the user wrote on an item no source row holds go with the item (R14)
      const doomed = doomedItems(ctx, change);
      if (doomed.length > 0) {
        const where =
          kind === "fact"
            ? "item_id IN (SELECT value FROM json_each(?))"
            : "subject_id IN (SELECT value FROM json_each(?)) OR object_id IN (SELECT value FROM json_each(?))";
        const ids = JSON.stringify(doomed);
        const written = tx
          .all(`SELECT id FROM ${table} WHERE user_authored = 1 AND (${where}) ORDER BY id`, [
            ids,
            ...(kind === "fact" ? [] : [ids]),
          ])
          .map((r) => r.id as number);
        for (const id of written) tx.run(`DELETE FROM ${table} WHERE id = ?`, [id]);
        deleted.push(...written);
      }
      // S01-R9: after the evidence was taken away and the rows judged again, the promotion is judged (off by default)
      assessAfterPropagation(
        tx,
        {
          itemIds: reachedItems,
          relationIds: kind === "relation" ? snapshot.map(({ ref }) => Number(ref.id)) : [],
        },
        running?.at,
      );
      const report = noting(ctx);
      if (report) {
        report[kind === "fact" ? "facts" : "relations"].push(...deleted);
        report.superseded[kind === "fact" ? "facts" : "relations"].push(...superseded);
      }
      return { removed: deleted.length, recomputed: superseded.length };
    },
  };
}

/** The two facts of a link: its lineage is both facts' lineage together (S02-R18). */
const linkLineage = (db: SqlDriver, id: number): SourceVersionRef[] => {
  const link = db.all("SELECT from_fact_id, to_fact_id FROM assertion_links WHERE id = ?", [id])[0];
  if (!link) return [];
  return unionOfVersions(
    rowLineage(db, { kind: "fact", id: link.from_fact_id as number }),
    rowLineage(db, { kind: "fact", id: link.to_fact_id as number }),
  );
};

/**
 * The links between two facts (`assertion_links`, schema v26; S02-R18, R19). The ones the source's evidence
 * reaches are collected (a link with a fact it cites, for every change kind: a scope change may let a pair
 * be put together or not). A fact deleted by the fact kind took its links with it (cascade); the `rule`
 * links of the items the change reached are judged again over the state the lower layers left, so a value
 * that lost its evidence no longer stands against another, and a fact whose superseding value went is no
 * longer superseded. When the links changed, the automatic promotion judges the reached items again (its
 * condition 5 reads supersession). Counted as removed: the collected rows no longer stored; as recomputed:
 * the links created.
 */
const ASSERTION_LINK: DerivativeKind = {
  ...base("assertion-link", "knowledge"),
  lineage: (db, ref) => linkLineage(db, Number(ref.id)),
  affected: (tx, change) => {
    supported(change);
    return collect(
      tx,
      "assertion-link",
      `SELECT id FROM assertion_links
       WHERE from_fact_id IN (${CITED("fact_id")}) OR to_fact_id IN (${CITED("fact_id")}) ORDER BY id`,
      [change.sourceId, change.sourceId],
    );
  },
  invalidate: (ctx, snapshot, change) => {
    noting(ctx);
    const { tx } = ctx;
    const reached = new Set<number>((ctx.collected.get("item") ?? []).map((a) => Number(a.ref.id)));
    if (change.kind === "scope-changed") {
      for (const id of reachedItems(tx, change.sourceId)) reached.add(id);
    }
    const items = ascending([...reached].filter((id) => stored(tx, "items", id)));
    const refreshed = refreshConflicts(
      tx,
      items,
      { combinable: (lineage) => ctx.combinable(lineage) },
      {
        ...(running ? { at: running.at } : {}),
      },
    );
    const removed = gone(tx, "assertion_links", snapshot).length;
    if (removed + refreshed.created + refreshed.removed > 0) {
      assessAfterPropagation(tx, { itemIds: items, relationIds: [] }, running?.at);
    }
    return {
      removed,
      recomputed: refreshed.created + (running?.byReceivers.get("assertion-link") ?? 0),
    };
  },
};

/**
 * An item a cited row holds: deleted once no row from a source is left on it (S01-R14), its Insights
 * with it (cascade). An item the user created stays, whatever was on it; the rows the user wrote on a
 * deleted item went with it in their own kinds (above).
 */
const ITEM: DerivativeKind = {
  ...base("item", "item"),
  affected: (tx, change) => {
    if (supported(change) === "scope-changed") return [];
    const id = change.sourceId;
    return collect(tx, "item", `SELECT id FROM (${CITED_ITEMS}) ORDER BY id`, [id, id, id]);
  },
  invalidate: (ctx, _snapshot, change) => {
    const { tx } = ctx;
    const deleted = doomedItems(ctx, change); // none for a new version: nothing is deleted (I04-R10)
    for (const id of deleted) tx.run("DELETE FROM items WHERE id = ?", [id]);
    noting(ctx)?.items.push(...deleted);
    return { removed: deleted.length, recomputed: 0 };
  },
};

/**
 * An Insight on a collected item: gone with its item (cascade), or judged again
 * by the rule over the collected items that are left, in the same transaction, so
 * an explanation built from the deleted source is rebuilt without it (I04-R5, R8).
 * A scope change (I04-R15) deletes nothing: the Insights on the items the source's
 * evidence reaches are judged again over their own items, under the policy
 * (`combinable`): one whose sources can no longer be put together is resolved, and
 * one that can again is revived in its row. The same judgement runs after a deletion.
 * Counted as recomputed when the rule changed its row.
 */
const INSIGHT: DerivativeKind = {
  ...base("insight", "insight"),
  affected: (tx, change) => {
    const id = change.sourceId;
    supported(change);
    // the Insights on the items the source's evidence reaches and on every member of their groups, as
    // the groups are before anything changes (S02-R13), a resolved row included: a scope change may
    // revive it, and a resolved row has no evidence link of its own to find it by
    const before = withGroups(tx, reachedItems(tx, id));
    if (running) running.groupBefore = before;
    const group = JSON.stringify(before);
    return collect(
      tx,
      "insight",
      `SELECT id FROM insights WHERE x_item_id IN (SELECT value FROM json_each(?))
         OR y_item_id IN (SELECT value FROM json_each(?)) ORDER BY id`,
      [group, group],
    );
  },
  invalidate: (ctx, snapshot, change) => {
    const { tx } = ctx;
    // P01-D13: an LLM reading was made from the lineage as it was, and an unchanged Insight is not rewritten, so
    // a deletion, prune or scope change (not a new version: a changed Insight is rewritten, which empties it) empties the reading of every collected Insight and resolves its opportunity
    for (const { ref } of supported(change) === "new-version" ? [] : snapshot) {
      tx.run(
        "UPDATE insights SET llm_reasoning_summary = NULL, llm_impact = NULL, llm_actionability = NULL WHERE id = ?",
        [Number(ref.id)],
      );
      const row = tx.all(
        "SELECT rule, x_item_id, y_item_id FROM insights WHERE id = ? AND state = 'active'",
        [Number(ref.id)],
      )[0];
      if (row?.rule === OPPORTUNITY_RULE) {
        saveInsight(
          tx,
          {
            rule: OPPORTUNITY_RULE,
            xItemId: row.x_item_id as number,
            yItemId: row.y_item_id as number,
          },
          { state: "resolved" },
        );
      }
    }
    const items =
      change.kind === "scope-changed"
        ? snapshot.flatMap(({ ref }) =>
            tx
              .all("SELECT x_item_id, y_item_id FROM insights WHERE id = ?", [Number(ref.id)])
              .flatMap((r) => [r.x_item_id as number, r.y_item_id as number]),
          )
        : (ctx.collected.get("item") ?? []).map((a) => Number(a.ref.id));
    const remaining = ascending(items.filter((id) => stored(tx, "items", id)));
    // an Insight collected only through a group names no reached item (the reached member may be gone):
    // its ends are judged again too, over their groups as they are now
    const reached = new Set(items);
    const viaGroup = snapshot.flatMap(({ ref }) =>
      tx
        .all("SELECT x_item_id, y_item_id FROM insights WHERE id = ?", [Number(ref.id)])
        .map((r) => [r.x_item_id as number, r.y_item_id as number])
        .filter((ends) => !ends.some((end) => reached.has(end)))
        .flat(),
    );
    // the members that survive of the groups as they were before the change: a deleted representative
    // took its Insight with it (cascade), and the survivors' own Insight is keyed by the new top (R13)
    const survivors = (running?.groupBefore ?? []).filter((id) => stored(tx, "items", id));
    const outcomes = recomputeInsights(
      tx,
      ascending([...remaining, ...survivors, ...viaGroup.filter((id) => stored(tx, "items", id))]),
      { scope: ctx, ...(running ? { at: running.at } : {}) },
    );
    const report = noting(ctx);
    if (report) {
      report.remainingItemIds = remaining;
      report.insights = outcomes;
    }
    return {
      removed: gone(tx, "insights", snapshot).length,
      recomputed:
        outcomes.filter((o) => o.outcome !== "unchanged").length +
        (running?.byReceivers.get("insight") ?? 0),
    };
  },
};

/**
 * The ids of the entity-resolution kinds name a row of one of several tables, or a pair: `merge:<id>`,
 * `distinct:<a>:<b>` and `split:<id>` for `entity-merge`, `candidate:<a>:<b>` for `merge-candidate` (the
 * pair is the key). The ids are numbers only; the rows hold no text.
 */
const mergeRef = (table: "merge" | "distinct" | "split" | "candidate", ...key: number[]) =>
  `${table}:${key.join(":")}`;

/** The items a row of `entity-merge` or `merge-candidate` names; none when the row is gone. */
function itemsOfRef(db: SqlDriver, id: string): number[] {
  const [table, ...key] = id.split(":");
  const numbers = key.map(Number);
  const ends = (sql: string) =>
    db
      .all(sql, numbers)
      .flatMap((r) => Object.values(r).filter((v): v is number => typeof v === "number"));
  switch (table) {
    case "merge":
      return ends("SELECT member_id, representative_id FROM item_merges WHERE id = ?");
    case "distinct":
      return ends("SELECT item_a, item_b FROM item_distinct WHERE item_a = ? AND item_b = ?");
    case "split":
      return ends("SELECT from_item_id, to_item_id FROM item_split_moves WHERE id = ?");
    case "candidate":
      return ends("SELECT item_a, item_b FROM merge_candidates WHERE item_a = ? AND item_b = ?");
    default:
      return [];
  }
}

const pairLineage = (db: SqlDriver, ref: DerivedRef) => lineageOfItems(db, itemsOfRef(db, ref.id));

/** The items the source's evidence reaches (the item kind's collection), as plain ids. */
const reachedItems = (tx: SqlDriver, sourceId: number): number[] =>
  tx
    .all(`SELECT id FROM (${CITED_ITEMS}) ORDER BY id`, [sourceId, sourceId, sourceId])
    .map((r) => r.id as number);

const idList = (ids: readonly number[]) => JSON.stringify(ids);

const entityRows = (tx: SqlDriver, mode: "all" | "merges", reached: readonly number[]) => {
  const list = idList(reached);
  const IN = "IN (SELECT value FROM json_each(?))";
  const rows: string[] = tx
    .all(
      `SELECT id FROM item_merges WHERE member_id ${IN} OR representative_id ${IN} ORDER BY id`,
      [list, list],
    )
    .map((r) => mergeRef("merge", r.id as number));
  if (mode === "all") {
    rows.push(
      ...tx
        .all(
          `SELECT item_a, item_b FROM item_distinct WHERE item_a ${IN} OR item_b ${IN}
              ORDER BY item_a, item_b`,
          [list, list],
        )
        .map((r) => mergeRef("distinct", r.item_a as number, r.item_b as number)),
      ...tx
        .all(
          `SELECT id FROM item_split_moves WHERE from_item_id ${IN} OR to_item_id ${IN} ORDER BY id`,
          [list, list],
        )
        .map((r) => mergeRef("split", r.id as number)),
    );
  }
  return rows;
};

const refExists = (tx: SqlDriver, id: string) => itemsOfRef(tx, id).length > 0;

/**
 * The merge lines, distinct marks and split records (S02-R14, R16; `item_merges`, `item_distinct`,
 * `item_split_moves`, schema v24). Each names two items and has their two lineages. A deletion or a prune
 * takes the rows that name an item deleted with it, and first mends the chain around such an item: the lines
 * that pointed at the deleted item point at what it pointed at (A->B->C with B gone is A->C), and when the
 * deleted item was the top, the smallest member becomes the top of the others. That runs before the item
 * kind deletes the item (this kind references it, so it runs first), because the foreign keys would take
 * the lines with it. Then every group the change reached is judged again, resting or waking all its lines
 * together (R13); a group that rested or woke is announced to the membership listeners, in this
 * transaction, and a listener that throws rolls the propagation back. A scope change only judges again.
 * A new version changes no lineage and does nothing. Counted as removed: the collected rows no longer stored
 * (the lines of a deleted item, the cascade of a deleted fact's split record); as recomputed: the lines
 * joined to a new end and the lines that rested or woke.
 */
function entityMergeKind(listeners: readonly MembershipListener[]): DerivativeKind {
  return {
    ...base("entity-merge", "item"),
    references: ["item"],
    lineage: pairLineage,
    affected: (tx, change) => {
      const mode = supported(change);
      if (mode === "new-version") return [];
      const rows = entityRows(
        tx,
        mode === "scope-changed" ? "merges" : "all",
        reachedItems(tx, change.sourceId),
      );
      return rows.map((id) => {
        const ref = { kind: "entity-merge", id };
        return { ref, lineage: pairLineage(tx, ref) };
      });
    },
    invalidate: (ctx, snapshot, change) => {
      const mode = supported(change);
      if (mode === "new-version") return { removed: 0, recomputed: 0 };
      noting(ctx);
      const { tx } = ctx;
      const doomed = doomedItems(ctx, change);
      // the groups to judge again: every item a collected merge line names, before anything is mended
      const touched = new Set<number>();
      for (const { ref } of snapshot) {
        if (ref.id.startsWith("merge:")) for (const id of itemsOfRef(tx, ref.id)) touched.add(id);
      }
      let recomputed = 0;
      for (const id of doomed) recomputed += joinAround(tx, id);
      if (doomed.length > 0) {
        const list = idList(doomed);
        tx.run(
          `DELETE FROM item_distinct WHERE item_a IN (SELECT value FROM json_each(?))
             OR item_b IN (SELECT value FROM json_each(?))`,
          [list, list],
        );
        tx.run(
          `DELETE FROM item_split_moves WHERE from_item_id IN (SELECT value FROM json_each(?))
             OR to_item_id IN (SELECT value FROM json_each(?))`,
          [list, list],
        );
      }
      const survivors = [...touched].filter((id) => !doomed.includes(id));
      const judged = rejudgeGroups(tx, survivors, (lineage) => ctx.combinable(lineage));
      recomputed += judged.changedLines;
      // a group that rested or woke is a membership change; a relink alone moves no row's item
      notifyMembership(
        tx,
        listeners,
        { items: judged.items, movedRows: [] },
        {
          combinable: (lineage) => ctx.combinable(lineage),
          recomputed: (kind, count) => {
            if (running)
              running.byReceivers.set(kind, (running.byReceivers.get(kind) ?? 0) + count);
          },
        },
      );
      return {
        removed: snapshot.filter(({ ref }) => !refExists(tx, ref.id)).length,
        recomputed,
      };
    },
  };
}

/**
 * Mends the chain around an item that is about to be deleted (S02-R14) and drops its own line; the
 * number of lines joined to a new end is returned.
 */
function joinAround(tx: SqlDriver, item: number): number {
  const parent = tx.all("SELECT id, representative_id FROM item_merges WHERE member_id = ?", [
    item,
  ])[0];
  const below = tx.all(
    "SELECT id, member_id FROM item_merges WHERE representative_id = ? ORDER BY member_id",
    [item],
  );
  let joined = 0;
  if (parent) {
    for (const line of below) {
      tx.run("UPDATE item_merges SET representative_id = ? WHERE id = ?", [
        parent.representative_id as number,
        line.id as number,
      ]);
      joined++;
    }
    tx.run("DELETE FROM item_merges WHERE id = ?", [parent.id as number]);
    return joined;
  }
  // the top itself goes: the member with the smallest id leads the others
  const [leader, ...others] = below;
  if (!leader) return 0;
  tx.run("DELETE FROM item_merges WHERE id = ?", [leader.id as number]);
  for (const line of others) {
    tx.run("UPDATE item_merges SET representative_id = ? WHERE id = ?", [
      leader.member_id as number,
      line.id as number,
    ]);
    joined++;
  }
  return joined;
}

/**
 * The merge candidates (S02-R10; `merge_candidates`, schema v24): a pair the product suggests, its lineage
 * the two items'. A deleted source's items are deleted before it counts, so a candidate of two items deleted
 * with the source is gone; the candidates of the groups the change reached are judged again over the state
 * the lower layers left (S02-T06): one that lost its support or gained a negative signal is removed, one a
 * change makes possible is created, one the policy will not allow is absent. Counted as removed: the
 * collected rows no longer stored; as recomputed: the rows created or changed.
 */
const MERGE_CANDIDATE: DerivativeKind = {
  ...base("merge-candidate", "item"),
  references: ["item"],
  lineage: pairLineage,
  affected: (tx, change) => {
    supported(change);
    const list = idList(withGroups(tx, reachedItems(tx, change.sourceId)));
    return tx
      .all(
        `SELECT item_a, item_b FROM merge_candidates
         WHERE item_a IN (SELECT value FROM json_each(?)) OR item_b IN (SELECT value FROM json_each(?))
         ORDER BY item_a, item_b`,
        [list, list],
      )
      .map((r) => {
        const ref = {
          kind: "merge-candidate",
          id: mergeRef("candidate", r.item_a as number, r.item_b as number),
        };
        return { ref, lineage: pairLineage(tx, ref) };
      });
  },
  invalidate: (ctx, snapshot, change) => {
    noting(ctx);
    const { tx } = ctx;
    const doomed = doomedItems(ctx, change);
    if (doomed.length > 0) {
      const list = idList(doomed);
      tx.run(
        `DELETE FROM merge_candidates WHERE item_a IN (SELECT value FROM json_each(?))
           OR item_b IN (SELECT value FROM json_each(?))`,
        [list, list],
      );
    }
    // the items to judge: the ones the source's evidence reached (collected before anything changed) and
    // the ends of the collected candidates, whatever of them is left
    const reached = new Set<number>((ctx.collected.get("item") ?? []).map((a) => Number(a.ref.id)));
    for (const { ref } of snapshot) for (const id of itemsOfRef(tx, ref.id)) reached.add(id);
    for (const id of change.kind === "scope-changed" ? reachedItems(tx, change.sourceId) : []) {
      reached.add(id);
    }
    const refreshed = refreshCandidates(
      tx,
      [...reached].sort((a, b) => a - b),
      { combinable: (lineage) => ctx.combinable(lineage) },
      { exclude: new Set(doomed) },
    );
    return {
      removed: snapshot.filter(({ ref }) => !refExists(tx, ref.id)).length,
      recomputed:
        refreshed.created + refreshed.updated + (running?.byReceivers.get("merge-candidate") ?? 0),
    };
  },
};

/**
 * The records of what the scope policy left out (`scope_policy_drops`, schema v18, I04-R11).
 * A deleted source's go with it. A scope change keeps them and queues the extraction of the
 * latest version of every source that has one, since the policy's answer may differ now:
 * the record does not say which source's scope made the refusal, so each source with a record
 * is extracted again, and that extraction clears its records (extraction.ts). The job's
 * target `scope-recompute:<record id>` is new each propagation, because the version's first
 * extraction holds the key (kind, version, target '') and a second widening without a new
 * version would find the same change sequence (I04-R15).
 */
const SCOPE_DROP: DerivativeKind = {
  ...base("scope-drop", "knowledge"),
  affected: (tx, change) => {
    const mode = supported(change);
    if (mode === "new-version") return [];
    // a record names the version it refused: a prune takes the records of the versions it takes
    const where = mode === "scope-changed" ? "" : `WHERE source_id = ? ${below(change)}`;
    return collect(
      tx,
      "scope-drop",
      `SELECT id FROM scope_policy_drops ${where} ORDER BY id`,
      mode === "scope-changed" ? [] : [change.sourceId, ...belowParams(change)],
    );
  },
  invalidate: (ctx, snapshot, change) => {
    const { tx } = ctx;
    if (change.kind !== "scope-changed") {
      let removed = 0;
      for (const { ref } of snapshot) {
        removed += tx.run("DELETE FROM scope_policy_drops WHERE id = ?", [Number(ref.id)]).changes;
      }
      return { removed, recomputed: 0 };
    }
    const sources = [
      ...new Set(snapshot.flatMap(({ lineage }) => lineage.map((v) => v.sourceId))),
    ].sort((a, b) => a - b);
    let queued = 0;
    for (const sourceId of sources) {
      const latest = tx.all("SELECT max(version) AS v FROM source_versions WHERE source_id = ?", [
        sourceId,
      ])[0]?.v as number | null;
      // a source with no version left has nothing to extract (its records went with it)
      if (latest === null || latest === undefined) continue;
      // one open re-extraction per source version is enough: it judges every record, whichever
      // change queued it, so K scope changes leave at most one job per source (I04-R15)
      const open = tx.all(
        `SELECT 1 FROM jobs WHERE kind = ? AND source_id = ? AND fence_version = ?
           AND target LIKE ? AND status IN ('queued', 'running', 'retry', 'held') LIMIT 1`,
        [EXTRACT_JOB_KIND, sourceId, latest, `${RECOMPUTE_PREFIX}%`],
      );
      if (open.length > 0) continue;
      const job = registerJob(tx, {
        priority: "scheduled",
        kind: EXTRACT_JOB_KIND,
        target: `${RECOMPUTE_PREFIX}${ctx.invalidationId}`,
        sourceId,
        fenceVersion: latest,
        at: new Date(running?.at ?? Date.now()),
      });
      if (job.registered) queued++;
    }
    return { removed: 0, recomputed: queued };
  },
};

/**
 * The type definitions (`ontology_elements`, schema v21, S01-R22) and their lineage rows. A deletion
 * (or a prune, for the versions below the one kept) takes the lineage rows that point at the source,
 * for every element, a verified one included (its rows were kept for an undo, R20); then it deletes
 * the candidate and rejected elements left with none. A verified or retired element stays: it is
 * the user's rule, and its history with it. A new version or a scope change keeps every row.
 */
const ONTOLOGY: DerivativeKind = {
  ...base("ontology", "knowledge"),
  affected: (tx, change) => {
    const mode = supported(change);
    if (mode === "new-version" || mode === "scope-changed") return [];
    return collect(
      tx,
      "ontology",
      `SELECT DISTINCT element_id AS id FROM ontology_basis WHERE source_id = ? ${below(change)}
       ORDER BY id`,
      [change.sourceId, ...belowParams(change)],
    );
  },
  invalidate: (ctx, snapshot, change) => {
    noting(ctx);
    const { tx } = ctx;
    let removed = 0;
    for (const { ref } of snapshot) {
      const id = Number(ref.id);
      tx.run(`DELETE FROM ontology_basis WHERE element_id = ? AND source_id = ? ${below(change)}`, [
        id,
        change.sourceId,
        ...belowParams(change),
      ]);
      removed += tx.run(
        `DELETE FROM ontology_elements WHERE id = ? AND status IN ('candidate', 'rejected')
         AND NOT EXISTS (SELECT 1 FROM ontology_basis WHERE element_id = ?)`,
        [id, id],
      ).changes;
    }
    return { removed, recomputed: 0 };
  },
};

/**
 * The analytical semantic's rows that are not registry rows (`dataset_tables` and `analytical_checks`, S03-R17).
 * Layer `insight`: it runs after the fact, relation and item kinds, so a judgement sees the rows they left; it
 * points at no kind of its own layer (`references` stays empty, a reference across layers throws).
 *
 * Three kinds of ref, one prefix each: `table:<dataset_tables.id>` (follows its source's versions),
 * `check:<analytical_checks.id>` (the versions it read and its fact's lineage) and `claim:<fact id>`, a fact
 * whose table support the change touches: not a stored row, so it is counted nowhere and its snapshot lineage is
 * its basis, the table sources and versions the fact's item reached (S03-R17). Phase 2 is the judgement's seat
 * (S03-T06); S03-T05 collects the claims and deletes what is deleted.
 *
 * A deletion takes the source's table rows and the lines that read its versions, a prune the lines that read
 * the pruned versions only (the table rows stay). Both also take the lines that read a row the change removes
 * from under a check: a propagation deletes a row with no history line, so S03-R11's erase on a state change
 * cannot see it. A new version and a deletion take the `aggregation` lines of the Metrics that use a Join on a
 * table of the source (decision D7: a line holds two version columns, a Metric may read more tables). The
 * counts are the phase-1 refs no longer stored, because the version delete cascades some before this kind
 * runs. A scope change keeps every row.
 */
const analyticalRefs = (
  rows: readonly { id: unknown }[],
  prefix: string,
  lineageOfRow: (id: number) => SourceVersionRef[],
) =>
  rows.map((r) => ({
    ref: { kind: "analytical-check", id: `${prefix}:${r.id}` },
    lineage: lineageOfRow(Number(r.id)),
  }));

/** The ids of the lines of the Metrics that use a Join on a Dataset bound to the source (decision D7). */
const JOIN_USERS_LINES = `
  SELECT c.id FROM analytical_checks c JOIN facts f ON f.id = c.fact_id
   WHERE c.check_name = 'aggregation' AND f.item_id IN (
     SELECT u.subject_id FROM relations u
      WHERE u.type = 'USES_JOIN' AND u.object_id IN (
        SELECT j.subject_id FROM relations j
         WHERE j.type IN ('JOIN_LEFT', 'JOIN_RIGHT')
           AND j.object_id IN (SELECT item_id FROM dataset_tables WHERE source_id = ?)))`;

const analyticalLineage = (db: SqlDriver, ref: DerivedRef): SourceVersionRef[] => {
  const [prefix, rest] = ref.id.split(":");
  const id = Number(rest);
  if (prefix === "table") {
    return versionsOf(
      db,
      VERSIONS("v.source_id = (SELECT source_id FROM dataset_tables WHERE id = ?)"),
      [id],
    );
  }
  if (prefix !== "check") return []; // a claim is no stored row: its basis rides on the snapshot
  const line = db.all(
    "SELECT fact_id, version_id, other_version_id FROM analytical_checks WHERE id = ?",
    [id],
  )[0];
  if (!line) return [];
  const read = versionsOf(db, VERSIONS("v.id IN (?, coalesce(?, ?))"), [
    line.version_id as number,
    line.other_version_id as number | null,
    line.version_id as number,
  ]);
  return unionOfVersions(read, rowLineage(db, { kind: "fact", id: line.fact_id as number }));
};

const ANALYTICAL_CHECK: DerivativeKind = {
  ...base("analytical-check", "insight"),
  lineage: analyticalLineage,
  affected: (tx, change) => {
    const mode = supported(change);
    if (mode === "scope-changed") return [];
    const id = change.sourceId;
    const lines = new Set<number>();
    const read = (sql: string, params: SqlValue[]) =>
      tx.all(sql, params).forEach((r) => lines.add(r.id as number));
    // lines that read a version this change takes (all of them for a deletion, those below the kept one for a prune)
    if (mode !== "new-version") {
      const taken = `SELECT v.id FROM source_versions v WHERE v.source_id = ? ${below(change, "v.")}`;
      read(
        `SELECT c.id FROM analytical_checks c WHERE c.version_id IN (${taken})
            OR c.other_version_id IN (${taken})`,
        [id, ...belowParams(change), id, ...belowParams(change)],
      );
      // rows the evidence of this source cites go with their evidence without a history line, and the user's
      // rows on or touching the cited items go with their items: the lines that read them are stale
      // a prune takes the evidence on the versions below the kept one only: a row cited on the kept version too
      // is judged by the rows' own kinds and stays
      const limit = below(change, "v.");
      const p = belowParams(change);
      const items = citedItems(limit);
      const cited = [
        ...tx
          .all(`SELECT id FROM facts WHERE id IN (${CITED("fact_id", limit)})`, [id, ...p])
          .map((r) => ({ kind: "fact" as const, id: r.id as number })),
        ...tx
          .all(`SELECT id FROM relations WHERE id IN (${CITED("relation_id", limit)})`, [id, ...p])
          .map((r) => ({ kind: "relation" as const, id: r.id as number })),
        ...tx
          .all(
            `SELECT id FROM facts WHERE user_authored = 1 AND item_id IN (SELECT id FROM (${items}))`,
            [id, ...p, id, ...p, id, ...p],
          )
          .map((r) => ({ kind: "fact" as const, id: r.id as number })),
        ...tx
          .all(
            `SELECT id FROM relations WHERE user_authored = 1
               AND (subject_id IN (SELECT id FROM (${items})) OR object_id IN (SELECT id FROM (${items})))`,
            [id, ...p, id, ...p, id, ...p, id, ...p, id, ...p, id, ...p],
          )
          .map((r) => ({ kind: "relation" as const, id: r.id as number })),
      ];
      for (const row of cited) for (const line of checkLinesReading(tx, row)) lines.add(line);
    }
    if (mode !== "pruned") read(JOIN_USERS_LINES, [id]);
    const sorted = [...lines].sort((a, b) => a - b);
    const tables =
      mode === "deletion"
        ? tx
            .all("SELECT id FROM dataset_tables WHERE source_id = ? ORDER BY id", [id])
            .map((r) => ({ id: r.id as number }))
        : [];
    const claims =
      mode === "new-version"
        ? []
        : claimCandidates(tx, {
            sourceId: id,
            mode: mode === "deletion" ? "deletion" : "pruned",
            ...(change.kind === "old-versions-pruned" ? { keptVersion: change.version } : {}),
          });
    return [
      ...analyticalRefs(tables, "table", (n) =>
        analyticalLineage(tx, { kind: "analytical-check", id: `table:${n}` }),
      ),
      ...analyticalRefs(
        sorted.map((n) => ({ id: n })),
        "check",
        (n) => analyticalLineage(tx, { kind: "analytical-check", id: `check:${n}` }),
      ),
      ...claims.map((c) => ({
        ref: { kind: "analytical-check", id: `claim:${c.factId}` },
        lineage: c.basis,
      })),
    ];
  },
  invalidate: (ctx, snapshot, change) => {
    const { tx } = ctx;
    noting(ctx);
    const table = { table: "dataset_tables", check: "analytical_checks" } as const;
    let removed = 0;
    const claims: { factId: number; basis: readonly SourceVersionRef[] }[] = [];
    // the facts whose lines this kind erases: their sources are checked again (S03-R12 ②), read before the lines go
    const lineIds = snapshot
      .filter(({ ref }) => ref.id.startsWith("check:"))
      .map(({ ref }) => Number(ref.id.slice("check:".length)));
    const erased = tx
      .all(
        `SELECT DISTINCT f.item_id FROM analytical_checks c JOIN facts f ON f.id = c.fact_id
          WHERE c.id IN (SELECT value FROM json_each(?))`,
        [JSON.stringify(lineIds)],
      )
      .map((r) => r.item_id as number);
    for (const { ref, lineage } of snapshot) {
      const [prefix, rest] = ref.id.split(":");
      const id = Number(rest);
      if (prefix === "claim") {
        claims.push({ factId: id, basis: lineage });
        continue;
      }
      const name = table[prefix as keyof typeof table];
      tx.run(`DELETE FROM ${name} WHERE id = ?`, [id]);
      if (!stored(tx, name, id)) removed++;
    }
    // S03-R16: a `verified` row the change took its table from loses its standing (the check-needing facts the
    // phase-1 collection named, with the basis they were collected with); the sources the claims still reach are
    // checked again
    const mode = supported(change);
    if (mode === "deletion" || mode === "pruned") {
      judgeClaims(tx, claims, { sourceId: change.sourceId, mode });
    }
    const items = tx
      .all("SELECT DISTINCT item_id FROM facts WHERE id IN (SELECT value FROM json_each(?))", [
        JSON.stringify(claims.map((c) => c.factId)),
      ])
      .map((r) => r.item_id as number);
    queueChecksAround(tx, [...new Set([...items, ...erased])]);
    return { removed, recomputed: 0 };
  },
};

/** The target of a re-extraction a scope change queued (I04-R15). */
export const RECOMPUTE_PREFIX = "scope-recompute:";

/**
 * The canonical kinds in their registration order (the registry orders them by layer). The membership
 * listeners are the fixed list the composition root hands over (S02-R13); `CANONICAL_KINDS` is the same
 * kinds with none, as the default registry and the contract suites run them.
 */
export const canonicalKinds = (
  membershipListeners: readonly MembershipListener[] = [],
): readonly DerivativeKind[] =>
  Object.freeze([
    SOURCE,
    EVIDENCE,
    knowledgeKind("fact"),
    knowledgeKind("relation"),
    ASSERTION_LINK,
    SCOPE_DROP,
    ONTOLOGY,
    ITEM,
    entityMergeKind(membershipListeners),
    MERGE_CANDIDATE,
    INSIGHT,
    ANALYTICAL_CHECK,
  ]);
export const CANONICAL_KINDS: readonly DerivativeKind[] = canonicalKinds();

/**
 * A registry of the product's kinds: the six canonical ones and the two projections. Its record's
 * time is the running entry's (a deletion's request time), else the clock's. The composition root
 * builds it (backend composition.ts `productRegistry`) with the configured policy and the marks of
 * the implementations it binds: `permanentlyAbsent` says which projection's implementation never
 * holds anything (I04-R12); the list of kinds is the same for every build.
 */
export function createProductRegistry(options: {
  policy: ScopePolicy;
  permanentlyAbsent?: PermanentlyAbsent;
  /** The fixed list of receivers of a changed membership (S02-R13); none by default. */
  membershipListeners?: readonly MembershipListener[];
}): DerivativeRegistry {
  const now = () => running?.at ?? new Date().toISOString();
  return createDerivativeRegistry({
    kinds: [
      ...canonicalKinds(options.membershipListeners),
      WIKI_PAGE_KIND,
      ...projectionKinds({
        at: now,
        ...(options.permanentlyAbsent ? { permanentlyAbsent: options.permanentlyAbsent } : {}),
      }),
    ],
    policy: options.policy,
    now,
  });
}

/**
 * The registry the entries run until the composition root hands them its own (the entries of
 * entries.ts take a registry): the same kinds, with no mark and the default policy.
 */
export const derivativeRegistry = createProductRegistry({ policy: defaultScopePolicy });

/**
 * Runs the registry in `db`'s current transaction (the caller opens it) and
 * gathers what V02's entries report besides the record's counts. `at` is the
 * record's time (default now). Fails if the kinds noted any record but this
 * propagation's, so a report is never silently another's or empty.
 */
export function propagateCanonical(
  db: SqlDriver,
  change: SourceChange,
  at: string = new Date().toISOString(),
  registry: DerivativeRegistry = derivativeRegistry,
): { propagation: RegistryPropagation; report: CanonicalReport } {
  const report: CanonicalReport = {
    versions: 0,
    facts: [],
    relations: [],
    items: [],
    superseded: { facts: [], relations: [] },
    remainingItemIds: [],
    insights: [],
  };
  const outer = running;
  const run: Run = {
    report,
    at,
    invalidationIds: new Set(),
    byReceivers: new Map(),
    groupBefore: [],
  };
  running = run;
  try {
    const propagation = registry.propagate(db, change);
    const noted = [...run.invalidationIds];
    if (noted.length !== 1 || noted[0] !== propagation.invalidationId) {
      throw new Error(
        `the canonical kinds noted records ${noted.join(", ") || "none"}, not ${propagation.invalidationId}`,
      );
    }
    return {
      propagation,
      report: {
        ...report,
        facts: ascending(report.facts),
        relations: ascending(report.relations),
        items: ascending(report.items),
        superseded: {
          facts: ascending(report.superseded.facts),
          relations: ascending(report.superseded.relations),
        },
      },
    };
  } finally {
    running = outer;
  }
}
