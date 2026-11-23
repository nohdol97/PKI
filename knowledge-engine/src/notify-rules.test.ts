// P02-C2a (R2): `decideNotification` gives each of the table's four rows as one case, and is a pure function.
import { describe, expect, it } from "vitest";
import { decideNotification, type NotifySignal } from "./notify-rules.ts";

const NOW = new Date("2026-11-23T09:00:00.000Z");
const HOUR = 3_600_000;
/** A dependency delay due in two days, verified: ranks well above the threshold. */
const urgent: NotifySignal = {
  insightId: 1,
  type: "dependency_delay",
  confidence: 100,
  urgencyDate: "2026-11-25",
  changedAt: NOW.toISOString(),
  userInputCount: 0,
};
const before = (hours: number) => new Date(NOW.getTime() - hours * HOUR).toISOString();

describe("notify.rules: decideNotification (P02-C2a)", () => {
  it("① an excluded confidence goes to the digest whatever its rank", () => {
    expect(decideNotification({ ...urgent, confidence: 30 }, [], NOW)).toEqual({
      status: "digest",
      reason: "low-confidence",
    });
  });

  it("② a rank below the threshold goes to the digest", () => {
    expect(decideNotification({ ...urgent, urgencyDate: null, confidence: 60 }, [], NOW)).toEqual({
      status: "digest",
      reason: "below-threshold",
    });
  });

  it("③ the same Insight told immediately within 24 hours goes to the digest; 25 hours ago does not count", () => {
    const told = (hours: number) => [{ insightId: 1, immediate: true, at: before(hours) }];
    expect(decideNotification(urgent, told(20), NOW)).toEqual({
      status: "digest",
      reason: "repeat",
    });
    expect(decideNotification(urgent, told(25), NOW)).toEqual({ status: "sent" });
    // a line that only went to the digest, or another Insight's, is no repeat
    expect(
      decideNotification(urgent, [{ insightId: 1, immediate: false, at: before(1) }], NOW),
    ).toEqual({ status: "sent" });
    expect(
      decideNotification(urgent, [{ insightId: 2, immediate: true, at: before(1) }], NOW),
    ).toEqual({ status: "sent" });
  });

  it("a hidden Insight is withdrawn and a muted one goes to the digest, before every other row (P03 hand-over)", () => {
    expect(
      decideNotification({ ...urgent, preference: { hidden: true, muted: true } }, [], NOW),
    ).toEqual({ status: "withdrawn" });
    expect(
      decideNotification({ ...urgent, preference: { hidden: false, muted: true } }, [], NOW),
    ).toEqual({ status: "digest", reason: "muted" });
  });

  it("④ anything else is sent", () => {
    expect(decideNotification(urgent, [], NOW)).toEqual({ status: "sent" });
  });
});
