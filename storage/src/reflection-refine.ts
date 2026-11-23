// The LLM opinion on a finding (K02-R16, R17). It lives in the finding's own two columns and is stored only by
// `writeFindingOpinion`: while the finding is open and still has the lineage the job was asked at. The finding's
// status, its time and every knowledge row stay as they were. A job's target is `<finding id>#<lineage hash>`:
// ids and a hash, the mark of the attempt, as the Wiki summary's is (K01-D13).
import { createHash } from "node:crypto";
import type { SourceVersionRef } from "./derivatives.ts";
import { REFLECTION_REFINE_KIND } from "./job-kinds.ts";
import { registerJob } from "./jobs.ts";
import { lineageOfFinding } from "./reflection.ts";
import { readSetting, writeSetting } from "./settings.ts";
import type { SqlDriver } from "./sql-driver.ts";

export { REFLECTION_REFINE_KIND } from "./job-kinds.ts";

/** The user's switch for the refinement (K02-R16); anything but `on` is OFF (root 13-5, K02-D1). */
export const REFLECTION_REFINE_SETTING = "reflection.refine";
/** Provisional (K02-R16): refine jobs one request queues. */
export const REFLECTION_REFINE_BATCH = 20;
/** Provisional: the source versions of a finding's lineage one call takes (as the Wiki summary's). */
export const REFLECTION_REFINE_MAX_VERSIONS = 8;

export const readReflectionRefine = (db: SqlDriver): boolean =>
  readSetting(db, REFLECTION_REFINE_SETTING) === "on";

/** A hash of a lineage, whatever its order. */
export const lineageHash = (lineage: readonly SourceVersionRef[]): string =>
  createHash("sha256")
    .update(
      lineage
        .map((v) => `${v.sourceId}@${v.version}`)
        .sort()
        .join(","),
    )
    .digest("hex")
    .slice(0, 16);

/**
 * Queues one `reflection-refine` job per open `synonym` or `missing-link` finding, at most
 * REFLECTION_REFINE_BATCH, and returns how many. A finding is left out when it has an open job already, was
 * asked at its present lineage (any status, or an opinion on it), or has no lineage or more than
 * REFLECTION_REFINE_MAX_VERSIONS versions. `oscillating` and decided findings are not open. Nothing is queued
 * while the setting is off.
 */
export function requestReflectionRefinements(db: SqlDriver, at: Date = new Date()): number {
  if (!readReflectionRefine(db)) return 0;
  return db.transaction(() => {
    const open = db.all(
      `SELECT id, opinion_lineage_hash FROM lint_findings
        WHERE status = 'open' AND rule IN ('synonym', 'missing-link')
          AND NOT EXISTS (SELECT 1 FROM jobs j
                           WHERE j.kind = ? AND j.status IN ('queued', 'running', 'retry', 'held')
                             AND substr(j.target, 1, length(lint_findings.id) + 1) = lint_findings.id || '#')
        ORDER BY id`,
      [REFLECTION_REFINE_KIND],
    );
    let queued = 0;
    for (const row of open) {
      if (queued >= REFLECTION_REFINE_BATCH) break;
      const id = row.id as number;
      const lineage = lineageOfFinding(db, id);
      if (lineage.length === 0 || lineage.length > REFLECTION_REFINE_MAX_VERSIONS) continue;
      const hash = lineageHash(lineage);
      if (row.opinion_lineage_hash === hash) continue;
      const target = `${id}#${hash}`;
      if (
        db.all("SELECT 1 FROM jobs WHERE kind = ? AND target = ?", [REFLECTION_REFINE_KIND, target])
          .length > 0
      )
        continue;
      const registered = registerJob(db, {
        kind: REFLECTION_REFINE_KIND,
        target,
        priority: "maintenance",
        at,
      });
      if (registered.registered) queued++;
    }
    return queued;
  });
}

/** Stores the switch. Nothing is queued here: the jobs follow a `weekly` re-review (K02-R16). */
export const setReflectionRefine = (db: SqlDriver, on: boolean): void =>
  writeSetting(db, REFLECTION_REFINE_SETTING, on ? "on" : "off");

/**
 * Writes the opinion (a JSON text of ids and positions) while the finding is open and its lineage is still the
 * one the job was asked at. True when written. The finding's status and time are not touched.
 */
export function writeFindingOpinion(
  tx: SqlDriver,
  id: number,
  hash: string,
  opinion: string,
): boolean {
  if (lineageHash(lineageOfFinding(tx, id)) !== hash) return false;
  return (
    tx.run(
      `UPDATE lint_findings SET opinion = ?, opinion_lineage_hash = ? WHERE id = ? AND status = 'open'`,
      [opinion, hash, id],
    ).changes === 1
  );
}
