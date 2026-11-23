// The two periods of the re-review (K02-R2, K02-D2, D5): `reflect` with target `daily` and `weekly`, made at start
// unless they exist (a period that exists is left as the user set it: changed or turned off). The run itself is
// the `reflect` handler of the runner; it reads the DB only and calls no Provider.
import { REFLECT_JOB_KIND } from "@pki/storage";
import type { Period } from "./schedule.ts";
import type { Scheduler } from "./scheduler.ts";

/** Provisional: every day at 03:00 and Sundays at 04:00, local time. */
export const REFLECT_DAILY_PERIOD: Period = { kind: "daily", at: { hour: 3, minute: 0 } };
export const REFLECT_WEEKLY_PERIOD: Period = {
  kind: "weekly",
  weekday: 0,
  at: { hour: 4, minute: 0 },
};

/** Makes the two periods that do not exist yet; returns the targets made. */
export function ensureReflectionSchedules(scheduler: Pick<Scheduler, "ensureSchedule">): string[] {
  return (
    [
      ["daily", REFLECT_DAILY_PERIOD],
      ["weekly", REFLECT_WEEKLY_PERIOD],
    ] as const
  ).flatMap(([target, period]) =>
    scheduler.ensureSchedule({ kind: REFLECT_JOB_KIND, target, period }).created ? [target] : [],
  );
}
