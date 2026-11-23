// The `reflect` job (K02-R2..R5, R8, R9): a bounded re-review of what changed. `daily` (consolidation) looks
// at the merge groups of the dirty items and of work whose target date has passed since the last run;
// `weekly` (refinement) adds the groups of open findings, of disputed rows and of unresolved contradictions,
// taken round by round after a cursor. It reads the DB only, calls no Provider and writes nothing but the
// candidate tables, the findings and the state, in the one transaction the runner commits the result in
// (a `lint-finding` item of commitDerived). The bundles it did not reach, and the items that changed while it
// ran, keep their dirty mark and the next run goes on (K02-D4).
import {
  clearDirty,
  countDirty,
  entityGroups,
  findFinding,
  fingerprintOf,
  insertFinding,
  LINT_FLIP_LIMIT,
  LINT_RULES,
  listDirty,
  listFindings,
  readReflectionState,
  recordReflectionRun,
  recordResultCounts,
  REFLECT_DAILY_CAP,
  REFLECT_WEEKLY_CAP,
  replaceFindingLineage,
  setFindingStatus,
  type DerivedItem,
  type DerivativeRegistry,
  type DirtyMark,
  type LintRule,
  type SqlDriver,
  type StoredFinding,
} from "@pki/storage";
import { derivativeRegistry } from "./canonical-kinds.ts";
import { refreshConflicts } from "./conflicts.ts";
import { refreshCandidates } from "./entity-resolution.ts";
import { recomputeInsights } from "./insight-code-rules.ts";
import { itemsOfFinding, lintFindings, type LintFinding } from "./lint-rules.ts";
import { LINT_FINDING_KIND_NAME } from "./lint-kind.ts";

export type ReflectTarget = "daily" | "weekly";

/** The numbers a run leaves on the job (K02-R4): whole numbers only. */
export type ReflectCounts = Record<string, number>;

const WORK_TYPES = "('Task', 'Commitment')";

/** The items of work whose target date fell between the last run's day (included) and today (excluded). */
function overdueSince(db: SqlDriver, last: string | null, now: string): number[] {
  return db
    .all(
      `SELECT DISTINCT f.item_id FROM facts f JOIN items i ON i.id = f.item_id
        WHERE f.kind = 'target_date' AND i.type IN ${WORK_TYPES} AND f.value >= ? AND f.value < ?
        ORDER BY f.item_id`,
      [last === null ? "" : last.slice(0, 10), now.slice(0, 10)],
    )
    .map((r) => r.item_id as number);
}

/** The items of disputed rows and of facts on either side of a contradiction link. */
function disputedItems(db: SqlDriver): number[] {
  return db
    .all(
      `SELECT item_id AS id FROM facts WHERE status = 'disputed'
       UNION SELECT subject_id FROM relations WHERE status = 'disputed'
       UNION SELECT object_id FROM relations WHERE status = 'disputed'
       UNION SELECT item_id FROM facts WHERE id IN
         (SELECT from_fact_id FROM assertion_links WHERE type = 'CONTRADICTS'
          UNION SELECT to_fact_id FROM assertion_links WHERE type = 'CONTRADICTS')`,
    )
    .map((r) => r.id as number);
}

export interface ReflectPlan {
  items: DerivedItem[];
  /** Filled by the write: what the run did. */
  counts: ReflectCounts;
}

export interface ReflectOptions {
  /** The registry that judges scopes; default the product's. */
  registry?: DerivativeRegistry;
  /** Bundles one run looks at; default the target's cap. */
  cap?: number;
  /** The job the counts are written onto, in the result's transaction. */
  jobId?: number;
}

/**
 * Reads what to look at, then hands back one `lint-finding` item whose write does the run. The marks and the
 * cursor are read here, before anything is judged: a change made after this read keeps its mark.
 */
export function planReflect(
  db: SqlDriver,
  target: ReflectTarget,
  at: string,
  options: ReflectOptions = {},
): ReflectPlan {
  const registry = options.registry ?? derivativeRegistry;
  const cap = options.cap ?? (target === "daily" ? REFLECT_DAILY_CAP : REFLECT_WEEKLY_CAP);
  const state = readReflectionState(db);
  const marks = listDirty(db);
  const repOf = (item: number) => entityGroups.representativeOf(db, item);
  const stored = (item: number) => db.all("SELECT 1 FROM items WHERE id = ?", [item]).length === 1;

  // the groups of the dirty items, the oldest change first, up to the cap; a mark of an item that is gone
  // has nothing to look at and goes with the others read
  const reps = new Set<number>();
  const read: DirtyMark[] = [];
  for (const mark of marks) {
    if (!stored(mark.itemId)) {
      read.push(mark);
      continue;
    }
    const rep = repOf(mark.itemId);
    if (!reps.has(rep) && reps.size >= cap) continue;
    reps.add(rep);
    read.push(mark);
  }
  const lastRun = target === "daily" ? state.lastDailyAt : state.lastWeeklyAt;
  for (const item of overdueSince(db, lastRun, at)) {
    if (reps.size >= cap) break;
    reps.add(repOf(item));
  }
  let cursor: number | undefined;
  if (target === "weekly") {
    const attention = new Set<number>();
    const open = listFindings(db).filter((f) => f.status === "open");
    for (const item of [
      ...open.flatMap((f) => itemsOfFinding(db, f.target) ?? []),
      ...disputedItems(db),
    ]) {
      if (stored(item)) attention.add(repOf(item));
    }
    // round by round: the groups after the cursor first, then the ones before it
    const order = [...attention].sort((a, b) => a - b);
    const queue = [
      ...order.filter((r) => r > state.weeklyCursor),
      ...order.filter((r) => r <= state.weeklyCursor),
    ];
    const picked = queue.slice(0, Math.max(cap - reps.size, 0));
    for (const r of picked) reps.add(r);
    cursor = picked.length === queue.length ? 0 : (picked.at(-1) as number);
  }

  const counts: ReflectCounts = {};
  const item: DerivedItem = {
    kind: LINT_FINDING_KIND_NAME,
    itemKey: `reflect:${target}`,
    lineage: [],
    write: (tx) => {
      const scope = {
        combinable: (lineage: Parameters<typeof registry.combinable>[1]) =>
          registry.combinable(tx, lineage),
      };
      const exists = (id: number) => tx.all("SELECT 1 FROM items WHERE id = ?", [id]).length === 1;
      const groups = [
        ...new Set([...reps].filter(exists).map((r) => entityGroups.representativeOf(tx, r))),
      ].sort((a, b) => a - b);
      const touched = [...new Set(groups.flatMap((g) => entityGroups.membersOf(tx, g)))].sort(
        (a, b) => a - b,
      );
      // R5: the existing calculations again, in extraction's order, over what the run looks at
      recomputeInsights(tx, touched, { scope, at });
      refreshCandidates(tx, touched, scope);
      refreshConflicts(tx, touched, scope, { at });
      const reconciled = reconcile(tx, groups, lintFindings(tx, groups, at), at);
      clearDirty(tx, read);
      recordReflectionRun(tx, { target, at, ...(cursor === undefined ? {} : { cursor }) });
      Object.assign(counts, reconciled, { bundles: groups.length, dirtyLeft: countDirty(tx) });
      if (options.jobId !== undefined) recordResultCounts(tx, options.jobId, counts);
    },
  };
  return { items: [item], counts };
}

const bump = (counts: ReflectCounts, key: string) => void (counts[key] = (counts[key] ?? 0) + 1);
const camel = (rule: LintRule) => rule.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());

/**
 * Compares the findings the rules produced with the stored ones in range and writes the difference (K02-R8,
 * R9): a condition that newly stands opens a finding, one that no longer stands closes an open one, the user's
 * `dismissed` and `oscillating` are left, and a `resolved` or `accepted` one that stands again is opened and
 * counted as a flip, the limit-th flip making it `oscillating`. Returns per-rule counts of new and resolved.
 */
function reconcile(
  tx: SqlDriver,
  groups: readonly number[],
  found: readonly LintFinding[],
  at: string,
): ReflectCounts {
  const counts: ReflectCounts = {};
  for (const rule of LINT_RULES) {
    counts[`${camel(rule)}Opened`] = 0;
    counts[`${camel(rule)}Resolved`] = 0;
  }
  const scope = new Set(groups);
  const inRange = (f: StoredFinding) => {
    const items = itemsOfFinding(tx, f.target);
    return (
      items === undefined || items.some((i) => scope.has(entityGroups.representativeOf(tx, i)))
    );
  };
  const standing = new Set<string>();
  for (const f of found) {
    const fingerprint = fingerprintOf(f.rule, f.target);
    standing.add(fingerprint);
    const stored = findFinding(tx, fingerprint);
    if (!stored) {
      insertFinding(tx, {
        rule: f.rule,
        target: f.target,
        origin: "rule",
        status: "open",
        lineage: f.lineage,
        at,
      });
      bump(counts, `${camel(f.rule)}Opened`);
      continue;
    }
    replaceFindingLineage(tx, stored.id, f.lineage);
    if (stored.status === "resolved" || stored.status === "accepted") {
      const flips = stored.flips + 1;
      setFindingStatus(tx, stored.id, flips >= LINT_FLIP_LIMIT ? "oscillating" : "open", at, flips);
      bump(counts, `${camel(f.rule)}Opened`);
    }
  }
  for (const stored of listFindings(tx)) {
    if (
      stored.status !== "open" ||
      stored.origin !== "rule" ||
      standing.has(stored.fingerprint) ||
      !inRange(stored)
    )
      continue;
    setFindingStatus(tx, stored.id, "resolved", at);
    bump(counts, `${camel(stored.rule)}Resolved`);
  }
  return counts;
}

export interface ReflectHandlerOptions {
  db: SqlDriver;
  now?: () => Date;
  registry?: DerivativeRegistry;
  cap?: number;
}

/** What the handler hands the runner (a subset of backend job-outcomes.ts JobResult). */
export type ReflectResult = { status: "succeeded"; items: readonly DerivedItem[] };

export function createReflectHandler(options: ReflectHandlerOptions) {
  const { db, registry, cap } = options;
  const now = options.now ?? (() => new Date());
  return async (job: { id: number; target: string }): Promise<ReflectResult> => {
    const target = job.target === "weekly" ? "weekly" : "daily";
    const plan = planReflect(db, target, now().toISOString(), {
      jobId: job.id,
      ...(registry ? { registry } : {}),
      ...(cap === undefined ? {} : { cap }),
    });
    return { status: "succeeded", items: plan.items };
  };
}
