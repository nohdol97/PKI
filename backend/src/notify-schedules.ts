// The three periods of the notification job (P02-R3, P02-D4, D5): `notify` with target `scan` every 10 minutes,
// `daily` every day at 09:00 and `weekly` on Mondays at 09:10, made at start unless they exist (a period that
// exists is left as the user set it: changed or turned off). The run is the `notify` handler of the runner; it
// reads the DB only and calls no Provider. A closed `extract` or `reflect` job wakes the scan through the period's
// own "run now", so a change is told without waiting for the next slot.
import { NOTIFY_JOB_KIND } from "@pki/storage";
import type { Period } from "./schedule.ts";
import type { Scheduler } from "./scheduler.ts";

/** Provisional: the scan every 10 minutes, the digest after the quiet hours, the report after K02's Sunday re-review. */
export const NOTIFY_SCAN_PERIOD: Period = { kind: "every-10-minutes" };
export const NOTIFY_DAILY_PERIOD: Period = { kind: "daily", at: { hour: 9, minute: 0 } };
export const NOTIFY_WEEKLY_PERIOD: Period = {
  kind: "weekly",
  weekday: 1,
  at: { hour: 9, minute: 10 },
};

/** Makes the three periods that do not exist yet; returns the targets made. */
export function ensureNotifySchedules(scheduler: Pick<Scheduler, "ensureSchedule">): string[] {
  return (
    [
      ["scan", NOTIFY_SCAN_PERIOD],
      ["daily", NOTIFY_DAILY_PERIOD],
      ["weekly", NOTIFY_WEEKLY_PERIOD],
    ] as const
  ).flatMap(([target, period]) =>
    scheduler.ensureSchedule({ kind: NOTIFY_JOB_KIND, target, period }).created ? [target] : [],
  );
}

/** Runs the scan now unless its period is off; true when a job was registered. */
export function wakeNotifyScan(scheduler: Pick<Scheduler, "list" | "runNow">): boolean {
  const scan = scheduler.list().find((s) => s.kind === NOTIFY_JOB_KIND && s.target === "scan");
  return scan?.enabled === true && scheduler.runNow(scan.id).registered;
}
