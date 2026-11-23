// S01-T05: the gate's two policy entries for the automatic promotion (S01-R9, R5, R12). The conditions
// are knowledge-engine's (`auto-verify.test.ts`); what is held here is what the gate refuses whoever
// calls it: an item, a row that is not a candidate, the user's rows (ahead of the same-state shortcut)
// and, for the restore, a row the policy did not verify.
import { setStatusForTest, memoryDbTemplate } from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { insertItem, saveFact, type KnowledgeStatus } from "./knowledge.ts";
import { migrate } from "./migrations.ts";
import { automatedLifecycle, type EntryRef } from "./semantic-lifecycle.ts";
import { userDecisions } from "./semantic-user.ts";
import type { SqlDriver } from "./sql-driver.ts";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);

let db: SqlDriver;
beforeEach(() => {
  db = freshDb();
});
afterEach(() => db.close());

const T = "2026-11-23T00:00:00.000Z";
let n = 0;
function fact(status: KnowledgeStatus = "candidate"): EntryRef {
  n++;
  const attributes = {
    epistemic: "explicit",
    status,
    validAt: null,
    observedAt: T,
  } as const;
  const item = insertItem(db, { type: "Project", name: `P${n}`, ...attributes });
  const id = saveFact(db, {
    itemId: item,
    kind: "target_date",
    value: "2026-12-01",
    ...attributes,
  }).id;
  return { kind: "fact", id };
}
const lines = (ref: EntryRef) =>
  db.all(
    "SELECT seq, actor, action, from_status, to_status, reason, reverts_seq FROM fact_history WHERE fact_id = ? ORDER BY seq",
    [ref.id],
  );
const status = (ref: EntryRef) =>
  db.all("SELECT status FROM facts WHERE id = ?", [ref.id])[0]?.status;

describe("automatedLifecycle.autoVerify", () => {
  it("moves a candidate to verified by the policy and nothing else", () => {
    const ref = fact();
    automatedLifecycle.created(db, ref, "extraction", null, T);
    expect(automatedLifecycle.autoVerify(db, ref, T)).toEqual({ status: "applied", seq: 2 });
    expect(lines(ref)[1]).toEqual({
      seq: 2,
      actor: "policy",
      action: "auto-verify",
      from_status: "candidate",
      to_status: "verified",
      reason: null,
      reverts_seq: null,
    });
  });

  it("an item is not promoted", () => {
    const item = insertItem(db, {
      type: "Project",
      name: "I",
      epistemic: "explicit",
      status: "candidate",
      validAt: null,
      observedAt: T,
    });
    const ref: EntryRef = { kind: "item", id: item };
    automatedLifecycle.created(db, ref, "extraction", null, T);
    expect(automatedLifecycle.autoVerify(db, ref, T)).toEqual({
      status: "refused",
      reason: "invalid-transition",
    });
    expect(db.all("SELECT status FROM items WHERE id = ?", [item])[0]?.status).toBe("candidate");
  });

  it.each(["disputed", "superseded", "rejected"] as const)(
    "a %s row is not promoted (only a candidate is)",
    (from) => {
      const ref = fact();
      setStatusForTest(db, "fact", ref.id, from, "extraction");
      expect(automatedLifecycle.autoVerify(db, ref, T)).toEqual({
        status: "refused",
        reason: "invalid-transition",
      });
      expect(status(ref)).toBe(from);
    },
  );

  it("a row that is already verified is unchanged, but one the user decided is user-override first", () => {
    const decided = fact();
    userDecisions.decide(db, decided, "approve", T);
    expect(automatedLifecycle.autoVerify(db, decided, T)).toEqual({
      status: "refused",
      reason: "user-override",
    });
    const policyless = fact("verified");
    expect(automatedLifecycle.autoVerify(db, policyless, T)).toEqual({ status: "unchanged" });
  });

  it("a row the user wrote is user-override", () => {
    const item = insertItem(db, {
      type: "Project",
      name: "W",
      epistemic: "explicit",
      status: "candidate",
      validAt: null,
      observedAt: T,
    });
    const added = userDecisions.add(db, {
      kind: "fact",
      itemId: item,
      factKind: "target_date",
      value: "2026-12-02",
    }) as { ref: EntryRef };
    expect(automatedLifecycle.autoVerify(db, added.ref, T)).toEqual({
      status: "refused",
      reason: "user-override",
    });
  });

  it("a bare UPDATE of the status is still refused by the schema's gate (the policy has no side door)", () => {
    const ref = fact();
    automatedLifecycle.created(db, ref, "extraction", null, T);
    expect(() => db.run("UPDATE facts SET status = 'verified' WHERE id = ?", [ref.id])).toThrow();
  });
});

describe("automatedLifecycle.autoVerifyLost", () => {
  it("restores the state before the promotion and names the line it reverts", () => {
    const ref = fact();
    automatedLifecycle.created(db, ref, "extraction", null, T);
    automatedLifecycle.autoVerify(db, ref, T);
    expect(automatedLifecycle.autoVerifyLost(db, ref, "conflicting-value", T)).toEqual({
      status: "applied",
      seq: 3,
    });
    expect(status(ref)).toBe("candidate");
    expect(lines(ref)[2]).toEqual({
      seq: 3,
      actor: "policy",
      action: "auto-verify-reverted",
      from_status: "verified",
      to_status: "candidate",
      reason: "conflicting-value",
      reverts_seq: 2,
    });
  });

  it("a verified row the policy did not verify is unchanged", () => {
    const ref = fact("verified");
    expect(automatedLifecycle.autoVerifyLost(db, ref, "independent-sources", T)).toEqual({
      status: "unchanged",
    });
    setStatusForTest(db, "fact", ref.id, "candidate", "extraction");
    expect(automatedLifecycle.autoVerifyLost(db, ref, "independent-sources", T)).toEqual({
      status: "unchanged",
    });
  });

  it("a row the user decided is user-override, with no line", () => {
    const ref = fact();
    automatedLifecycle.created(db, ref, "extraction", null, T);
    automatedLifecycle.autoVerify(db, ref, T);
    userDecisions.decide(db, ref, "dispute", T);
    const before = lines(ref);
    expect(automatedLifecycle.autoVerifyLost(db, ref, "independent-sources", T)).toEqual({
      status: "refused",
      reason: "user-override",
    });
    expect(lines(ref)).toEqual(before);
  });

  it("an item has nothing to lose", () => {
    const item = insertItem(db, {
      type: "Project",
      name: "I2",
      epistemic: "explicit",
      status: "verified",
      validAt: null,
      observedAt: T,
    });
    expect(
      automatedLifecycle.autoVerifyLost(db, { kind: "item", id: item }, "independent-sources", T),
    ).toEqual({ status: "refused", reason: "invalid-transition" });
  });

  it("a row that is not stored is not-found", () => {
    expect(
      automatedLifecycle.autoVerifyLost(db, { kind: "fact", id: 404 }, "independent-sources", T),
    ).toEqual({ status: "refused", reason: "not-found" });
  });
});

describe("the user approving a row the policy verified (S01-T02 hand-off 8, T05 decision 5)", () => {
  it("is an action: user-approved, a standing user line, the policy's restore no longer reaches it", () => {
    const ref = fact();
    automatedLifecycle.created(db, ref, "extraction", null, T);
    automatedLifecycle.autoVerify(db, ref, T);
    expect(userDecisions.decide(db, ref, "approve", T)).toEqual({ status: "applied", seq: 3 });
    expect(db.all("SELECT epistemic, status FROM facts WHERE id = ?", [ref.id])[0]).toEqual({
      epistemic: "user-approved",
      status: "verified",
    });
    expect(userDecisions.decide(db, ref, "approve", T)).toEqual({ status: "unchanged" });
  });

  it("a user reject of a policy-verified row follows the table: verified has no reject, nothing is written", () => {
    const ref = fact();
    automatedLifecycle.created(db, ref, "extraction", null, T);
    automatedLifecycle.autoVerify(db, ref, T);
    const before = lines(ref);
    expect(userDecisions.decide(db, ref, "reject", T)).toEqual({
      status: "refused",
      reason: "invalid-transition",
    });
    expect(lines(ref)).toEqual(before);
    expect(status(ref)).toBe("verified");
  });

  it("a user dispute of a policy-verified row is a dispute line, never an approve line", () => {
    const ref = fact();
    automatedLifecycle.created(db, ref, "extraction", null, T);
    automatedLifecycle.autoVerify(db, ref, T);
    expect(userDecisions.decide(db, ref, "dispute", T)).toMatchObject({ status: "applied" });
    expect(lines(ref).at(-1)).toMatchObject({
      actor: "user",
      action: "dispute",
      from_status: "verified",
      to_status: "disputed",
    });
  });

  it("the policy itself cannot use the approval exception on a row it verified: unchanged, no line", () => {
    const ref = fact();
    automatedLifecycle.created(db, ref, "extraction", null, T);
    automatedLifecycle.autoVerify(db, ref, T);
    const before = lines(ref);
    expect(automatedLifecycle.autoVerify(db, ref, T)).toEqual({ status: "unchanged" });
    expect(lines(ref)).toEqual(before);
    expect(db.all("SELECT epistemic FROM facts WHERE id = ?", [ref.id])[0]?.epistemic).toBe(
      "explicit",
    );
  });

  it("a state-neutral line after the promotion does not hide it: the user's approval is still the exception", () => {
    const ref = fact();
    automatedLifecycle.created(db, ref, "extraction", null, T);
    automatedLifecycle.autoVerify(db, ref, T);
    db.run(
      `INSERT INTO fact_history (fact_id, seq, at, actor, action, from_status, to_status, from_epistemic, to_epistemic)
       VALUES (?, 3, ?, 'user', 'set-validity', 'verified', 'verified', 'explicit', 'explicit')`,
      [ref.id, T],
    );
    expect(userDecisions.decide(db, ref, "approve", T)).toMatchObject({ status: "applied" });
    expect(db.all("SELECT epistemic FROM facts WHERE id = ?", [ref.id])[0]?.epistemic).toBe(
      "user-approved",
    );
  });

  it("a verified row the policy did not verify stays unchanged when approved (the old behaviour)", () => {
    const ref = fact("verified");
    expect(userDecisions.decide(db, ref, "approve", T)).toEqual({ status: "unchanged" });
  });
});
