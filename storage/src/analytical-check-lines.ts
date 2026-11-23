// The analytical check lines (S03-R11): one line per (target fact, check) with the codes and counts of a
// check and the table version(s) it read, the reach from an item to the table sources behind it (S03-R12),
// the erase of lines when another row a check reads changes, the receiver of a changed membership, and the
// reads that collect the rows a table source's loss or change touches for the judgement (S03-T06). A line
// holds no text: no column name, no cell, no key. The checks themselves are computed in knowledge-engine.
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
  /** Every version it read is its source's latest and no tombstone covers it (S03-R11); else as good as absent. */
  current: boolean;
}

/** A version of `column` is its source's latest and no tombstone covers it. */
const CURRENT = (column: string) => `(${column} IS NULL OR EXISTS (
  SELECT 1 FROM source_versions v
   WHERE v.id = ${column} AND v.id = (SELECT max(id) FROM source_versions WHERE source_id = v.source_id)
     AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.source_id = v.source_id AND t.covers_version >= v.version)))`;

/** The lines of one fact, by check name, each with whether it is current. */
export function listCheckLines(tx: SqlDriver, factId: number): StoredCheckLine[] {
  return tx
    .all(
      `SELECT c.check_name, c.passed, c.failure_code, c.examined, c.violations, c.skipped, c.version_id,
              c.other_version_id, c.checked_at,
              (${CURRENT("c.version_id")} AND ${CURRENT("c.other_version_id")}) AS current
         FROM analytical_checks c WHERE c.fact_id = ? ORDER BY c.check_name`,
      [factId],
    )
    .map((r) => ({
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
