// Reflection and knowledge lint's tables (K02): the dirty marks the triggers write when a row the lint reads
// changes, the one-row state of the re-review, and the findings (a rule's name and the ids of the rows it
// bears on, never a name, value or quote) with their lineage. A finding is a candidate: it is written only by
// the `reflect` job's result and by the user's decision, and deleted by the registered kind `lint-finding`
// in a deletion's own transaction. Its scope is never stored; the lineage says it.
import type { SourceVersionRef } from "./derivatives.ts";
import type { SqlDriver } from "./sql-driver.ts";

/** Provisional (K02-D5): bundles (merge groups) one run looks at. */
export const REFLECT_DAILY_CAP = 200;
export const REFLECT_WEEKLY_CAP = 1000;
/** Provisional (K02-D8): reopenings after which a finding stops moving without the user. */
export const LINT_FLIP_LIMIT = 3;

export const LINT_RULES = ["synonym", "stale", "overdue-work", "missing-link"] as const;
export type LintRule = (typeof LINT_RULES)[number];
export const FINDING_STATUSES = [
  "open",
  "accepted",
  "dismissed",
  "resolved",
  "oscillating",
] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export interface FindingTarget {
  kind: "item" | "fact" | "relation";
  a: number;
  /** The second item of `synonym` and `missing-link`; null for the others. */
  b: number | null;
}

/** The unique key of a finding: the rule and its target ids. */
export const fingerprintOf = (rule: LintRule, t: FindingTarget): string =>
  `${rule}:${t.kind}:${t.a}${t.b === null ? "" : `:${t.b}`}`;

export interface StoredFinding {
  id: number;
  rule: LintRule;
  fingerprint: string;
  target: FindingTarget;
  origin: "rule" | "user";
  status: FindingStatus;
  flips: number;
  opinion: string | null;
  opinionLineageHash: string | null;
  createdAt: string;
  updatedAt: string;
}

const findingOf = (r: Record<string, unknown>): StoredFinding => ({
  id: r.id as number,
  rule: r.rule as LintRule,
  fingerprint: r.fingerprint as string,
  target: {
    kind: r.target_kind as FindingTarget["kind"],
    a: r.target_a as number,
    b: r.target_b as number | null,
  },
  origin: r.origin as StoredFinding["origin"],
  status: r.status as FindingStatus,
  flips: r.flips as number,
  opinion: r.opinion as string | null,
  opinionLineageHash: r.opinion_lineage_hash as string | null,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

export const listFindings = (db: SqlDriver): StoredFinding[] =>
  db.all("SELECT * FROM lint_findings ORDER BY id").map(findingOf);

export function readFinding(db: SqlDriver, id: number): StoredFinding | undefined {
  const row = db.all("SELECT * FROM lint_findings WHERE id = ?", [id])[0];
  return row ? findingOf(row) : undefined;
}

export function findFinding(db: SqlDriver, fingerprint: string): StoredFinding | undefined {
  const row = db.all("SELECT * FROM lint_findings WHERE fingerprint = ?", [fingerprint])[0];
  return row ? findingOf(row) : undefined;
}

export const lineageOfFinding = (db: SqlDriver, id: number): SourceVersionRef[] =>
  db
    .all(
      "SELECT source_id, version FROM lint_finding_lineage WHERE finding_id = ? ORDER BY source_id, version",
      [id],
    )
    .map((r) => ({ sourceId: r.source_id as number, version: r.version as number }));

/** Writes the lineage rows of a finding; true when they differ from what was stored. */
export function replaceFindingLineage(
  tx: SqlDriver,
  id: number,
  lineage: readonly SourceVersionRef[],
): boolean {
  const key = (v: SourceVersionRef) => `${v.sourceId}@${v.version}`;
  const before = new Set(lineageOfFinding(tx, id).map(key));
  const after = new Set(lineage.map(key));
  if (before.size === after.size && [...before].every((k) => after.has(k))) return false;
  tx.run("DELETE FROM lint_finding_lineage WHERE finding_id = ?", [id]);
  for (const v of lineage) {
    tx.run(
      "INSERT OR IGNORE INTO lint_finding_lineage (finding_id, source_id, version) VALUES (?, ?, ?)",
      [id, v.sourceId, v.version],
    );
  }
  return true;
}

export function insertFinding(
  tx: SqlDriver,
  input: {
    rule: LintRule;
    target: FindingTarget;
    origin: "rule" | "user";
    status: FindingStatus;
    flips?: number;
    lineage: readonly SourceVersionRef[];
    at: string;
  },
): number {
  const { rule, target, at } = input;
  const id = tx.run(
    `INSERT INTO lint_findings
       (rule, fingerprint, target_kind, target_a, target_b, origin, status, flips, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      rule,
      fingerprintOf(rule, target),
      target.kind,
      target.a,
      target.b,
      input.origin,
      input.status,
      input.flips ?? 0,
      at,
      at,
    ],
  ).lastInsertRowid;
  replaceFindingLineage(tx, id, input.lineage);
  return id;
}

export function setFindingStatus(
  tx: SqlDriver,
  id: number,
  status: FindingStatus,
  at: string,
  flips?: number,
): void {
  tx.run(
    `UPDATE lint_findings SET status = ?, updated_at = ?, flips = coalesce(?, flips) WHERE id = ?`,
    [status, at, flips ?? null, id],
  );
}

/** Deletes a finding with its lineage rows (the foreign key's cascade). */
export const removeFinding = (tx: SqlDriver, id: number): boolean =>
  tx.run("DELETE FROM lint_findings WHERE id = ?", [id]).changes === 1;

/** The findings whose lineage holds a version of `sourceId` (below `below` when given), ascending. */
export const findingIdsOfSource = (db: SqlDriver, sourceId: number, below?: number): number[] =>
  db
    .all(
      `SELECT DISTINCT finding_id FROM lint_finding_lineage
        WHERE source_id = ? ${below === undefined ? "" : "AND version < ?"} ORDER BY finding_id`,
      below === undefined ? [sourceId] : [sourceId, below],
    )
    .map((r) => r.finding_id as number);

// ---- dirty and state --------------------------------------------------------------------------------

export interface ReflectionState {
  dirtySeq: number;
  lastDailyAt: string | null;
  lastWeeklyAt: string | null;
  weeklyCursor: number;
}

export function readReflectionState(db: SqlDriver): ReflectionState {
  const r = db.all("SELECT * FROM reflection_state WHERE id = 1")[0] as Record<string, unknown>;
  return {
    dirtySeq: r.dirty_seq as number,
    lastDailyAt: r.last_daily_at as string | null,
    lastWeeklyAt: r.last_weekly_at as string | null,
    weeklyCursor: r.weekly_cursor as number,
  };
}

/** Records a finished run, in the result's transaction. A cursor of undefined leaves the weekly cursor. */
export function recordReflectionRun(
  tx: SqlDriver,
  run: { target: "daily" | "weekly"; at: string; cursor?: number },
): void {
  tx.run(
    run.target === "daily"
      ? "UPDATE reflection_state SET last_daily_at = ? WHERE id = 1"
      : "UPDATE reflection_state SET last_weekly_at = ?, weekly_cursor = coalesce(?, weekly_cursor) WHERE id = 1",
    run.target === "daily" ? [run.at] : [run.at, run.cursor ?? null],
  );
}

export interface DirtyMark {
  itemId: number;
  seq: number;
}

/** The items marked since the last re-review of them, oldest change first. */
export const listDirty = (db: SqlDriver): DirtyMark[] =>
  db
    .all("SELECT item_id, seq FROM reflection_dirty ORDER BY seq, item_id")
    .map((r) => ({ itemId: r.item_id as number, seq: r.seq as number }));

export const countDirty = (db: SqlDriver): number =>
  db.all("SELECT count(*) AS n FROM reflection_dirty")[0]?.n as number;

/** Deletes the marks that were read, each only while it is still the one that was read (a later change keeps it). */
export function clearDirty(tx: SqlDriver, read: readonly DirtyMark[]): void {
  for (const m of read) {
    tx.run("DELETE FROM reflection_dirty WHERE item_id = ? AND seq <= ?", [m.itemId, m.seq]);
  }
}
