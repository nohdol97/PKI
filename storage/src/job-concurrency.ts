// Which queued job a claim takes (I03-R13): the concurrency groups and their
// limits, the overall limit, and the order (priority, then fairness keys in
// turn, then run-at time, then registration). The limits are counted over the
// database's running rows inside the claim's immediate transaction (jobs.ts
// leaseNextJob), so they hold for every runner on the file. A job whose group is
// full is no candidate, so a job of another group behind it is claimed.
import type { SqlDriver, SqlValue } from "./sql-driver.ts";

/** The overall limit until the setting `jobs.maxConcurrent` says otherwise (I03 "기본값"). */
export const DEFAULT_MAX_CONCURRENT = 2;

/** How many jobs of a group run together. `knowledge` stays 1 until entity resolution (S02). */
export const JOB_GROUP_CAPS: Readonly<Record<string, number>> = {
  knowledge: 1,
  projection: 1,
  maintenance: 1,
  "connector-sync": 1,
};

/** The group of each kind; `perTarget` splits it by target (a Connector instance each). */
export const JOB_KIND_GROUPS: Readonly<Record<string, { group: string; perTarget?: true }>> = {
  extract: { group: "knowledge" },
  "projection-remove": { group: "projection" },
  "projection-rebuild": { group: "projection" },
  maintenance: { group: "maintenance" },
  "connector-sync": { group: "connector-sync", perTarget: true },
};

/** Provisional: a kind the table does not name runs one at a time, in a group of its own. */
const UNLISTED_CAP = 1;

/** The concurrency group of a job and how many of it run together. */
export function jobGroup(kind: string, target: string): { name: string; cap: number } {
  const listed = JOB_KIND_GROUPS[kind];
  if (!listed) return { name: `kind:${kind}`, cap: UNLISTED_CAP };
  return {
    name: listed.perTarget ? `${listed.group}:${target}` : listed.group,
    cap: JOB_GROUP_CAPS[listed.group] as number, // every listed group has a limit
  };
}

const quoted = (text: string) => `'${text.replaceAll("'", "''")}'`;

/**
 * jobGroup's name as SQL over a row `j` (kind, target), built from the same
 * table. The claim names running rows by jobGroup and candidates by this, so the
 * two must agree (job-concurrency.test.ts compares them).
 */
export const JOB_GROUP_SQL = `CASE j.kind ${Object.entries(JOB_KIND_GROUPS)
  .map(
    ([kind, { group, perTarget }]) =>
      `WHEN ${quoted(kind)} THEN ${perTarget ? `${quoted(`${group}:`)} || j.target` : quoted(group)}`,
  )
  .join(" ")} ELSE 'kind:' || j.kind END`;

const PRIORITY_SQL = "CASE j.priority WHEN 'user' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END";

export interface PickRequest {
  /** Only jobs of these kinds are candidates; running jobs of every kind are counted. */
  kinds: readonly string[];
  /** UTC milliseconds, read under the claim's write lock. */
  now: number;
  /** A positive whole number; default DEFAULT_MAX_CONCURRENT. */
  maxConcurrent?: number | undefined;
  /** Fairness key to the turn it was last claimed at, larger is later; absent is never. */
  lastClaimed?: ReadonlyMap<string, number> | undefined;
}

/** Refused before the claim's transaction begins: a limit below one would never claim. */
export function assertMaxConcurrent(max: number | undefined): void {
  if (max !== undefined && (!Number.isInteger(max) || max < 1)) {
    throw new RangeError("the overall limit is a positive whole number");
  }
}

/**
 * The ID of the queued job to claim now, inside the caller's immediate
 * transaction, after its reclaim: none while as many jobs run as the overall
 * limit; otherwise the first due job whose group is not full, by priority, then
 * the fairness key claimed longest ago (never first), then run-at time, then ID.
 */
export function pickDueJob(db: SqlDriver, request: PickRequest): number | undefined {
  const running = db.all("SELECT kind, target FROM jobs WHERE status = 'running'");
  if (running.length >= (request.maxConcurrent ?? DEFAULT_MAX_CONCURRENT)) return undefined;
  const groups = new Map<string, { count: number; cap: number }>();
  for (const row of running) {
    const { name, cap } = jobGroup(row.kind as string, row.target as string);
    groups.set(name, { count: (groups.get(name)?.count ?? 0) + 1, cap });
  }
  const full = [...groups].filter(([, g]) => g.count >= g.cap).map(([name]) => name);
  const params: SqlValue[] = [
    JSON.stringify(Object.fromEntries(request.lastClaimed ?? [])),
    ...request.kinds,
    request.now,
    JSON.stringify(full),
  ];
  return db.all(
    `SELECT j.id FROM jobs j LEFT JOIN json_each(?) turn ON turn.key = j.fairness_key
      WHERE j.kind IN (${request.kinds.map(() => "?").join(", ")})
        AND j.status = 'queued' AND j.run_after <= ?
        AND ${JOB_GROUP_SQL} NOT IN (SELECT value FROM json_each(?))
      ORDER BY ${PRIORITY_SQL}, coalesce(turn.value, 0), j.run_after, j.id
      LIMIT 1`,
    params,
  )[0]?.id as number | undefined;
}
