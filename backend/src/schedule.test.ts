// I03-C2 unit proofs of the slot arithmetic (I03-R18, R20, R22): slots of the
// four periods, missed-slot counting, daylight saving time, a time-zone change and
// the clock-regression corrections. Every time is a fixed UTC instant and every
// zone an explicit IANA name; nothing reads the machine's clock or zone.
import { describe, expect, it } from "vitest";
import {
  BACKOFF_MAX_MS,
  clampRunAt,
  countSlots,
  dueSlots,
  nextSlotAfter,
  reconcileNextDue,
  slotAtOrBefore,
  type Period,
} from "./schedule.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (iso: string) => Date.parse(iso);

const tenMinutes: Period = { kind: "every-10-minutes" };
const hourly: Period = { kind: "hourly" };
const daily = (hour: number, minute = 0): Period => ({ kind: "daily", at: { hour, minute } });

/** The local wall time of an instant in a zone, as "YYYY-MM-DD HH:MM". */
function wall(t: number, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(t);
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

describe("schedule.slots", () => {
  const t = at("2026-01-15T12:34:56Z"); // a Thursday

  it("aligns 10-minute slots to multiples of ten minutes in UTC", () => {
    expect(nextSlotAfter(tenMinutes, t, "Asia/Seoul")).toBe(at("2026-01-15T12:40:00Z"));
    expect(slotAtOrBefore(tenMinutes, t, "Asia/Seoul")).toBe(at("2026-01-15T12:30:00Z"));
    // A slot instant itself is at-or-before, and the next slot is strictly after it.
    const slot = at("2026-01-15T12:40:00Z");
    expect(slotAtOrBefore(tenMinutes, slot, "UTC")).toBe(slot);
    expect(nextSlotAfter(tenMinutes, slot, "UTC")).toBe(slot + 10 * MIN);
  });

  it("aligns hourly slots to UTC hours, so a +05:30 zone runs them at local :30", () => {
    const next = nextSlotAfter(hourly, t, "Asia/Kolkata");
    expect(next).toBe(at("2026-01-15T13:00:00Z"));
    expect(wall(next, "Asia/Kolkata")).toBe("2026-01-15 18:30");
    expect(slotAtOrBefore(hourly, t, "Asia/Kolkata")).toBe(at("2026-01-15T12:00:00Z"));
  });

  it("places a daily slot at one local time of the zone", () => {
    // 09:00 KST on the 15th: today's 03:00 has passed, tomorrow's is next.
    const morning = at("2026-01-15T00:00:00Z");
    expect(nextSlotAfter(daily(3), morning, "Asia/Seoul")).toBe(at("2026-01-15T18:00:00Z"));
    expect(slotAtOrBefore(daily(3), morning, "Asia/Seoul")).toBe(at("2026-01-14T18:00:00Z"));
    expect(nextSlotAfter(daily(3), morning, "Europe/London")).toBe(at("2026-01-15T03:00:00Z"));
  });

  it("places a weekly slot on one local weekday at one local time", () => {
    const monday0930: Period = { kind: "weekly", weekday: 1, at: { hour: 9, minute: 30 } };
    expect(nextSlotAfter(monday0930, t, "Europe/London")).toBe(at("2026-01-19T09:30:00Z"));
    expect(slotAtOrBefore(monday0930, t, "Europe/London")).toBe(at("2026-01-12T09:30:00Z"));
    // Monday 09:30 KST is Monday 00:30 UTC.
    expect(nextSlotAfter(monday0930, t, "Asia/Seoul")).toBe(at("2026-01-19T00:30:00Z"));
    const sunday: Period = { kind: "weekly", weekday: 0, at: { hour: 23, minute: 0 } };
    expect(wall(nextSlotAfter(sunday, t, "Asia/Seoul"), "Asia/Seoul")).toBe("2026-01-18 23:00");
  });

  it("counts the slots s with d <= s <= t, both ends included", () => {
    const d = at("2026-01-15T12:40:00Z");
    expect(countSlots(tenMinutes, d, d, "UTC")).toBe(1);
    expect(countSlots(tenMinutes, d, d + 60 * MIN, "UTC")).toBe(7);
    expect(countSlots(tenMinutes, d, d + 60 * MIN - 1, "UTC")).toBe(6);
    expect(countSlots(tenMinutes, d + 1, d + 10 * MIN - 1, "UTC")).toBe(0);
    expect(countSlots(tenMinutes, d, d - 1, "UTC")).toBe(0);
    expect(countSlots(hourly, at("2026-01-15T13:00:00Z"), at("2026-01-15T15:00:00Z"), "UTC")).toBe(
      3,
    );
    const first = at("2026-01-14T18:00:00Z"); // 03:00 KST on the 15th
    expect(countSlots(daily(3), first, first + 6 * DAY, "Asia/Seoul")).toBe(7);
    const weekly: Period = { kind: "weekly", weekday: 1, at: { hour: 9, minute: 30 } };
    const monday = at("2026-01-19T09:30:00Z");
    expect(countSlots(weekly, monday, monday + 21 * DAY, "Europe/London")).toBe(4);
  });

  it("coalesces the slots missed since the next due time into the latest one (R20)", () => {
    const t0 = at("2026-01-15T12:00:00Z");
    expect(dueSlots(tenMinutes, t0 + 10 * MIN, t0 + 8 * HOUR, "UTC")).toEqual({
      missed: 48,
      slot: t0 + 8 * HOUR,
      nextDue: t0 + 8 * HOUR + 10 * MIN,
    });
    const weekly: Period = { kind: "weekly", weekday: 1, at: { hour: 9, minute: 30 } };
    const monday = at("2026-01-19T09:30:00Z");
    expect(dueSlots(weekly, monday, monday + 21 * DAY + HOUR, "Europe/London")).toEqual({
      missed: 4,
      slot: monday + 21 * DAY,
      nextDue: monday + 28 * DAY,
    });
  });

  it("is not due before the next due time", () => {
    const d = at("2026-01-15T12:40:00Z");
    expect(dueSlots(tenMinutes, d, d - 1, "UTC")).toBeUndefined();
    expect(dueSlots(tenMinutes, d, d, "UTC")).toEqual({
      missed: 1,
      slot: d,
      nextDue: d + 10 * MIN,
    });
  });

  it("moves the next due time without a slot when none fell in the range", () => {
    // A due time off the grid (a period just changed) with no slot up to now.
    const d = at("2026-01-15T12:41:00Z");
    expect(dueSlots(tenMinutes, d, d + MIN, "UTC")).toEqual({
      missed: 0,
      slot: undefined,
      nextDue: at("2026-01-15T12:50:00Z"),
    });
  });

  it("rejects a local time or weekday out of range", () => {
    expect(() => nextSlotAfter(daily(24), 0, "UTC")).toThrow(RangeError);
    expect(() => nextSlotAfter(daily(3, 60), 0, "UTC")).toThrow(RangeError);
    expect(() => nextSlotAfter(daily(2.5), 0, "UTC")).toThrow(RangeError);
    const bad = { kind: "weekly", weekday: 7, at: { hour: 0, minute: 0 } } as unknown as Period;
    expect(() => nextSlotAfter(bad, 0, "UTC")).toThrow(RangeError);
  });

  it("rejects an unknown time zone", () => {
    expect(() => nextSlotAfter(daily(3), 0, "Mars/Olympus_Mons")).toThrow(RangeError);
  });
});

describe("schedule.dst", () => {
  const ny = "America/New_York";

  it("runs a local time that does not exist at the first valid time after it", () => {
    // 2026-03-08 02:00 EST jumps to 03:00 EDT: 02:30 does not exist that day.
    const slot = nextSlotAfter(daily(2, 30), at("2026-03-08T05:00:00Z"), ny);
    expect(slot).toBe(at("2026-03-08T07:00:00Z"));
    expect(wall(slot, ny)).toBe("2026-03-08 03:00");
    // The days around it keep 02:30.
    expect(nextSlotAfter(daily(2, 30), at("2026-03-07T00:00:00Z"), ny)).toBe(
      at("2026-03-07T07:30:00Z"),
    );
    expect(nextSlotAfter(daily(2, 30), slot, ny)).toBe(at("2026-03-09T06:30:00Z"));
    // London skips 01:00-02:00 on 2026-03-29.
    expect(nextSlotAfter(daily(1, 30), at("2026-03-28T12:00:00Z"), "Europe/London")).toBe(
      at("2026-03-29T01:00:00Z"),
    );
  });

  it("runs a local time that occurs twice once, at the earlier one", () => {
    // 2026-11-01 02:00 EDT falls back to 01:00 EST: 01:30 occurs at 05:30Z and 06:30Z.
    const before = at("2026-11-01T04:00:00Z");
    expect(nextSlotAfter(daily(1, 30), before, ny)).toBe(at("2026-11-01T05:30:00Z"));
    expect(nextSlotAfter(daily(1, 30), at("2026-11-01T05:30:00Z"), ny)).toBe(
      at("2026-11-02T06:30:00Z"),
    );
    expect(slotAtOrBefore(daily(1, 30), at("2026-11-01T06:30:00Z"), ny)).toBe(
      at("2026-11-01T05:30:00Z"),
    );
    expect(
      countSlots(daily(1, 30), at("2026-10-31T00:00:00Z"), at("2026-11-02T12:00:00Z"), ny),
    ).toBe(3);
  });

  it("keeps weekly slots on their local time across a change", () => {
    const sunday0230: Period = { kind: "weekly", weekday: 0, at: { hour: 2, minute: 30 } };
    expect(nextSlotAfter(sunday0230, at("2026-03-02T00:00:00Z"), ny)).toBe(
      at("2026-03-08T07:00:00Z"),
    );
    expect(nextSlotAfter(sunday0230, at("2026-03-08T07:00:00Z"), ny)).toBe(
      at("2026-03-15T06:30:00Z"),
    );
  });

  it("keeps daily slots in Asia/Seoul exactly 24 hours apart all year", () => {
    let slot = slotAtOrBefore(daily(3), at("2026-01-01T00:00:00Z"), "Asia/Seoul");
    for (let i = 0; i < 400; i++) {
      const next = nextSlotAfter(daily(3), slot, "Asia/Seoul");
      expect(next - slot).toBe(DAY);
      slot = next;
    }
  });
});

describe("schedule.tz-change", () => {
  const ranInSeoul = at("2026-01-14T18:00:00Z"); // 03:00 KST on the 15th

  it("does not run a daily 03:00 again at London 03:00 the same day after Seoul 03:00", () => {
    const result = reconcileNextDue({
      period: daily(3),
      nextDue: at("2026-01-15T18:00:00Z"),
      storedZone: "Asia/Seoul",
      zone: "Europe/London",
      lastRunSlot: ranInSeoul,
      now: ranInSeoul + 5 * MIN,
    });
    // London 03:00 on the 15th (03:00Z) is only 9 hours after the Seoul run.
    expect(result).toEqual({
      nextDue: at("2026-01-16T03:00:00Z"),
      zone: "Europe/London",
      rezoned: true,
      regressed: false,
    });
  });

  it("does not skip a day when the new zone's slot is at least half a period later", () => {
    const ranInLondon = at("2026-01-15T03:00:00Z");
    const result = reconcileNextDue({
      period: daily(3),
      nextDue: at("2026-01-16T03:00:00Z"),
      storedZone: "Europe/London",
      zone: "Asia/Seoul",
      lastRunSlot: ranInLondon,
      now: ranInLondon + HOUR,
    });
    // Seoul 03:00 on the 16th is 18:00Z on the 15th, 15 hours after the London run.
    expect(result.nextDue).toBe(at("2026-01-15T18:00:00Z"));
    expect(result.rezoned).toBe(true);
  });

  it("takes the new zone's slot nearest the stored next due time when it never ran", () => {
    const result = reconcileNextDue({
      period: daily(3),
      nextDue: at("2026-01-15T18:00:00Z"), // Seoul 03:00 on the 16th
      storedZone: "Asia/Seoul",
      zone: "Europe/London",
      now: at("2026-01-15T10:00:00Z"),
    });
    expect(result.nextDue).toBe(at("2026-01-16T03:00:00Z"));
  });

  it("keeps the rezoned next due time on the checks that follow (Seoul to London)", () => {
    const first = reconcileNextDue({
      period: daily(3),
      nextDue: at("2026-01-15T18:00:00Z"),
      storedZone: "Asia/Seoul",
      zone: "Europe/London",
      lastRunSlot: ranInSeoul,
      now: ranInSeoul + 5 * MIN,
    });
    // More than a period after now, yet legitimate: not a clock that went back.
    const second = reconcileNextDue({
      period: daily(3),
      nextDue: first.nextDue,
      storedZone: first.zone,
      zone: "Europe/London",
      lastRunSlot: ranInSeoul,
      now: ranInSeoul + 5 * MIN + 30_000,
    });
    expect(second).toEqual({
      nextDue: at("2026-01-16T03:00:00Z"),
      zone: "Europe/London",
      rezoned: false,
      regressed: false,
    });
  });

  it("applies the half-period rule on the eve of a 25-hour day (London to New York)", () => {
    // 03:00 BST on 2026-10-24; London falls back on the 25th, so its next 03:00 is 25 h later.
    const ranInLondon = at("2026-10-24T02:00:00Z");
    const first = reconcileNextDue({
      period: daily(3),
      nextDue: at("2026-10-25T03:00:00Z"),
      storedZone: "Europe/London",
      zone: "America/New_York",
      lastRunSlot: ranInLondon,
      now: ranInLondon + 10 * MIN,
    });
    // New York 03:00 on the 24th (07:00Z) is only 5 hours after the London run.
    expect(first).toEqual({
      nextDue: at("2026-10-25T07:00:00Z"),
      zone: "America/New_York",
      rezoned: true,
      regressed: false,
    });
    const second = reconcileNextDue({
      period: daily(3),
      nextDue: first.nextDue,
      storedZone: first.zone,
      zone: "America/New_York",
      lastRunSlot: ranInLondon,
      now: ranInLondon + 10 * MIN + 30_000,
    });
    expect(second.nextDue).toBe(at("2026-10-25T07:00:00Z"));
    expect(second.regressed).toBe(false);
  });

  it("anchors on the last run when it is less than a period before the next due time", () => {
    // New York's 23-hour day: ran 03:00 EST on 2026-03-07 (08:00Z), next 03:00 EDT is 23 h later.
    // Shanghai 03:00 on the 8th (19:00Z on the 7th) is 11 hours after the run: too soon.
    const ran = at("2026-03-07T08:00:00Z");
    const result = reconcileNextDue({
      period: daily(3),
      nextDue: at("2026-03-08T07:00:00Z"),
      storedZone: "America/New_York",
      zone: "Asia/Shanghai",
      lastRunSlot: ran,
      now: ran + 10 * MIN,
    });
    expect(result.nextDue).toBe(at("2026-03-08T19:00:00Z"));
  });

  it("caps the rezoned next due time at the first slot after now when nothing ran", () => {
    // Half a period before Seoul's 03:00 is past London's next 03:00, an hour away.
    const result = reconcileNextDue({
      period: daily(3),
      nextDue: at("2026-01-15T18:00:00Z"),
      storedZone: "Asia/Seoul",
      zone: "Europe/London",
      now: at("2026-01-15T02:00:00Z"),
    });
    expect(result).toEqual({
      nextDue: at("2026-01-15T03:00:00Z"),
      zone: "Europe/London",
      rezoned: true,
      regressed: false,
    });
  });

  it("does not move the next due time back to slots already counted after an old last run", () => {
    // A held period: the last run is days old while the next due time moved on.
    const result = reconcileNextDue({
      period: daily(3),
      nextDue: at("2026-01-15T18:00:00Z"),
      storedZone: "Asia/Seoul",
      zone: "Europe/London",
      lastRunSlot: at("2026-01-10T18:00:00Z"),
      now: at("2026-01-15T10:00:00Z"),
    });
    expect(result.nextDue).toBe(at("2026-01-16T03:00:00Z"));
    expect(result.regressed).toBe(false);
  });

  it("runs each slot once and reports no regression over two and a half periods of 30-second checks", () => {
    const cases = [
      {
        // Seoul to London 5 minutes after the Seoul run (the C2 scenario).
        nextDue: at("2026-01-15T18:00:00Z"),
        storedZone: "Asia/Seoul",
        zone: "Europe/London",
        lastRunSlot: ranInSeoul,
        start: ranInSeoul + 5 * MIN,
        runs: ["2026-01-16T03:00:00.000Z", "2026-01-17T03:00:00.000Z"],
      },
      {
        // London to Seoul an hour after the London run.
        nextDue: at("2026-01-16T03:00:00Z"),
        storedZone: "Europe/London",
        zone: "Asia/Seoul",
        lastRunSlot: at("2026-01-15T03:00:00Z"),
        start: at("2026-01-15T04:00:00Z"),
        runs: ["2026-01-15T18:00:00.000Z", "2026-01-16T18:00:00.000Z"],
      },
      {
        // London to New York before London's 25-hour day.
        nextDue: at("2026-10-25T03:00:00Z"),
        storedZone: "Europe/London",
        zone: "America/New_York",
        lastRunSlot: at("2026-10-24T02:00:00Z"),
        start: at("2026-10-24T02:10:00Z"),
        runs: ["2026-10-25T07:00:00.000Z", "2026-10-26T07:00:00.000Z"],
      },
      {
        // New York to Shanghai on New York's 23-hour day.
        nextDue: at("2026-03-08T07:00:00Z"),
        storedZone: "America/New_York",
        zone: "Asia/Shanghai",
        lastRunSlot: at("2026-03-07T08:00:00Z"),
        start: at("2026-03-07T08:10:00Z"),
        runs: ["2026-03-08T19:00:00.000Z", "2026-03-09T19:00:00.000Z"],
      },
      {
        // Never ran: Seoul to London.
        nextDue: at("2026-01-15T18:00:00Z"),
        storedZone: "Asia/Seoul",
        zone: "Europe/London",
        lastRunSlot: undefined,
        start: at("2026-01-15T10:00:00Z"),
        runs: ["2026-01-16T03:00:00.000Z", "2026-01-17T03:00:00.000Z"],
      },
      {
        // Never ran, an hour before London 03:00: capped at the first slot after now.
        nextDue: at("2026-01-15T18:00:00Z"),
        storedZone: "Asia/Seoul",
        zone: "Europe/London",
        lastRunSlot: undefined,
        start: at("2026-01-15T02:00:00Z"),
        runs: ["2026-01-15T03:00:00.000Z", "2026-01-16T03:00:00.000Z", "2026-01-17T03:00:00.000Z"],
      },
    ];
    for (const c of cases) {
      const period = daily(3);
      let { nextDue, storedZone, lastRunSlot } = c;
      const runs: string[] = [];
      for (let now = c.start; now < c.start + 2.5 * DAY; now += 30_000) {
        const reconciled = reconcileNextDue({
          period,
          nextDue,
          storedZone,
          zone: c.zone,
          ...(lastRunSlot === undefined ? {} : { lastRunSlot }),
          now,
        });
        expect(reconciled.regressed, new Date(now).toISOString()).toBe(false);
        ({ nextDue, zone: storedZone } = reconciled);
        const due = dueSlots(period, nextDue, now, c.zone);
        if (!due) continue;
        nextDue = due.nextDue;
        if (due.slot === undefined) continue;
        expect(due.missed).toBe(1);
        runs.push(new Date(due.slot).toISOString());
        lastRunSlot = due.slot;
      }
      expect(runs).toEqual(c.runs);
    }
  }, 60_000);

  it("leaves the next due time of an unchanged zone alone", () => {
    const nextDue = at("2026-01-15T18:00:00Z");
    expect(
      reconcileNextDue({
        period: daily(3),
        nextDue,
        storedZone: "Asia/Seoul",
        zone: "Asia/Seoul",
        lastRunSlot: ranInSeoul,
        now: ranInSeoul + MIN,
      }),
    ).toEqual({ nextDue, zone: "Asia/Seoul", rezoned: false, regressed: false });
  });

  it("only records the new zone for UTC-aligned periods", () => {
    const nextDue = at("2026-01-15T13:00:00Z");
    expect(
      reconcileNextDue({
        period: hourly,
        nextDue,
        storedZone: "Asia/Seoul",
        zone: "Asia/Kolkata",
        lastRunSlot: nextDue - HOUR,
        now: nextDue - 30 * MIN,
      }),
    ).toEqual({ nextDue, zone: "Asia/Kolkata", rezoned: false, regressed: false });
  });
});

describe("clock.regression", () => {
  const now = at("2026-01-15T12:34:56Z");

  it("recomputes a next due time more than one period after now from now", () => {
    // The clock went back a day: the stored next due time is a day ahead.
    const hourlyResult = reconcileNextDue({
      period: hourly,
      nextDue: at("2026-01-16T13:00:00Z"),
      storedZone: "UTC",
      zone: "UTC",
      now,
    });
    expect(hourlyResult).toEqual({
      nextDue: at("2026-01-15T13:00:00Z"),
      zone: "UTC",
      rezoned: false,
      regressed: true,
    });
    const dailyResult = reconcileNextDue({
      period: daily(3),
      nextDue: at("2026-01-18T18:00:00Z"),
      storedZone: "Asia/Seoul",
      zone: "Asia/Seoul",
      now,
    });
    expect(dailyResult.nextDue).toBe(at("2026-01-15T18:00:00Z"));
    expect(dailyResult.regressed).toBe(true);
  });

  it("keeps the first slot after now", () => {
    const nextDue = at("2026-01-15T13:00:00Z");
    const result = reconcileNextDue({
      period: hourly,
      nextDue,
      storedZone: "UTC",
      zone: "UTC",
      now,
    });
    expect(result).toEqual({ nextDue, zone: "UTC", rezoned: false, regressed: false });
  });

  it("recomputes when the clock went back past the last run, even by less than a period", () => {
    const ran = at("2026-01-15T13:00:00Z");
    const result = reconcileNextDue({
      period: hourly,
      nextDue: ran + HOUR,
      storedZone: "UTC",
      zone: "UTC",
      lastRunSlot: ran,
      now: ran - 10_000,
    });
    // The slot that already ran is due again; the (period, slot) key counts it as already run.
    expect(result).toEqual({ nextDue: ran, zone: "UTC", rezoned: false, regressed: true });
  });

  it("recomputes to a slot equal to now, which is then due", () => {
    const slot = at("2026-01-15T13:00:00Z");
    const result = reconcileNextDue({
      period: hourly,
      nextDue: slot + 5 * HOUR,
      storedZone: "UTC",
      zone: "UTC",
      now: slot,
    });
    expect(result.nextDue).toBe(slot);
  });

  it("does not report a regression for a 25-hour day before daylight saving ends", () => {
    // Ran at 03:00 EDT on 2026-10-31; 03:00 EST on 11-01 is 25 hours later.
    const ran = at("2026-10-31T07:00:00Z");
    const nextDue = at("2026-11-01T08:00:00Z");
    const result = reconcileNextDue({
      period: daily(3),
      nextDue,
      storedZone: "America/New_York",
      zone: "America/New_York",
      lastRunSlot: ran,
      now: ran + 30_000,
    });
    expect(result).toEqual({ nextDue, zone: "America/New_York", rezoned: false, regressed: false });
  });

  it("recomputes after a zone change whose last run lies in the future", () => {
    // The clock went back two days and the zone changed: the zone rule's result is
    // still more than a period ahead, so the regression rule takes over.
    const result = reconcileNextDue({
      period: daily(3),
      nextDue: at("2026-01-17T18:00:00Z"),
      storedZone: "Asia/Seoul",
      zone: "Europe/London",
      lastRunSlot: at("2026-01-16T18:00:00Z"),
      now,
    });
    expect(result).toEqual({
      nextDue: at("2026-01-16T03:00:00Z"),
      zone: "Europe/London",
      rezoned: true,
      regressed: true,
    });
  });

  it("pulls a job's next run time later than now plus the backoff cap back to it", () => {
    expect(BACKOFF_MAX_MS).toBe(HOUR);
    expect(clampRunAt(now + 3 * DAY, now)).toBe(now + HOUR);
    expect(clampRunAt(now + HOUR + 1, now)).toBe(now + HOUR);
    expect(clampRunAt(now + HOUR, now)).toBe(now + HOUR);
    expect(clampRunAt(now - DAY, now)).toBe(now - DAY);
  });
});
