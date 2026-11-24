// The analytical check lines (S03-R11): one line per (target fact, check) with the codes and counts of a
// check and the table version(s) it read, the reach from an item to the table sources behind it (S03-R12),
// the erase of lines when another row a check reads changes, the receiver of a changed membership, and the
// reads that collect the rows a table source's loss or change touches for the judgement (S03-T06). A line
// holds no text: no column name, no cell, no key. The checks themselves are computed in knowledge-engine.
import { registerAnalyticalCheckJob } from "./analytical.ts";
import type { SourceVersionRef } from "./derivatives.ts";
import type { MembershipListener } from "./entity-groups.ts";
import type { EntryRef } from "./semantic-lifecycle.ts";
import { keyedRead, preloadReads } from "./read-memo.ts";
import { listSplitMoves } from "./split-moves.ts";
import type { SqlDriver } from "./sql-driver.ts";

export type CheckName = "schema" | "grain" | "join-cardinality" | "aggregation";

/** The relation types that tie a Metric or Join to the Datasets (and Joins) its checks read (S03-R10). */
export const PATH_TYPES = ["MEASURED_ON", "JOIN_LEFT", "JOIN_RIGHT", "USES_JOIN"] as const;

/**
 * A relation that counts for reach (provisional decision D6): not superseded and not rejected. S01's
 * "valid" also asks for current evidence or a user input; that lives in knowledge-engine, and a row that
 * loses its last current evidence is superseded by the propagation, so the two agree but for a row the
 * user's approval protects.
 */
const LIVE = (alias: string) => `${alias}.status NOT IN ('superseded', 'rejected')`;

/**
 * A relation a propagation superseded and no deletion has taken yet (S03-R16 "기다리는 행"): superseded, its
 * last history line is the propagation's supersede, and the basis source of that line is not covered by a
 * tombstone. Read from the history; nothing is stored for it.
 */
const WAITING = (alias: string) => `(${alias}.status = 'superseded' AND EXISTS (
  SELECT 1 FROM relation_history h
   WHERE h.relation_id = ${alias}.id AND h.actor = 'propagation' AND h.action = 'supersede'
     AND h.seq = (SELECT max(seq) FROM relation_history WHERE relation_id = ${alias}.id)
     AND NOT EXISTS (SELECT 1 FROM tombstones t
                      WHERE t.source_id = h.basis_source_id AND t.covers_version >= h.basis_version)))`;

/** Which relations a reach follows: live ones, or live and waiting ones. */
export type Following = "live" | "live-or-waiting";
const usable = (alias: string, following: Following) =>
  following === "live" ? LIVE(alias) : `(${LIVE(alias)} OR ${WAITING(alias)})`;

/**
 * The table sources whose check job re-checks the facts of an item (S03-R12): the bound tables of the Dataset
 * it is, of the Datasets its `MEASURED_ON` / `JOIN_LEFT` / `JOIN_RIGHT` reach, and of the Datasets of the
 * Joins its `USES_JOIN` reach. Two written paths, no recursion. Ascending.
 */
export function tableSourcesOf(
  tx: SqlDriver,
  itemId: number,
  following: Following = "live",
): number[] {
  return tx
    .all(
      `SELECT DISTINCT t.source_id FROM dataset_tables t WHERE t.item_id IN (
         SELECT ?
         UNION SELECT r.object_id FROM relations r
                WHERE r.subject_id = ? AND r.type IN ('MEASURED_ON', 'JOIN_LEFT', 'JOIN_RIGHT')
                  AND ${usable("r", following)}
         UNION SELECT j.object_id FROM relations u JOIN relations j ON j.subject_id = u.object_id
                WHERE u.subject_id = ? AND u.type = 'USES_JOIN' AND j.type IN ('JOIN_LEFT', 'JOIN_RIGHT')
                  AND ${usable("u", following)} AND ${usable("j", following)})
       ORDER BY t.source_id`,
      [itemId, itemId, itemId],
    )
    .map((r) => r.source_id as number);
}

export interface NewCheckLine {
  factId: number;
  check: CheckName;
  passed: boolean;
  failure: string | null;
  examined: number;
  violations: number;
  skipped: number;
  /** The table version read (a Join: the left table's). */
  versionId: number;
  /** The one other table version read, none when there is no other or more than one (decision D7). */
  otherVersionId: number | null;
  at: string;
}

/** Writes the line of the fact's check; a line there already is replaced. Codes and counts only. */
export function saveCheckLine(tx: SqlDriver, line: NewCheckLine): void {
  tx.run(
    `INSERT INTO analytical_checks (fact_id, check_name, passed, failure_code, examined, violations,
       skipped, version_id, other_version_id, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (fact_id, check_name) DO UPDATE SET passed = excluded.passed,
       failure_code = excluded.failure_code, examined = excluded.examined,
       violations = excluded.violations, skipped = excluded.skipped, version_id = excluded.version_id,
       other_version_id = excluded.other_version_id, checked_at = excluded.checked_at`,
    [
      line.factId,
      line.check,
      line.passed ? 1 : 0,
      line.failure,
      line.examined,
      line.violations,
      line.skipped,
      line.versionId,
      line.otherVersionId,
      line.at,
    ],
  );
}

export interface StoredCheckLine extends Omit<NewCheckLine, "factId"> {
  /** The line's row id: the registry names a line `check:<id>`. */
  id: number;
  /** Every version it read is its source's latest and no tombstone covers it (S03-R11); else as good as absent. */
  current: boolean;
}

/** A version of `column` is its source's latest and no tombstone covers it. */
const CURRENT = (column: string) => `(${column} IS NULL OR EXISTS (
  SELECT 1 FROM source_versions v
   WHERE v.id = ${column} AND v.id = (SELECT max(id) FROM source_versions WHERE source_id = v.source_id)
     AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.source_id = v.source_id AND t.covers_version >= v.version)))`;

/** The lines of one fact and its twin over many facts (ARB-R1). */
export const CHECK_LINES_READ = keyedRead({
  columns: `c.id, c.check_name, c.passed, c.failure_code, c.examined, c.violations, c.skipped, c.version_id,
              c.other_version_id, c.checked_at,
              (${CURRENT("c.version_id")} AND ${CURRENT("c.other_version_id")}) AS current`,
  from: "analytical_checks c",
  key: "c.fact_id",
  order: "c.check_name",
});

/** Primes `listCheckLines` for these facts (a no-op unless `tx` is a read memo). */
export const preloadCheckLines = (tx: SqlDriver, factIds: readonly number[]) =>
  preloadReads(tx, CHECK_LINES_READ, factIds);

/** The lines of one fact, by check name, each with whether it is current. */
export function listCheckLines(tx: SqlDriver, factId: number): StoredCheckLine[] {
  return tx.all(CHECK_LINES_READ.one, [factId]).map((r) => ({
    id: r.id as number,
    check: r.check_name as CheckName,
    passed: r.passed === 1,
    failure: r.failure_code as string | null,
    examined: r.examined as number,
    violations: r.violations as number,
    skipped: r.skipped as number,
    versionId: r.version_id as number,
    otherVersionId: r.other_version_id as number | null,
    at: r.checked_at as string,
    current: r.current === 1,
  }));
}

// ---- erasing the lines another row's change makes stale (S03-R11) ------------------------------------------

/** A row of the registry; an item is not an analytical row and is answered as such (no lines, no jobs). */
export type AnalyticalRowRef = EntryRef;

/** Whether any table was ever profiled: until then the analytical hooks read nothing else (dark launch, root 13-5). */
const anyTable = (tx: SqlDriver): boolean =>
  tx.all("SELECT 1 FROM dataset_tables LIMIT 1").length > 0;

type FactRole = "column" | "grain" | "keys" | "cardinality" | "checked" | "other";

/**
 * What a fact kind is to the checks, from the value type and `dataChecks` of its verified rule, not from its
 * name, so a kind the user adds follows: `header` is a column fact, `dataChecks` with `grain` a Grain fact,
 * `key-pairs` a keys fact, `join-cardinality` a cardinality fact, any other kind with `dataChecks` is a
 * check-needing fact nothing else reads, and the rest are not analytical.
 */
function factRole(tx: SqlDriver, kind: string): FactRole {
  const text = tx.all(
    "SELECT rule FROM ontology_elements WHERE element_kind = 'fact-kind' AND name = ? AND status = 'verified'",
    [kind],
  )[0]?.rule;
  if (typeof text !== "string") return "other";
  const rule = JSON.parse(text) as { valueType?: string; dataChecks?: readonly string[] };
  const checks = rule.dataChecks ?? [];
  if (rule.valueType === "header") return "column";
  if (checks.includes("grain")) return "grain";
  if (rule.valueType === "key-pairs") return "keys";
  if (rule.valueType === "join-cardinality") return "cardinality";
  return checks.length > 0 ? "checked" : "other";
}

const quoted = (types: readonly string[]) => types.map((t) => `'${t}'`).join(", ");
const ON_DATASET = ["MEASURED_ON", "JOIN_LEFT", "JOIN_RIGHT"];
/** Items whose facts a check line reads from: SQL with one `?` for the changed item. Relations of any status. */
const SELF = "SELECT ?";
const SUBJECTS_ON = `SELECT subject_id FROM relations WHERE type IN (${quoted(ON_DATASET)}) AND object_id = ?`;
const MEASURING = "SELECT subject_id FROM relations WHERE type = 'MEASURED_ON' AND object_id = ?";
const USING_JOIN = "SELECT subject_id FROM relations WHERE type = 'USES_JOIN' AND object_id = ?";
const USING_JOIN_ON = `SELECT subject_id FROM relations WHERE type = 'USES_JOIN' AND object_id IN
  (SELECT subject_id FROM relations WHERE type IN ('JOIN_LEFT', 'JOIN_RIGHT') AND object_id = ?)`;

interface Reader {
  /** SQL selecting the items whose facts the lines belong to; one `?`, the item the changed row is on. */
  items: string;
  /** Only these checks' lines; every check when absent. */
  checks?: readonly CheckName[];
}

/**
 * Which lines read a fact as another row (S03-R13's table inverted), per its role. A line of the fact itself
 * is never one: approving a target or adding evidence to it keeps its own lines (S03-R11).
 */
const FACT_READERS: Record<FactRole, readonly Reader[]> = {
  column: [
    { items: SELF },
    { items: SUBJECTS_ON },
    { items: USING_JOIN_ON, checks: ["aggregation"] },
  ],
  grain: [{ items: MEASURING, checks: ["aggregation"] }],
  keys: [
    { items: SELF, checks: ["join-cardinality"] },
    { items: USING_JOIN, checks: ["aggregation"] },
  ],
  cardinality: [{ items: USING_JOIN, checks: ["aggregation"] }],
  checked: [],
  other: [],
};

const RELATION_READERS: Record<string, readonly Reader[]> = {
  MEASURED_ON: [{ items: SELF }],
  JOIN_LEFT: [{ items: SELF }, { items: USING_JOIN, checks: ["aggregation"] }],
  JOIN_RIGHT: [{ items: SELF }, { items: USING_JOIN, checks: ["aggregation"] }],
  USES_JOIN: [{ items: SELF, checks: ["aggregation"] }],
};

/** The ids of the check lines of the facts on the readers' items, a line of `except` left out. */
function linesOf(
  tx: SqlDriver,
  readers: readonly Reader[],
  item: number,
  except?: number,
): number[] {
  const ids = new Set<number>();
  for (const reader of readers) {
    const checks = reader.checks ? ` AND c.check_name IN (${quoted(reader.checks)})` : "";
    const rows = tx.all(
      `SELECT c.id FROM analytical_checks c JOIN facts f ON f.id = c.fact_id
        WHERE f.item_id IN (${reader.items})${checks}${except === undefined ? "" : " AND c.fact_id <> ?"}`,
      except === undefined ? [item] : [item, except],
    );
    for (const row of rows) ids.add(row.id as number);
  }
  return [...ids];
}

/** What a row is to the analytical code: where it sits, and which lines read it. Undefined: not an analytical row. */
function readersOf(
  tx: SqlDriver,
  ref: AnalyticalRowRef,
): { item: number; readers: readonly Reader[]; except?: number } | undefined {
  if (ref.kind === "item") return undefined;
  if (ref.kind === "fact") {
    const row = tx.all("SELECT item_id, kind FROM facts WHERE id = ?", [ref.id])[0];
    if (!row) return undefined;
    const role = factRole(tx, row.kind as string);
    if (role === "other") return undefined;
    return { item: row.item_id as number, readers: FACT_READERS[role], except: ref.id };
  }
  const row = tx.all("SELECT subject_id, type FROM relations WHERE id = ?", [ref.id])[0];
  const readers = RELATION_READERS[row?.type as string];
  return row && readers ? { item: row.subject_id as number, readers } : undefined;
}

/** The ids of the lines that read the row as another row; never a line of the row itself. */
export function checkLinesReading(tx: SqlDriver, ref: AnalyticalRowRef): number[] {
  const found = readersOf(tx, ref);
  return found ? linesOf(tx, found.readers, found.item, found.except).sort((a, b) => a - b) : [];
}

const deleteLines = (tx: SqlDriver, ids: readonly number[]) =>
  ids.length > 0 &&
  tx.run("DELETE FROM analytical_checks WHERE id IN (SELECT value FROM json_each(?))", [
    JSON.stringify(ids),
  ]);

/**
 * Deletes the lines that read an analytical row as another row, before the row goes or while it changes; the
 * item whose reach the jobs are queued around is returned, none when the row is not an analytical row or no
 * table was ever profiled.
 */
export function eraseChecksReading(tx: SqlDriver, ref: AnalyticalRowRef): number[] {
  if (ref.kind === "item" || !anyTable(tx)) return [];
  const found = readersOf(tx, ref);
  if (!found) return [];
  deleteLines(tx, linesOf(tx, found.readers, found.item, found.except));
  return [found.item];
}

/** Queues the check job of each table source the items reach (S03-R12). */
export function queueChecksAround(tx: SqlDriver, items: readonly number[], at?: Date): void {
  const sources = new Set<number>();
  for (const item of items) for (const source of tableSourcesOf(tx, item)) sources.add(source);
  for (const source of [...sources].sort((a, b) => a - b)) {
    registerAnalyticalCheckJob(tx, source, at);
  }
}

/** A fact or relation was made, changed state, got evidence or went: erase what read it, queue what reaches it. */
export function analyticalRowChanged(tx: SqlDriver, ref: AnalyticalRowRef, at?: Date): void {
  queueChecksAround(tx, eraseChecksReading(tx, ref), at);
}

/**
 * The receiver of a changed membership (S03-R11, registered in the composition root's fixed list): deletes the
 * lines of the facts of the touched items and of the facts that read them (the Metrics and Joins on a touched
 * Dataset, the Metrics on a touched Join), then queues the jobs of the sources those items reach. It does the
 * same for every notification (merge, unmerge, rest, wake, split: it never branches on the moved rows, whose
 * old and new items are both among `items`), changes no row's state and writes no history line. Every read
 * is total: a missing item or row gives an empty set, so it does not throw inside a deletion's propagation.
 */
export const onMembershipChanged: MembershipListener = (tx, change) => {
  if (change.items.length === 0 || !anyTable(tx)) return;
  const upstream = (ids: readonly number[], types: readonly string[]): number[] =>
    tx
      .all(
        `SELECT DISTINCT subject_id FROM relations WHERE type IN (${quoted(types)})
           AND object_id IN (SELECT value FROM json_each(?))`,
        [JSON.stringify(ids)],
      )
      .map((r) => r.subject_id as number);
  const touched = [...change.items];
  const reading = upstream(touched, [...ON_DATASET, "USES_JOIN"]);
  const closure = [...new Set([...touched, ...reading, ...upstream(reading, ["USES_JOIN"])])];
  deleteLines(
    tx,
    tx
      .all(
        `SELECT c.id FROM analytical_checks c JOIN facts f ON f.id = c.fact_id
          WHERE f.item_id IN (SELECT value FROM json_each(?))`,
        [JSON.stringify(closure)],
      )
      .map((r) => r.id as number),
  );
  queueChecksAround(tx, closure);
};

// ---- collection for the judgement (S03-R12, R16, R17): reads only -----------------------------------------

/**
 * The relations waiting on a new version's extraction (S03-R16 "기다리는 행"), each with the source it waits
 * on (the basis source of the supersede line). Ascending by relation. Read from S01's history.
 */
export function waitingRelations(tx: SqlDriver): { relationId: number; sourceId: number }[] {
  return tx
    .all(
      `SELECT r.id, h.basis_source_id AS source_id FROM relations r
         JOIN relation_history h ON h.relation_id = r.id
          AND h.seq = (SELECT max(seq) FROM relation_history WHERE relation_id = r.id)
        WHERE ${WAITING("r")} AND h.basis_source_id IS NOT NULL ORDER BY r.id`,
    )
    .map((r) => ({ relationId: r.id as number, sourceId: r.source_id as number }));
}

/** Facts whose kind's verified rule demands checks (any status; the judgement filters by state). */
const CHECK_NEEDING = `f.kind IN (SELECT name FROM ontology_elements
  WHERE element_kind = 'fact-kind' AND status = 'verified'
    AND coalesce(json_array_length(json_extract(rule, '$.dataChecks')), 0) > 0)`;

/** Items that stand above a set of items: subjects of path relations to them (live or waiting). */
function reaching(tx: SqlDriver, items: readonly number[], types: readonly string[]): number[] {
  return tx
    .all(
      `SELECT DISTINCT r.subject_id FROM relations r
        WHERE r.type IN (${quoted(types)}) AND ${usable("r", "live-or-waiting")}
          AND r.object_id IN (SELECT value FROM json_each(?))`,
      [JSON.stringify(items)],
    )
    .map((r) => r.subject_id as number);
}

const currentVersion = (tx: SqlDriver, sourceId: number): SourceVersionRef | undefined => {
  const version = tx.all(
    "SELECT max(version) AS version FROM source_versions WHERE source_id = ?",
    [sourceId],
  )[0]?.version;
  return typeof version === "number" ? { sourceId, version } : undefined;
};

/**
 * The check-needing facts a change to a source touches, found by relations and never by check lines (S03-R17),
 * each with its basis: the table sources its item reached (live or waiting relations) and their current
 * versions, ascending by source. A deletion also collects what rests on the source's tables (its Datasets, the
 * Metrics and Joins on them, the Metrics using those Joins) and the rows a split took off them; both
 * a deletion and a prune collect the facts of items whose path relation (live or superseded) has evidence on the
 * source (below the kept version for a prune) and of items whose path relation waits on it. Facts of any status:
 * the judgement (S03-T06) keeps the `verified` ones. Distinct, ascending.
 */
export function claimCandidates(
  tx: SqlDriver,
  change: { sourceId: number; mode: "deletion" | "pruned"; keptVersion?: number },
): { factId: number; basis: SourceVersionRef[] }[] {
  const items = new Set<number>();
  const facts = new Set<number>();
  if (change.mode === "deletion") {
    const datasets = tx
      .all("SELECT item_id FROM dataset_tables WHERE source_id = ?", [change.sourceId])
      .map((r) => r.item_id as number);
    if (datasets.length > 0) {
      const onDatasets = reaching(tx, datasets, ON_DATASET);
      const joins = tx
        .all(
          `SELECT DISTINCT r.subject_id FROM relations r
            WHERE r.type IN ('JOIN_LEFT', 'JOIN_RIGHT') AND ${usable("r", "live-or-waiting")}
              AND r.object_id IN (SELECT value FROM json_each(?))`,
          [JSON.stringify(datasets)],
        )
        .map((r) => r.subject_id as number);
      for (const id of [...datasets, ...onDatasets, ...reaching(tx, joins, ["USES_JOIN"])]) {
        items.add(id);
      }
      for (const id of splitMovedClaims(tx, change.sourceId)) facts.add(id);
    }
  }
  const below = change.mode === "pruned" ? " AND v.version < ?" : "";
  const cited = tx.all(
    `SELECT DISTINCT r.subject_id FROM relations r
      WHERE r.type IN (${quoted([...ON_DATASET, "USES_JOIN"])})
        AND r.status <> 'rejected'
        AND EXISTS (SELECT 1 FROM evidence e JOIN source_versions v ON v.id = e.source_version_id
                     WHERE e.relation_id = r.id AND v.source_id = ?${below})`,
    change.mode === "pruned" ? [change.sourceId, change.keptVersion ?? 0] : [change.sourceId],
  );
  for (const row of cited) items.add(row.subject_id as number);
  const waiting = new Set(
    waitingRelations(tx)
      .filter((w) => w.sourceId === change.sourceId)
      .map((w) => w.relationId),
  );
  if (waiting.size > 0) {
    const rows = tx.all(
      `SELECT subject_id FROM relations
        WHERE type IN (${quoted([...ON_DATASET, "USES_JOIN"])}) AND id IN (SELECT value FROM json_each(?))`,
      [JSON.stringify([...waiting])],
    );
    for (const row of rows) items.add(row.subject_id as number);
  }
  if (items.size > 0) {
    const rows = tx.all(
      `SELECT f.id FROM facts f WHERE f.item_id IN (SELECT value FROM json_each(?)) AND ${CHECK_NEEDING}`,
      [JSON.stringify([...items])],
    );
    for (const row of rows) facts.add(row.id as number);
  }
  return [...facts]
    .sort((a, b) => a - b)
    .map((factId) => {
      const item = tx.all("SELECT item_id FROM facts WHERE id = ?", [factId])[0]?.item_id as number;
      const basis = tableSourcesOf(tx, item, "live-or-waiting").flatMap(
        (source) => currentVersion(tx, source) ?? [],
      );
      return { factId, basis };
    });
}

/**
 * The `verified` check-needing facts of the items a split's record names for a table source (S03-R12): a move
 * of a relation whose object is a Dataset bound to the source (or a Join with a side on one), or of a
 * check-needing fact whose original item reaches the source. The record is read through `listSplitMoves`
 * and starts from the facts, so its size does not grow the cost. The `no-dataset` filter and the exclusion of
 * waiting rows are the judgement's (S03-T06). Ascending.
 */
export function splitMovedClaims(tx: SqlDriver, sourceId: number): number[] {
  const touches = (itemId: number): boolean => {
    const bound = tx.all(
      "SELECT 1 FROM dataset_tables WHERE item_id = ? AND source_id = ? LIMIT 1",
      [itemId, sourceId],
    );
    if (bound.length > 0) return true;
    return (
      tx.all(
        `SELECT 1 FROM relations r JOIN dataset_tables t ON t.item_id = r.object_id
          WHERE r.subject_id = ? AND r.type IN ('JOIN_LEFT', 'JOIN_RIGHT') AND t.source_id = ? LIMIT 1`,
        [itemId, sourceId],
      ).length > 0
    );
  };
  const isChecked = (factId: number): boolean =>
    tx.all(`SELECT 1 FROM facts f WHERE f.id = ? AND ${CHECK_NEEDING}`, [factId]).length > 0;
  const found: number[] = [];
  const candidates = tx.all(
    `SELECT f.id, f.item_id FROM facts f WHERE f.status = 'verified' AND ${CHECK_NEEDING} ORDER BY f.id`,
  );
  for (const row of candidates) {
    const itemId = row.item_id as number;
    const moves = [
      ...listSplitMoves(tx, { fromItemId: itemId }),
      ...listSplitMoves(tx, { toItemId: itemId }),
    ];
    const hit = moves.some((move) => {
      if (move.relationId !== null) {
        const object = tx.all("SELECT object_id FROM relations WHERE id = ?", [move.relationId])[0]
          ?.object_id;
        return typeof object === "number" && touches(object);
      }
      return (
        move.factId !== null &&
        isChecked(move.factId) &&
        tableSourcesOf(tx, move.fromItemId).includes(sourceId)
      );
    });
    if (hit) found.push(row.id as number);
  }
  return found;
}
