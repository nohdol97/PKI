// The Activity screen's job area (I03-R23): what the jobs API reads and the user actions
// it forwards. A job row holds codes, ids and counts, never source or Provider text, and
// this module adds none: a source is shown by its internal id (a title is imported text), a
// reason by its code, a run's counts by whole numbers only. The actions go through the
// entries the runner and the scheduler already have (job-actions.ts, scheduler.ts).
import type { JobsResponse, RouteRequest, RouteResponse, ScheduleSummary } from "@pki/contracts";
import type { BudgetUsage } from "@pki/providers";
import {
  countJobsByStatus,
  countOpenJobs,
  DEFAULT_MAX_ATTEMPTS,
  listRecentJobs,
  projectionActivity,
  type StoredJob,
} from "@pki/storage";
import type { SqlDriver } from "@pki/storage";
import type { JobActions } from "./job-actions.ts";
import { PROJECTION_KIND_SETTINGS, requestProjectionRebuild } from "./projection-jobs.ts";
import {
  OPEN_JOB_CAP,
  OPEN_JOB_WARN_RATIO,
  type Scheduler,
  type ScheduleView,
} from "./scheduler.ts";

/** How many of the newest rows the screen gets (provisional: the screen shows the latest, not a history). */
export const JOBS_LISTED = 100;

/** What the API layer holds of the running backend (boot.ts): the scheduler, the actions, the budget. */
export interface JobsPort {
  scheduler: Pick<
    Scheduler,
    "list" | "get" | "change" | "disable" | "enable" | "runNow" | "backlog"
  >;
  actions: JobActions;
  budgetUsage(): BudgetUsage;
  /** The projections a rebuild may be asked for: the ones the runner has a port for. */
  projectionNames: readonly string[];
  /** Wakes the runner for a job a user action registered or put back in the queue. */
  wake(): void;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The whole-number counts of a result, nothing else: a run's result is not a place for text. */
function resultCounts(json: string | null): Record<string, number> | null {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return null;
    const counts = Object.entries(parsed).filter(
      (entry): entry is [string, number] =>
        /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(entry[0]) &&
        Number.isInteger(entry[1]) &&
        (entry[1] as number) >= 0,
    );
    return Object.fromEntries(counts);
  } catch {
    return null;
  }
}

const jobSummary = (job: StoredJob): JobsResponse["jobs"][number] => ({
  id: job.id,
  kind: job.kind,
  target: job.target,
  sourceId: job.sourceId,
  status: job.status,
  reason: job.reason,
  attempts: job.attempts,
  maxAttempts: PROJECTION_KIND_SETTINGS[job.kind]?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
  priority: job.priority,
  runAfter: iso(job.runAfter),
  finishedAt: job.finishedAt === null ? null : iso(job.finishedAt),
  cancelRequested: job.cancelRequested,
  resultCounts: resultCounts(job.resultCounts),
});

export function scheduleSummary(view: ScheduleView): ScheduleSummary {
  return {
    id: view.id,
    kind: view.kind,
    target: view.target,
    period: view.period,
    zone: view.zone,
    enabled: view.enabled,
    nextDue: iso(view.nextDue),
    lastRunSlot: view.lastRunSlot === null ? null : iso(view.lastRunSlot),
    lastMissed: view.lastMissed,
    counts: view.counts,
    ...(view.pause && { pause: view.pause }),
    ...(view.warning !== undefined && { warning: view.warning }),
  };
}

export function readJobsView(db: SqlDriver, port: JobsPort | undefined): JobsResponse {
  const { jobs, truncated } = listRecentJobs(db, JOBS_LISTED);
  const budget = port?.budgetUsage();
  const open = countOpenJobs(db);
  return {
    counts: countJobsByStatus(db),
    jobs: jobs.map(jobSummary),
    truncated,
    schedules: (port?.scheduler.list() ?? []).map(scheduleSummary),
    projections: projectionActivity(db),
    budget: budget
      ? {
          used: budget.used,
          maxCalls: budget.maxCalls,
          windowMs: budget.windowMs,
          resetsAt: budget.resetsAt === null ? null : iso(budget.resetsAt),
        }
      : null,
    backlog: port?.scheduler.backlog() ?? {
      open,
      cap: OPEN_JOB_CAP,
      warning: open >= OPEN_JOB_CAP * OPEN_JOB_WARN_RATIO,
    },
  };
}

type Answer<Name extends keyof JobActionRoutes> = RouteResponse<Name>;
interface JobActionRoutes {
  cancelJob: unknown;
  retryJob: unknown;
  discardJob: unknown;
  changeSchedule: unknown;
  disableSchedule: unknown;
  enableSchedule: unknown;
  runSchedule: unknown;
  rebuildProjection: unknown;
}

export function jobsApi(db: SqlDriver, port: JobsPort | undefined) {
  const unavailable = { outcome: "unavailable" } as const;
  const scheduleAnswer = (
    id: number,
    act: (scheduler: JobsPort["scheduler"]) => ScheduleView,
  ): Answer<"disableSchedule"> => {
    if (!port) return unavailable;
    if (!port.scheduler.get(id)) return { outcome: "not-found" };
    return { outcome: "done", schedule: scheduleSummary(act(port.scheduler)) };
  };
  return {
    read: (): JobsResponse => readJobsView(db, port),
    cancel: ({ id }: RouteRequest<"cancelJob">): Answer<"cancelJob"> =>
      port ? { outcome: port.actions.cancel(id) } : unavailable,
    retry: ({ id }: RouteRequest<"retryJob">): Answer<"retryJob"> =>
      port ? { outcome: port.actions.retry(id) } : unavailable,
    discard: ({ id }: RouteRequest<"discardJob">): Answer<"discardJob"> =>
      port ? { outcome: port.actions.discard(id) } : unavailable,
    changeSchedule: ({ id, period }: RouteRequest<"changeSchedule">) =>
      scheduleAnswer(id, (scheduler) => scheduler.change(id, period)),
    disableSchedule: ({ id }: RouteRequest<"disableSchedule">) =>
      scheduleAnswer(id, (scheduler) => scheduler.disable(id)),
    enableSchedule: ({ id }: RouteRequest<"enableSchedule">) =>
      scheduleAnswer(id, (scheduler) => scheduler.enable(id)),
    runSchedule: ({ id }: RouteRequest<"runSchedule">): Answer<"runSchedule"> => {
      if (!port) return unavailable;
      if (!port.scheduler.get(id)) return { outcome: "not-found" };
      const { registered, job } = port.scheduler.runNow(id);
      if (registered) port.wake();
      return { outcome: registered ? "started" : "already-open", jobId: job.id };
    },
    rebuildProjection: ({
      projection,
    }: RouteRequest<"rebuildProjection">): Answer<"rebuildProjection"> => {
      if (!port) return unavailable;
      if (!port.projectionNames.includes(projection)) return { outcome: "unknown-projection" };
      const { registered } = requestProjectionRebuild(db, projection);
      if (registered) port.wake();
      return { outcome: registered ? "requested" : "already-open" };
    },
  };
}
