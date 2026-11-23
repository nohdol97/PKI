// The analytical promotion gate (S03-R13 to R16): the data conditions a check-needing fact must meet before an
// approval or a promotion (`dataChecksUnmet`), and the judgement that takes a `verified` row's standing away
// when a check fails or its table is lost (`lose`, called by the seats below). A check-needing fact is one
// whose kind's `verified` rule names `dataChecks` (the same read as the check lines'), never one named in code.
// The entry (`semantic-user.ts`) hands this module the two ends of a relation and nothing of a type name
// (S01-R4). Reads and the lifecycle's policy entries only: nothing here reads a table's cells, a column name or
// a value, and a history line carries a reason code and a number pair (the source version it rests on).
import { otherValidValues } from "./assertion-links.ts";
import { listCheckLines, waitingRelations, type CheckName } from "./analytical-check-lines.ts";
import type { SourceVersionRef } from "./derivatives.ts";
import type { KnowledgeStatus } from "./knowledge.ts";
import {
  automatedLifecycle,
  readRow,
  type AutoVerifyLoss,
  type EntryRef,
} from "./semantic-lifecycle.ts";
import type { SqlDriver } from "./sql-driver.ts";
import { isValidRow } from "./valid-row.ts";

/** The names a refusal and the sixth condition give: the three set conditions, then a failed check by its name. */
export type DataCheckUnmet = "no-dataset" | "spec-conflict" | "check-missing" | CheckName;
export type DataCheckReason = Extract<AutoVerifyLoss, "data-check-failed" | "data-basis-lost">;

const LIVE = "status NOT IN ('superseded', 'rejected')";
const WAITING_TYPES = ["MEASURED_ON", "JOIN_LEFT", "JOIN_RIGHT"];

const ascending = (ids: Iterable<number>): number[] => [...new Set(ids)].sort((a, b) => a - b);

/** The checks the fact kind's `verified` rule demands; none for a kind with no such rule or no checks. */
function requiredChecks(tx: SqlDriver, kind: string): CheckName[] {
  const text = tx.all(
    "SELECT rule FROM ontology_elements WHERE element_kind = 'fact-kind' AND name = ? AND status = 'verified'",
    [kind],
  )[0]?.rule;
  if (typeof text !== "string") return [];
  return (JSON.parse(text) as { dataChecks?: CheckName[] }).dataChecks ?? [];
}

/** Whether a direct add or a value fix of this fact kind makes a candidate (S03-R14). */
export const needsDataChecks = (tx: SqlDriver, factKind: string): boolean =>
  requiredChecks(tx, factKind).length > 0;

/** Whether any table was ever profiled: until then the judgement reads nothing (dark launch, root 13-5). */
const anyTable = (tx: SqlDriver): boolean =>
  tx.all("SELECT 1 FROM dataset_tables LIMIT 1").length > 0;

const objectsOf = (tx: SqlDriver, itemId: number, type: string): number[] =>
  tx
    .all(
      `SELECT DISTINCT object_id FROM relations WHERE subject_id = ? AND type = ? AND ${LIVE} ORDER BY object_id`,
      [itemId, type],
    )
    .map((r) => r.object_id as number);

/**
 * The Datasets a fact's checks read, by the item's type as the check job reads it: a Dataset is its own,
 * a Join has its left and right objects (both sides are required), any other item its `MEASURED_ON` objects.
 */
function targetsOf(tx: SqlDriver, itemId: number): { targets: number[]; complete: boolean } {
  const type = tx.all("SELECT type FROM items WHERE id = ?", [itemId])[0]?.type;
  if (type === "Dataset") return { targets: [itemId], complete: true };
  if (type === "Join") {
    const left = objectsOf(tx, itemId, "JOIN_LEFT");
    const right = objectsOf(tx, itemId, "JOIN_RIGHT");
    return { targets: [...left, ...right], complete: left.length > 0 && right.length > 0 };
  }
  const on = objectsOf(tx, itemId, "MEASURED_ON");
  return { targets: on, complete: on.length > 0 };
}

/** A Dataset bound to a table of a source that still has a version no tombstone covers. */
const bound = (tx: SqlDriver, datasetId: number): boolean =>
  tx.all(
    `SELECT 1 FROM dataset_tables t WHERE t.item_id = ? AND EXISTS (
       SELECT 1 FROM source_versions v WHERE v.source_id = t.source_id
          AND NOT EXISTS (SELECT 1 FROM tombstones x WHERE x.source_id = v.source_id AND x.covers_version >= v.version))
     LIMIT 1`,
    [datasetId],
  ).length > 0;

function noDataset(tx: SqlDriver, itemId: number): boolean {
  const { targets, complete } = targetsOf(tx, itemId);
  return !complete || targets.some((t) => !bound(tx, t));
}

/** The relation types that name a table of this item: two live objects on one of them leave no table to choose. */
const ambiguousPath = (tx: SqlDriver, itemId: number): boolean =>
  WAITING_TYPES.some((type) => objectsOf(tx, itemId, type).length > 1);

/** A valid fact of the item (optionally of a role) states a different value in its slot. */
function rivalled(tx: SqlDriver, itemId: number, asked?: number, only?: (kind: string) => boolean) {
  if (asked !== undefined && otherValidValues(tx, asked, "item").length > 0) return true;
  return tx
    .all("SELECT id, kind, status FROM facts WHERE item_id = ? ORDER BY id", [itemId])
    .filter((r) => (only ? only(r.kind as string) : true))
    .filter((r) =>
      isValidRow(tx, { kind: "fact", id: r.id as number }, r.status as KnowledgeStatus),
    )
    .some((r) => otherValidValues(tx, r.id as number, "item").length > 0);
}

function specConflict(tx: SqlDriver, factId: number, itemId: number, checks: readonly CheckName[]) {
  if (rivalled(tx, itemId, factId) || ambiguousPath(tx, itemId)) return true;
  if (!checks.includes("aggregation")) return false;
  // the Grain facts of each target Dataset (S03-R14 (c)): two valid grains leave the aggregation no row key
  return targetsOf(tx, itemId).targets.some((dataset) =>
    rivalled(tx, dataset, undefined, (kind) => requiredChecks(tx, kind).includes("grain")),
  );
}

/**
 * The data conditions of S03-R14 a check-needing fact does not meet, in a fixed order: `no-dataset`,
 * `spec-conflict`, `check-missing`, then each failed check by its name in the rule's order. `[]` for a fact whose
 * kind has no `dataChecks`, for an item or a relation, and for a fact that is not stored.
 */
export function dataChecksUnmet(tx: SqlDriver, ref: EntryRef): readonly DataCheckUnmet[] {
  if (ref.kind !== "fact") return [];
  const own = tx.all("SELECT item_id, kind FROM facts WHERE id = ?", [ref.id])[0];
  if (!own) return [];
  const checks = requiredChecks(tx, own.kind as string);
  if (checks.length === 0) return [];
  const itemId = own.item_id as number;
  // a line needs a table: until one was ever profiled nothing of the analytical tables is read (dark launch)
  const stored = new Map(
    (anyTable(tx) ? listCheckLines(tx, ref.id) : []).map((l) => [l.check, l] as const),
  );
  return [
    ...(noDataset(tx, itemId) ? (["no-dataset"] as const) : []),
    ...(specConflict(tx, ref.id, itemId, checks) ? (["spec-conflict"] as const) : []),
    ...(checks.some((c) => !stored.get(c)?.current) ? (["check-missing"] as const) : []),
    ...checks.filter((c) => {
      const line = stored.get(c);
      return line?.current === true && !line.passed;
    }),
  ];
}

// ---- losing the standing (S03-R16) --------------------------------------------------------------------------

/** The relations that wait for a new version's extraction, by the item they hang on. */
function waitingItems(tx: SqlDriver): Map<number, number[]> {
  const waiting = new Map<number, number[]>();
  const ids = waitingRelations(tx).map((w) => w.relationId);
  if (ids.length === 0) return waiting;
  const rows = tx.all(
    `SELECT subject_id, object_id FROM relations
      WHERE id IN (SELECT value FROM json_each(?)) AND type IN ('MEASURED_ON', 'JOIN_LEFT', 'JOIN_RIGHT')`,
    [JSON.stringify(ids)],
  );
  for (const r of rows) {
    const subject = r.subject_id as number;
    waiting.set(subject, [...(waiting.get(subject) ?? []), r.object_id as number]);
  }
  return waiting;
}

/** The `verified` check-needing facts of an item, with their rules' checks. */
const standingFacts = (tx: SqlDriver, itemId: number) =>
  tx
    .all("SELECT id, kind FROM facts WHERE item_id = ? AND status = 'verified' ORDER BY id", [
      itemId,
    ])
    .filter((r) => requiredChecks(tx, r.kind as string).length > 0)
    .map((r) => ({ id: r.id as number, kind: r.kind as string }));

/**
 * One `verified` check-needing fact loses its standing: a row the policy promoted goes back, any other goes to
 * `disputed` (value unchanged, the policy as the actor). Without a basis the row is not moved (the gate demands
 * a source version, and the row shows `no-dataset` in the reads meanwhile).
 */
function lose(
  tx: SqlDriver,
  factId: number,
  reason: DataCheckReason,
  basis: SourceVersionRef | undefined,
  at: string | undefined,
): void {
  if (!basis) return;
  const ref: EntryRef = { kind: "fact", id: factId };
  if (readRow(tx, ref)?.status !== "verified") return;
  const outcome = automatedLifecycle.autoVerifyLost(tx, ref, reason, at, basis);
  if (
    outcome.status === "unchanged" ||
    (outcome.status === "refused" && outcome.reason === "user-override")
  ) {
    automatedLifecycle.raiseDispute(tx, ref, basis, at, reason);
  }
}

const versionRef = (tx: SqlDriver, versionId: number): SourceVersionRef | undefined => {
  const row = tx.all("SELECT source_id, version FROM source_versions WHERE id = ?", [versionId])[0];
  return row ? { sourceId: row.source_id as number, version: row.version as number } : undefined;
};

/** The current version of the lowest table source bound to a Dataset: the basis a cut path names. */
function tableBasis(tx: SqlDriver, datasetId: number): SourceVersionRef | undefined {
  const source = tx.all(
    "SELECT min(source_id) AS source_id FROM dataset_tables WHERE item_id = ?",
    [datasetId],
  )[0]?.source_id;
  if (typeof source !== "number") return undefined;
  const version = tx.all(
    "SELECT max(version) AS version FROM source_versions WHERE source_id = ?",
    [source],
  )[0]?.version;
  return typeof version === "number" ? { sourceId: source, version } : undefined;
}

const itemOf = (tx: SqlDriver, factId: number) =>
  tx.all("SELECT item_id FROM facts WHERE id = ?", [factId])[0]?.item_id as number | undefined;

/**
 * The check job's closing transaction (S03-R16, ids only): a `verified` fact of `facts` with a current failed
 * line of a required check loses its standing on the version that line read; a `verified` fact of `splitMoved`
 * that has no table and is not waiting loses it on the job's own source version (seat ④).
 */
export function judgeCheckJob(
  tx: SqlDriver,
  handOver: {
    source: SourceVersionRef;
    facts: readonly number[];
    splitMoved: readonly number[];
    at: Date;
  },
): void {
  const at = handOver.at.toISOString();
  for (const factId of ascending(handOver.facts)) {
    const row = tx.all("SELECT kind, status FROM facts WHERE id = ?", [factId])[0];
    if (!row || row.status !== "verified") continue;
    const checks = requiredChecks(tx, row.kind as string);
    const failing = listCheckLines(tx, factId).find(
      (l) => checks.includes(l.check) && l.current && !l.passed,
    );
    if (failing) lose(tx, factId, "data-check-failed", versionRef(tx, failing.versionId), at);
  }
  if (handOver.splitMoved.length === 0) return;
  const waiting = waitingItems(tx);
  for (const factId of ascending(handOver.splitMoved)) {
    const itemId = itemOf(tx, factId);
    if (itemId === undefined || waiting.has(itemId) || !noDataset(tx, itemId)) continue;
    lose(tx, factId, "data-basis-lost", handOver.source, at);
  }
}

/**
 * A table source's deletion or a prune took the table from the claims the kind collected before (seats ①, the
 * doc deletion and the prune): a `verified` fact with no table that is not waiting loses it. A waiting row is
 * judged too when a deletion takes a source its own claim rests on (a table deleted while the row waits).
 */
export function judgeClaims(
  tx: SqlDriver,
  claims: readonly { factId: number; basis: readonly SourceVersionRef[] }[],
  change: { sourceId: number; mode: "deletion" | "pruned" },
  at?: string,
): void {
  if (claims.length === 0) return;
  const waiting = waitingItems(tx);
  for (const claim of claims) {
    const itemId = itemOf(tx, claim.factId);
    if (itemId === undefined || !noDataset(tx, itemId)) continue;
    const own = claim.basis.find((b) => b.sourceId === change.sourceId);
    if (waiting.has(itemId) && !(change.mode === "deletion" && own !== undefined)) continue;
    lose(tx, claim.factId, "data-basis-lost", own ?? claim.basis[0], at);
  }
}

/**
 * A user action cut or restored a relation (seat ②); the ends were read before the action, since an undo may
 * delete the row. The facts of the subject that have no table now and are not waiting lose their standing on the
 * current version of the lowest table source bound to the object.
 */
export function judgePathCut(
  tx: SqlDriver,
  ends: { subjectId: number; objectId: number },
  at?: string,
): void {
  if (!anyTable(tx)) return;
  const standing = standingFacts(tx, ends.subjectId);
  if (standing.length === 0 || !noDataset(tx, ends.subjectId)) return;
  if (waitingItems(tx).has(ends.subjectId)) return;
  const basis = tableBasis(tx, ends.objectId);
  for (const fact of standing) lose(tx, fact.id, "data-basis-lost", basis, at);
}

/**
 * An extraction of `sourceId` wrote its result (seat ③): the relations still waiting on that source were not
 * stated again, so the facts of their subjects that still have no table lose their standing, on the current
 * version of the lowest table source bound to the waiting relation's object.
 */
export function judgeWaitingOn(tx: SqlDriver, sourceId: number, at?: string): void {
  if (!anyTable(tx)) return;
  const waits = waitingRelations(tx).filter((w) => w.sourceId === sourceId);
  if (waits.length === 0) return;
  const rows = tx.all(
    `SELECT subject_id, object_id FROM relations
      WHERE id IN (SELECT value FROM json_each(?)) AND type IN ('MEASURED_ON', 'JOIN_LEFT', 'JOIN_RIGHT')
      ORDER BY id`,
    [JSON.stringify(waits.map((w) => w.relationId))],
  );
  const done = new Set<number>();
  for (const r of rows) {
    const subject = r.subject_id as number;
    if (done.has(subject)) continue;
    done.add(subject);
    if (!noDataset(tx, subject)) continue;
    const basis = tableBasis(tx, r.object_id as number);
    for (const fact of standingFacts(tx, subject)) lose(tx, fact.id, "data-basis-lost", basis, at);
  }
}
