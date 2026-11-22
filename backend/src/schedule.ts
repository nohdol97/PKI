// Slot arithmetic of the scheduler (I03-R18, R20, R22). Pure: every function takes
// the instant (UTC milliseconds) and the IANA time zone it works in, and reads no
// clock. 10-minute and hourly slots are multiples of their length in UTC, so a
// zone offset by half an hour runs hourly slots at local :30. Daily and weekly
// slots are one local time (and weekday) on the local calendar of the zone given:
// a local time that does not exist that day (daylight saving starts) is the first
// valid instant after it, one that occurs twice (it ends) is the earlier one.
// Local dates come from Intl; no date library.

/** A local time of day. */
export interface LocalTime {
  hour: number;
  minute: number;
}

/** 0 is Sunday, as in `Date.prototype.getDay`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type Period =
  | { kind: "every-10-minutes" }
  | { kind: "hourly" }
  | { kind: "daily"; at: LocalTime }
  | { kind: "weekly"; weekday: Weekday; at: LocalTime };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The cap of a job's backoff (I03-R10); a later next run time is a clock that went back. */
export const BACKOFF_MAX_MS = HOUR;

/** The nominal length of a period; days and weeks count 24-hour days. */
export function periodLengthMs(period: Period): number {
  switch (period.kind) {
    case "every-10-minutes":
      return 10 * MINUTE;
    case "hourly":
      return HOUR;
    case "daily":
      return DAY;
    case "weekly":
      return 7 * DAY;
  }
}

/** The latest slot at or before `t`. */
export function slotAtOrBefore(period: Period, t: number, zone: string): number {
  if (!isLocal(period)) return Math.floor(t / periodLengthMs(period)) * periodLengthMs(period);
  return localSlot(period, lastSlotDay(period, t, zone), zone);
}

/** The first slot strictly after `t`. */
export function nextSlotAfter(period: Period, t: number, zone: string): number {
  if (!isLocal(period))
    return (Math.floor(t / periodLengthMs(period)) + 1) * periodLengthMs(period);
  return localSlot(period, lastSlotDay(period, t, zone) + stepDays(period), zone);
}

/** The number of slots `s` with `from <= s <= to`. */
export function countSlots(period: Period, from: number, to: number, zone: string): number {
  if (to < from) return 0;
  if (!isLocal(period)) {
    const length = periodLengthMs(period);
    return Math.floor(to / length) - Math.floor((from - 1) / length);
  }
  return (lastSlotDay(period, to, zone) - lastSlotDay(period, from - 1, zone)) / stepDays(period);
}

export interface DueSlots {
  /** Slots from the next due time to now, both ends included (R20 ①). */
  missed: number;
  /** The latest slot at or before now, the one job that runs for all of them (R20 ③). */
  slot: number | undefined;
  /** The first slot after now (R20 ②); stored whether or not a job is registered. */
  nextDue: number;
}

/**
 * The slots a check at `now` finds for a period whose next due time is `nextDue`;
 * undefined while it is not due. Without a slot in range (a due time off the slot
 * grid) only the next due time moves.
 */
export function dueSlots(
  period: Period,
  nextDue: number,
  now: number,
  zone: string,
): DueSlots | undefined {
  if (now < nextDue) return undefined;
  const missed = countSlots(period, nextDue, now, zone);
  return {
    missed,
    slot: missed > 0 ? slotAtOrBefore(period, now, zone) : undefined,
    nextDue: nextSlotAfter(period, now, zone),
  };
}

export interface NextDueInput {
  period: Period;
  /** The stored next due time. */
  nextDue: number;
  /** The zone stored with the period: the one its daily or weekly slots were computed in. */
  storedZone: string;
  /** The zone now. */
  zone: string;
  /** The slot of the period's last run, if it ran. */
  lastRunSlot?: number;
  now: number;
}

export interface NextDue {
  nextDue: number;
  /** The zone to store with the period. */
  zone: string;
  /** A daily or weekly period moved to the slots of a new zone. */
  rezoned: boolean;
  /** The stored next due time lay more than a period after now and was recomputed. */
  regressed: boolean;
}

/**
 * The next due time to keep before judging whether a period is due (R22; check
 * steps B and C). A next due time more than one period after now means the clock
 * went back: it is recomputed as the first slot at or after now, so the period
 * does not stall until the clock catches up. Otherwise, when the zone of a daily
 * or weekly period changed, it moves to the first slot of the new zone at least
 * half a period after the last run, so one day does not run at 03:00 of both
 * zones. A period that never ran takes one period before its stored next due time
 * as its last run.
 */
export function reconcileNextDue(input: NextDueInput): NextDue {
  const { period, zone, now } = input;
  const length = periodLengthMs(period);
  const rezoned = isLocal(period) && input.zone !== input.storedZone;
  if (input.nextDue > now + length) {
    const nextDue = firstSlotAtOrAfter(period, now, zone);
    return { nextDue, zone, rezoned, regressed: nextDue !== input.nextDue };
  }
  if (!rezoned) return { nextDue: input.nextDue, zone, rezoned, regressed: false };
  const lastRun = input.lastRunSlot ?? input.nextDue - length;
  return {
    nextDue: firstSlotAtOrAfter(period, lastRun + length / 2, zone),
    zone,
    rezoned,
    regressed: false,
  };
}

/** A job's next run time pulled back to now plus the backoff cap when the clock went back (R22). */
export function clampRunAt(runAt: number, now: number, capMs = BACKOFF_MAX_MS): number {
  return Math.min(runAt, now + capMs);
}

function firstSlotAtOrAfter(period: Period, t: number, zone: string): number {
  return nextSlotAfter(period, t - 1, zone);
}

type LocalPeriod = Extract<Period, { at: LocalTime }>;

function isLocal(period: Period): period is LocalPeriod {
  return period.kind === "daily" || period.kind === "weekly";
}

function stepDays(period: LocalPeriod): number {
  return period.kind === "weekly" ? 7 : 1;
}

/** The local day (days since 1970-01-01 on the zone's calendar) of the latest slot at or before `t`. */
function lastSlotDay(period: LocalPeriod, t: number, zone: string): number {
  const step = stepDays(period);
  const today = localDay(t, zone);
  // The latest day of the period's weekday at or before today (1970-01-01 was a Thursday).
  let day =
    period.kind === "weekly"
      ? today - modulo(today + 4 - checkedWeekday(period.weekday), 7)
      : today;
  // A slot lies on its own local day, so it is this day's or a neighbour's.
  day += step;
  while (localSlot(period, day, zone) > t) day -= step;
  return day;
}

/** The instant of a period's local time on a local day. */
function localSlot(period: LocalPeriod, day: number, zone: string): number {
  const { hour, minute } = period.at;
  if (
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    throw new RangeError(`local time out of range: ${hour}:${minute}`);
  }
  return resolveLocal(day * DAY + hour * HOUR + minute * MINUTE, zone);
}

/**
 * The instant whose local wall time in the zone is `wall` (wall-clock milliseconds
 * counted as if UTC): the earlier of two, or the first instant after a gap.
 */
function resolveLocal(wall: number, zone: string): number {
  const before = offsetAt(wall - DAY, zone);
  const after = offsetAt(wall + DAY, zone);
  const matching = [wall - before, wall - after].filter((t) => t + offsetAt(t, zone) === wall);
  if (matching.length > 0) return Math.min(...matching);
  // In a gap the offset grows from `before` to `after` at one instant, the first
  // whose wall time is past `wall`.
  let low = wall - after;
  let high = wall - before;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (middle + offsetAt(middle, zone) > wall) high = middle;
    else low = middle;
  }
  return high;
}

function localDay(t: number, zone: string): number {
  return Math.floor((t + offsetAt(t, zone)) / DAY);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The zone's offset from UTC at `t`, in milliseconds (whole seconds). */
function offsetAt(t: number, zone: string): number {
  let format = formatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(zone, format);
  }
  const second = Math.floor(t / 1000) * 1000;
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(second)) parts[part.type] = Number(part.value);
  const wall = Date.UTC(
    parts.year ?? 0,
    (parts.month ?? 1) - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return wall - second;
}

function checkedWeekday(weekday: number): number {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw new RangeError(`weekday out of range: ${weekday}`);
  }
  return weekday;
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
