// The canonical derivative kinds (I04-R1, I04-T03) and the product's derivative
// registry. Six kinds live in the canonical file and run inside the transaction
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
  createDerivativeRegistry,
  defaultScopePolicy,
  EXTRACT_JOB_KIND,
  listEvidence,
  registerJob,
  rowLineage,
  unionOfVersions,
  userInputsOf,
  type Affected,
  type DerivativeKind,
  type DerivativeRegistry,
  type DerivedRef,
  type InsightKey,
  type InvalidationContext,
  type Propagation as RegistryPropagation,
  type ScopePolicy,
  type SourceChange,
  type SourceVersionRef,
  type SqlDriver,
  type SqlValue,
} from "@pki/storage";
import { recomputeDependencyDelay, type RuleOutcome } from "./dependency-delay.ts";
import { projectionKinds, type PermanentlyAbsent } from "./projection-kinds.ts";

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
/** Facts and relations some evidence on a version of the source cites. */
const CITED = (column: "fact_id" | "relation_id") =>
  `SELECT e.${column} FROM evidence e JOIN source_versions v ON v.id = e.source_version_id
   WHERE v.source_id = ? AND e.${column} IS NOT NULL`;
/** Items of those rows: a fact's item, a relation's subject and object. */
const CITED_ITEMS = `
  SELECT item_id AS id FROM facts WHERE id IN (${CITED("fact_id")})
  UNION SELECT subject_id FROM relations WHERE id IN (${CITED("relation_id")})
  UNION SELECT object_id FROM relations WHERE id IN (${CITED("relation_id")})`;

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
      for (const { ref } of snapshot) {
        const id = Number(ref.id);
        const row = tx.all(`SELECT status, user_authored FROM ${table} WHERE id = ?`, [id])[0];
        if (row === undefined) continue;
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
      const report = noting(ctx);
      if (report) {
        report[kind === "fact" ? "facts" : "relations"].push(...deleted);
        report.superseded[kind === "fact" ? "facts" : "relations"].push(...superseded);
      }
      return { removed: deleted.length, recomputed: superseded.length };
    },
  };
}

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
    // the Insights on the items the source's evidence reaches, a resolved row included: a scope
    // change may revive it, and a resolved row has no evidence link of its own to find it by
    return collect(
      tx,
      "insight",
      `SELECT id FROM insights WHERE x_item_id IN (${CITED_ITEMS})
         OR y_item_id IN (${CITED_ITEMS}) ORDER BY id`,
      [id, id, id, id, id, id],
    );
  },
  invalidate: (ctx, snapshot, change) => {
    const { tx } = ctx;
    const items =
      change.kind === "scope-changed"
        ? snapshot.flatMap(({ ref }) =>
            tx
              .all("SELECT x_item_id, y_item_id FROM insights WHERE id = ?", [Number(ref.id)])
              .flatMap((r) => [r.x_item_id as number, r.y_item_id as number]),
          )
        : (ctx.collected.get("item") ?? []).map((a) => Number(a.ref.id));
    const remaining = ascending(items.filter((id) => stored(tx, "items", id)));
    const outcomes = recomputeDependencyDelay(tx, remaining, ctx);
    const report = noting(ctx);
    if (report) {
      report.remainingItemIds = remaining;
      report.insights = outcomes;
    }
    return {
      removed: gone(tx, "insights", snapshot).length,
      recomputed: outcomes.filter((o) => o.outcome !== "unchanged").length,
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

/** The target of a re-extraction a scope change queued (I04-R15). */
export const RECOMPUTE_PREFIX = "scope-recompute:";

/** The canonical kinds in their registration order (the registry orders them by layer). */
export const CANONICAL_KINDS: readonly DerivativeKind[] = Object.freeze([
  SOURCE,
  EVIDENCE,
  knowledgeKind("fact"),
  knowledgeKind("relation"),
  SCOPE_DROP,
  ONTOLOGY,
  ITEM,
  INSIGHT,
]);

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
}): DerivativeRegistry {
  const now = () => running?.at ?? new Date().toISOString();
  return createDerivativeRegistry({
    kinds: [
      ...CANONICAL_KINDS,
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
  const run: Run = { report, at, invalidationIds: new Set() };
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
