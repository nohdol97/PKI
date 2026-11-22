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
// by the same rule (I04-R8). The two projection kinds (projection-kinds.ts) follow them in the
// product registry; they register the removal jobs after the canonical purge.
//
// The entries, applyTombstone and propagateNewVersion, keep their results (the ids
// each kind touched and the rule's outcomes); the kinds note those for the entry
// that runs the registry, by its transaction, beside the counts the record keeps.
import {
  createDerivativeRegistry,
  listEvidence,
  setKnowledgeStatus,
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
 * The change kinds the canonical kinds propagate. `old-versions-pruned` has no
 * producer before I04-T12, which defines it; refusing it keeps it from passing
 * as zero counts.
 */
function supported(change: SourceChange): "new-version" | "scope-changed" | "deletion" {
  if (change.kind === "old-versions-pruned") {
    throw new Error("old-versions-pruned is propagated from I04-T12");
  }
  if (change.kind === "new-version" || change.kind === "scope-changed") return change.kind;
  return "deletion";
}

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
  fact: (db, id) => versionsOf(db, EVIDENCE_VERSIONS("e.fact_id = ?"), [id]),
  relation: (db, id) => versionsOf(db, EVIDENCE_VERSIONS("e.relation_id = ?"), [id]),
  item: (db, id) =>
    versionsOf(
      db,
      EVIDENCE_VERSIONS(
        `e.fact_id IN (SELECT id FROM facts WHERE item_id = ?)
         OR e.relation_id IN (SELECT id FROM relations WHERE subject_id = ? OR object_id = ?)`,
      ),
      [id, id, id],
    ),
  insight: (db, id) =>
    versionsOf(
      db,
      EVIDENCE_VERSIONS("e.id IN (SELECT evidence_id FROM insight_evidence WHERE insight_id = ?)"),
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
  affected: (tx, change) =>
    supported(change) !== "deletion"
      ? [] // a new version or a scope change keeps every version (I04-R10, R15)
      : collect(tx, "source", "SELECT id FROM source_versions WHERE source_id = ? ORDER BY id", [
          change.sourceId,
        ]),
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
  affected: (tx, change) =>
    supported(change) !== "deletion"
      ? [] // evidence is immutable; on an earlier version it becomes past evidence by itself
      : collect(
          tx,
          "evidence",
          `SELECT e.id FROM evidence e JOIN source_versions v ON v.id = e.source_version_id
           WHERE v.source_id = ? ORDER BY e.id`,
          [change.sourceId],
        ),
  // the version delete cascaded it; whatever a schema without the cascade kept goes here
  invalidate: (ctx, snapshot) => {
    noting(ctx);
    const { tx } = ctx;
    for (const { ref } of snapshot) tx.run("DELETE FROM evidence WHERE id = ?", [Number(ref.id)]);
    return { removed: gone(tx, "evidence", snapshot).length, recomputed: 0 };
  },
};

/**
 * A fact or relation the source's evidence cites, judged again (V02-R11, I04-R8):
 * left without any evidence it is deleted, whatever its status and epistemic type
 * (a user-approved value came from the deleted source); left with no current
 * evidence it becomes superseded (rejected and superseded rows stay). Its
 * epistemic type never changes. After a new version nothing loses its evidence.
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
    invalidate: (ctx, snapshot) => {
      const { tx } = ctx;
      const deleted: number[] = [];
      const superseded: number[] = [];
      for (const { ref } of snapshot) {
        const id = Number(ref.id);
        const status = tx.all(`SELECT status FROM ${table} WHERE id = ?`, [id])[0]?.status;
        if (status === undefined) continue;
        const evidence = listEvidence(tx, target(id));
        if (evidence.length === 0) {
          tx.run(`DELETE FROM ${table} WHERE id = ?`, [id]);
          deleted.push(id);
        } else if (
          status !== "superseded" &&
          status !== "rejected" &&
          !evidence.some((e) => e.current)
        ) {
          setKnowledgeStatus(tx, kind, id, "superseded");
          superseded.push(id);
        }
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

/** An item a cited row holds: deleted once no fact or relation is left on it (its Insights cascade). */
const ITEM: DerivativeKind = {
  ...base("item", "item"),
  affected: (tx, change) => {
    if (supported(change) === "scope-changed") return [];
    const id = change.sourceId;
    return collect(tx, "item", `SELECT id FROM (${CITED_ITEMS}) ORDER BY id`, [id, id, id]);
  },
  invalidate: (ctx, snapshot) => {
    const { tx } = ctx;
    const deleted: number[] = [];
    for (const { ref } of snapshot) {
      const id = Number(ref.id);
      if (!stored(tx, "items", id)) continue;
      const held = tx.all(
        `SELECT 1 FROM facts WHERE item_id = ?
         UNION ALL SELECT 1 FROM relations WHERE subject_id = ? OR object_id = ? LIMIT 1`,
        [id, id, id],
      );
      if (held.length > 0) continue;
      tx.run("DELETE FROM items WHERE id = ?", [id]);
      deleted.push(id);
    }
    noting(ctx)?.items.push(...deleted);
    return { removed: deleted.length, recomputed: 0 };
  },
};

/**
 * An Insight on a collected item: gone with its item (cascade), or judged again
 * by the rule over the collected items that are left, in the same transaction, so
 * an explanation built from the deleted source is rebuilt without it (I04-R5, R8).
 * A scope change (I04-R15) deletes nothing: the Insights whose lineage holds the
 * source are judged again over their own items (the rule's outcome is the same
 * until I04-T09 adds `combinable`, which resolves or revives them).
 * Counted as recomputed when the rule changed its row.
 */
const INSIGHT: DerivativeKind = {
  ...base("insight", "insight"),
  affected: (tx, change) => {
    const id = change.sourceId;
    if (supported(change) === "scope-changed") {
      return collect(
        tx,
        "insight",
        `SELECT DISTINCT ie.insight_id AS id FROM insight_evidence ie
           JOIN evidence e ON e.id = ie.evidence_id
           JOIN source_versions v ON v.id = e.source_version_id
         WHERE v.source_id = ? ORDER BY id`,
        [id],
      );
    }
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
    const outcomes = recomputeDependencyDelay(tx, remaining);
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

/** The canonical kinds in their registration order (the registry orders them by layer). */
export const CANONICAL_KINDS: readonly DerivativeKind[] = Object.freeze([
  SOURCE,
  EVIDENCE,
  knowledgeKind("fact"),
  knowledgeKind("relation"),
  ITEM,
  INSIGHT,
]);

/**
 * No scope policy yet: its default arrives with I04-T09. Every judgement throws, so a registry that
 * holds it fails every `visible` call closed; the backend's product registry runs the interim policy
 * (backend interim-policy.ts) until T09. Propagation does not consult it.
 */
export const NO_POLICY_YET: ScopePolicy = {
  compare: () => {
    throw new Error("the scope policy arrives with I04-T09");
  },
  strictest: () => {
    throw new Error("the scope policy arrives with I04-T09");
  },
  combinable: () => {
    throw new Error("the scope policy arrives with I04-T09");
  },
  allows: () => {
    throw new Error("the scope policy arrives with I04-T09");
  },
};

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
 * entries.ts take a registry): the same kinds, with no mark and the placeholder policy.
 */
export const derivativeRegistry = createProductRegistry({ policy: NO_POLICY_YET });

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
