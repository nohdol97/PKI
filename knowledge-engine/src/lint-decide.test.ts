// KF-C3 (R2): a reported miss names the groups' representatives, so one pair has one fingerprint.
import { insertItem, listFindings, migrate, userDecisions, type SqlDriver } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reportMissed } from "./lint-decide.ts";
import { attrs, NOW } from "./lint.test-support.ts";

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
});
afterEach(() => db.close());

describe("lint.report: a reported miss is stored on representatives (KF-C3)", () => {
  it("maps a member to its group, finds the pair again, and refuses a pair already one group", () => {
    const [a, b, c] = ["가", "나", "다"].map((name) =>
      insertItem(db, { type: "Project", name, ...attrs }),
    ) as [number, number, number];
    const merged = db.transaction(() => userDecisions.entities.merge(db, b, a, NOW));
    expect(merged.status).toBe("applied");

    const first = db.transaction(() =>
      reportMissed(db, { rule: "missing-link", target: { kind: "item", a: b, b: c } }, NOW),
    );
    expect(first.status).toBe("applied");
    if (first.status !== "applied") return;
    expect(first.finding.target).toEqual({ kind: "item", a: Math.min(a, c), b: Math.max(a, c) });

    const again = db.transaction(() =>
      reportMissed(db, { rule: "missing-link", target: { kind: "item", a, b: c } }, NOW),
    );
    expect(again.status).toBe("exists");
    expect(listFindings(db)).toHaveLength(1);

    const same = db.transaction(() =>
      reportMissed(db, { rule: "synonym", target: { kind: "item", a, b } }, NOW),
    );
    expect(same).toEqual({ status: "refused", reason: "bad-target" });
    expect(listFindings(db)).toHaveLength(1);
  });
});
