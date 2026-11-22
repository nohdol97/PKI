// S01-T02: the user's approve, reject, dispute and undo (S01-R5, R7, R8) and the protection of the
// rows the user decided (R12). `lifecycle.undo` (approve, reject, dispute), `user-override.guard`.
// States are reached by real user actions wherever the user can reach them now; a line is forged
// only for what a later task (T03's value fix, a direct add) will write, and each such test says so.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import {
  addEvidence,
  insertItem,
  readFact,
  readItem,
  readRelation,
  saveFact,
  saveRelation,
  type EpistemicType,
  type KnowledgeAttributes,
  type KnowledgeStatus,
} from "./knowledge.ts";
import { migrate } from "./migrations.ts";
import {
  applyTransition,
  automatedLifecycle,
  type EntryKind,
  type EntryRef,
} from "./semantic-lifecycle.ts";
import { userDecisions } from "./semantic-user.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

const STATUSES: KnowledgeStatus[] = ["candidate", "verified", "disputed", "superseded", "rejected"];
const KINDS: EntryKind[] = ["item", "fact", "relation"];
const BASIS = { sourceId: 7, version: 3 };
type Action = "approve" | "reject" | "dispute";
const ACTIONS: Action[] = ["approve", "reject", "dispute"];
const TARGET: Record<Action, KnowledgeStatus> = {
  approve: "verified",
  reject: "rejected",
  dispute: "disputed",
};

const attrs = (status: KnowledgeStatus, epistemic: EpistemicType): KnowledgeAttributes => ({
  epistemic,
  status,
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
});

let counter = 0;
/** A row of `kind` inserted at `status` (an INSERT is not gated), with no history. */
function row(
  kind: EntryKind,
  status: KnowledgeStatus = "candidate",
  epistemic: EpistemicType = "explicit",
): EntryRef {
  counter++;
  const a = attrs(status, epistemic);
  const owner = insertItem(db, { type: "p", name: `item-${counter}`, ...a });
  if (kind === "item") return { kind, id: owner };
  if (kind === "fact") {
    return { kind, id: saveFact(db, { itemId: owner, kind: "k", value: `v${counter}`, ...a }).id };
  }
  return { kind, id: saveRelation(db, { subjectId: owner, type: "T", objectId: owner, ...a }).id };
}

const HISTORY = {
  item: "item_history",
  fact: "fact_history",
  relation: "relation_history",
} as const;
const FK = { item: "item_id", fact: "fact_id", relation: "relation_id" } as const;
const read = (ref: EntryRef) =>
  ref.kind === "item"
    ? readItem(db, ref.id)
    : ref.kind === "fact"
      ? readFact(db, ref.id)
      : readRelation(db, ref.id);
const lines = (ref: EntryRef) =>
  db.all(`SELECT * FROM ${HISTORY[ref.kind]} WHERE ${FK[ref.kind]} = ? ORDER BY seq`, [ref.id]);
const state = (ref: EntryRef) => {
  const r = read(ref);
  return { status: r?.status, epistemic: r?.epistemic };
};
const decide = (ref: EntryRef, action: Action) => userDecisions.decide(db, ref, action);
const undo = (ref: EntryRef) => userDecisions.undo(db, ref);

let version = 0;
/** Gives the fact or relation evidence from a new source; returns the source's external id. */
function cite(ref: EntryRef): string {
  version++;
  const externalId = `e${version}`;
  saveSourceRecord(db, "c1", { externalId, title: "t", body: "abc" });
  const id = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
  addEvidence(db, {
    target: ref.kind === "fact" ? { factId: ref.id } : { relationId: ref.id },
    sourceVersionId: id,
    start: 0,
    end: 1,
    quote: "a",
  });
  return externalId;
}
/** A newer version of the source: the evidence above is past evidence now. */
const replaceSource = (externalId: string) =>
  saveSourceRecord(db, "c1", { externalId, title: "t", body: "xyz" });

// the user's rows of the S01-R5 table, by action
const USER_ROWS: [KnowledgeStatus, Action][] = [
  ["candidate", "approve"],
  ["candidate", "reject"],
  ["verified", "dispute"],
  ["disputed", "approve"],
  ["disputed", "reject"],
  ["superseded", "approve"],
  ["rejected", "approve"],
];

describe("user transitions (S01-R5, R7)", () => {
  const cases = KINDS.flatMap((kind) =>
    STATUSES.flatMap((from) => ACTIONS.map((action) => ({ kind, from, action }))),
  );
  it.each(cases)(
    "$kind $from, $action: applies only the user's rows of the table",
    ({ kind, from, action }) => {
      const ref = row(kind, from, "hypothesis");
      const outcome = decide(ref, action);
      const listed = USER_ROWS.some(([f, a]) => f === from && a === action);
      if (from === TARGET[action]) {
        expect(outcome).toEqual({ status: "unchanged" });
        expect(lines(ref)).toEqual([]);
      } else if (listed) {
        expect(outcome).toEqual({ status: "applied", seq: 1 });
        expect(state(ref)).toEqual({
          status: TARGET[action],
          // only an approval changes the epistemic type (R11 ①)
          epistemic: action === "approve" ? "user-approved" : "hypothesis",
        });
        expect(lines(ref)).toMatchObject([
          { actor: "user", action, from_status: from, to_status: TARGET[action] },
        ]);
      } else {
        expect(outcome).toEqual({ status: "refused", reason: "invalid-transition" });
        expect(state(ref).status).toBe(from);
        expect(lines(ref)).toEqual([]);
      }
    },
  );

  it("refuses a row that does not exist", () => {
    for (const kind of KINDS) {
      expect(decide({ kind, id: 999 }, "approve")).toEqual({
        status: "refused",
        reason: "not-found",
      });
      expect(undo({ kind, id: 999 })).toEqual({ status: "refused", reason: "not-found" });
    }
  });

  it("repeating an action is unchanged and writes no second line", () => {
    const ref = row("fact");
    expect(decide(ref, "approve").status).toBe("applied");
    expect(decide(ref, "approve")).toEqual({ status: "unchanged" });
    expect(lines(ref)).toHaveLength(1);
  });

  it("gives an approval of a fact or relation with no current evidence the reason code, and not one with current evidence or an item", () => {
    const bare = row("fact");
    const cited = row("relation");
    cite(cited);
    const item = row("item");
    decide(bare, "approve");
    decide(cited, "approve");
    decide(item, "approve");
    expect(lines(bare)[0]?.reason).toBe("accepted-without-current-evidence");
    expect(lines(cited)[0]?.reason).toBeNull();
    expect(lines(item)[0]?.reason).toBeNull();
  });
});

describe("lifecycle.undo (approve, reject, dispute) (S01-R8)", () => {
  it.each(KINDS)("restores the state and the epistemic type an approval replaced: %s", (kind) => {
    const ref = row(kind, "candidate", "hypothesis");
    decide(ref, "approve");
    expect(state(ref)).toEqual({ status: "verified", epistemic: "user-approved" });
    expect(undo(ref)).toEqual({ status: "applied", seq: 2 });
    expect(state(ref)).toEqual({ status: "candidate", epistemic: "hypothesis" });
    expect(lines(ref)[1]).toMatchObject({
      actor: "user",
      action: "undo",
      from_status: "verified",
      to_status: "candidate",
      from_epistemic: "user-approved",
      to_epistemic: "hypothesis",
      reverts_seq: 1,
    });
  });

  it("returns an approval of a disputed row to disputed, not to candidate", () => {
    const ref = row("fact", "verified", "explicit");
    decide(ref, "dispute");
    decide(ref, "approve");
    expect(undo(ref).status).toBe("applied");
    expect(state(ref)).toEqual({ status: "disputed", epistemic: "explicit" });
  });

  it("undoes a rejection and a dispute to the state before", () => {
    const rejected = row("relation", "candidate", "inferred");
    decide(rejected, "reject");
    undo(rejected);
    expect(state(rejected)).toEqual({ status: "candidate", epistemic: "inferred" });
    const disputed = row("fact", "verified", "inferred");
    decide(disputed, "dispute");
    undo(disputed);
    expect(state(disputed)).toEqual({ status: "verified", epistemic: "inferred" });
  });

  it("restores the epistemic type when the status alone is what the approval left", () => {
    const ref = row("fact", "rejected", "hypothesis");
    decide(ref, "approve");
    undo(ref);
    expect(state(ref)).toEqual({ status: "rejected", epistemic: "hypothesis" });
  });

  it("an undo is itself a line, and the lines before it stay", () => {
    const ref = row("fact");
    decide(ref, "approve");
    undo(ref);
    expect(lines(ref).map((l) => [l.seq, l.action])).toEqual([
      [1, "approve"],
      [2, "undo"],
    ]);
  });

  it("a second undo is nothing-to-undo, and writes nothing", () => {
    const ref = row("fact");
    decide(ref, "approve");
    undo(ref);
    expect(undo(ref)).toEqual({ status: "refused", reason: "nothing-to-undo" });
    expect(lines(ref)).toHaveLength(2);
    expect(state(ref).status).toBe("candidate");
  });

  it("the action can be taken again after an undo, and undone again", () => {
    const ref = row("fact");
    decide(ref, "approve");
    undo(ref);
    expect(decide(ref, "approve")).toEqual({ status: "applied", seq: 3 });
    expect(undo(ref)).toEqual({ status: "applied", seq: 4 });
    expect(lines(ref)[3]).toMatchObject({ reverts_seq: 3 });
    expect(state(ref).status).toBe("candidate");
  });

  it("refuses a row with no history, and a row whose newest line is an automated change (not-latest)", () => {
    expect(undo(row("fact"))).toEqual({ status: "refused", reason: "nothing-to-undo" });
    const ref = row("fact", "candidate");
    automatedLifecycle.created(db, ref, "extraction", null);
    expect(undo(ref)).toEqual({ status: "refused", reason: "not-latest" });
    // a user action followed by the propagation's supersede
    const acted = row("fact", "candidate");
    cite(acted);
    decide(acted, "approve");
    expect(automatedLifecycle.supersede(db, acted, BASIS).status).toBe("applied");
    expect(undo(acted)).toEqual({ status: "refused", reason: "not-latest" });
    expect(state(acted).status).toBe("superseded");
    expect(lines(acted)).toHaveLength(2);
  });

  it("restores a row propagation had superseded, which evidence then brings back as that propagation's state", () => {
    const ref = row("fact", "candidate", "explicit");
    expect(automatedLifecycle.supersede(db, ref, BASIS).status).toBe("applied");
    decide(ref, "approve"); // from superseded, with no current evidence
    expect(lines(ref)[1]?.reason).toBe("accepted-without-current-evidence");
    undo(ref);
    expect(state(ref)).toEqual({ status: "superseded", epistemic: "explicit" });
    expect(automatedLifecycle.evidenceReturned(db, ref, BASIS).status).toBe("applied");
    expect(state(ref)).toEqual({ status: "candidate", epistemic: "explicit" });
  });

  // T03 writes the value fix's `replace` line and its batch; until then it is not undone here.
  it("leaves a user line of another action (a value fix) to the task that writes it: invalid-transition, no line", () => {
    const ref = row("fact", "verified", "user-approved");
    expect(applyTransition(db, ref, "user", "superseded").status).toBe("applied");
    expect(undo(ref)).toEqual({ status: "refused", reason: "invalid-transition" });
    expect(lines(ref)).toHaveLength(1);
    expect(state(ref).status).toBe("superseded");
  });
});

describe("user-override.guard (S01-R12)", () => {
  it("refuses explicitEvidence on a user-decided row before the same-status shortcut: user-override, no line", () => {
    const rejected = row("fact", "candidate", "hypothesis");
    decide(rejected, "reject"); // epistemic stays hypothesis: the rise would apply to it
    expect(automatedLifecycle.explicitEvidence(db, rejected, BASIS)).toEqual({
      status: "refused",
      reason: "user-override",
    });
    expect(state(rejected)).toEqual({ status: "rejected", epistemic: "hypothesis" });
    // an approved row is user-approved, not hypothesis: it was `unchanged` before the guard
    const approved = row("relation", "candidate", "hypothesis");
    decide(approved, "approve");
    expect(automatedLifecycle.explicitEvidence(db, approved, BASIS)).toEqual({
      status: "refused",
      reason: "user-override",
    });
    expect(lines(approved)).toHaveLength(1);
  });

  it("still raises a hypothesis row the user did not decide", () => {
    const ref = row("fact", "candidate", "hypothesis");
    expect(automatedLifecycle.explicitEvidence(db, ref, BASIS).status).toBe("applied");
    expect(state(ref).epistemic).toBe("explicit");
  });

  it("answers user-override, not unchanged, to a policy asking for the state the user set", () => {
    const ref = row("fact", "candidate");
    cite(ref); // an approval with current evidence: the propagation's supersede is not what is held off here
    decide(ref, "approve");
    expect(applyTransition(db, ref, "policy", "verified")).toEqual({
      status: "refused",
      reason: "user-override",
    });
    // any actor, any target: only a propagation's supersede and a policy's dispute may touch it
    for (const actor of ["extraction", "propagation", "policy"] as const) {
      for (const to of ["candidate", "verified", "rejected", "disputed"] as const) {
        if (actor === "policy" && to === "disputed") continue;
        expect(applyTransition(db, ref, actor, to, { basis: BASIS }), `${actor} ${to}`).toEqual({
          status: "refused",
          reason: "user-override",
        });
      }
    }
    expect(lines(ref)).toHaveLength(1);
    expect(state(ref)).toEqual({ status: "verified", epistemic: "user-approved" });
  });

  it("a user-decided row gets the automated transitions as the table says when the call is allowed", () => {
    const ref = row("fact", "candidate", "explicit");
    cite(ref);
    decide(ref, "approve"); // with current evidence: the propagation may still supersede it
    expect(automatedLifecycle.supersede(db, ref, BASIS)).toMatchObject({ status: "applied" });
    expect(state(ref)).toEqual({ status: "superseded", epistemic: "user-approved" });
    // and the evidence returning restores the approval (R12 2)
    expect(automatedLifecycle.evidenceReturned(db, ref, BASIS).status).toBe("applied");
    expect(state(ref)).toEqual({ status: "verified", epistemic: "user-approved" });
  });

  it("a policy dispute alone does not make a row user-decided: an automated call after it is not refused as user-override", () => {
    const ref = row("fact", "verified", "hypothesis");
    expect(automatedLifecycle.raiseDispute(db, ref, BASIS).status).toBe("applied");
    expect(lines(ref)[0]).toMatchObject({ actor: "policy", action: "dispute" });
    expect(automatedLifecycle.explicitEvidence(db, ref, BASIS).status).toBe("applied");
    expect(state(ref)).toEqual({ status: "disputed", epistemic: "explicit" });
  });

  it("an automated dispute needs the source version, and a policy dispute leaves the value and the epistemic type", () => {
    const ref = row("fact", "candidate", "explicit");
    decide(ref, "approve");
    expect(automatedLifecycle.raiseDispute(db, ref, null)).toEqual({
      status: "refused",
      reason: "basis-required",
    });
    expect(applyTransition(db, ref, "policy", "disputed")).toEqual({
      status: "refused",
      reason: "basis-required",
    });
    expect(lines(ref)).toHaveLength(1);
    expect(automatedLifecycle.raiseDispute(db, ref, BASIS).status).toBe("applied");
    expect(state(ref)).toEqual({ status: "disputed", epistemic: "user-approved" });
    // the policy's line is no user action: it is not undone (R8)
    expect(undo(ref)).toEqual({ status: "refused", reason: "not-latest" });
    expect(lines(ref)[1]).toMatchObject({
      actor: "policy",
      action: "dispute",
      basis_source_id: 7,
      basis_version: 3,
    });
  });

  describe("an approval with no current evidence (accepted-without-current-evidence)", () => {
    const approvedBare = (from: KnowledgeStatus = "candidate") => {
      const ref = row("fact", from);
      decide(ref, "approve");
      return ref;
    };

    it.each(["candidate", "superseded", "rejected"] as const)(
      "is not superseded by the propagation while it is the last user action: from %s",
      (from) => {
        const ref = approvedBare(from);
        expect(lines(ref).at(-1)?.reason).toBe("accepted-without-current-evidence");
        const before = lines(ref).length;
        expect(automatedLifecycle.supersede(db, ref, BASIS)).toEqual({
          status: "refused",
          reason: "user-override",
        });
        expect(state(ref)).toEqual({ status: "verified", epistemic: "user-approved" });
        expect(lines(ref)).toHaveLength(before);
      },
    );

    it("is protected for a relation as for a fact", () => {
      const ref = row("relation");
      decide(ref, "approve");
      expect(automatedLifecycle.supersede(db, ref, BASIS).status).toBe("refused");
    });

    it("is superseded again once the approval is undone", () => {
      const ref = approvedBare();
      undo(ref);
      expect(automatedLifecycle.supersede(db, ref, BASIS).status).toBe("applied");
    });

    it("stops being protected when a later user action takes its place as the last one", () => {
      const ref = approvedBare();
      decide(ref, "dispute");
      expect(automatedLifecycle.supersede(db, ref, BASIS).status).toBe("applied");
    });

    it("an approval made with current evidence is not protected", () => {
      const ref = row("fact");
      cite(ref);
      decide(ref, "approve");
      expect(automatedLifecycle.supersede(db, ref, BASIS).status).toBe("applied");
    });

    it("the evidence a newer version took is no current evidence: the approval after it is protected", () => {
      const ref = row("fact");
      replaceSource(cite(ref));
      decide(ref, "approve");
      expect(lines(ref)[0]?.reason).toBe("accepted-without-current-evidence");
      expect(automatedLifecycle.supersede(db, ref, BASIS).status).toBe("refused");
    });
  });

  it("does not supersede a row written by the user (user_authored), and writes no line", () => {
    // T03 makes such a row; its column is set here by a plain INSERT, which the gate does not block
    const owner = insertItem(db, { type: "p", name: "o", ...attrs("verified", "user-approved") });
    const id = db.run(
      `INSERT INTO facts (item_id, kind, value, epistemic, status, observed_at, user_authored)
       VALUES (?, 'k', 'v', 'user-approved', 'verified', '2026-11-21T00:00:00Z', 1)`,
      [owner],
    ).lastInsertRowid;
    const ref: EntryRef = { kind: "fact", id };
    expect(automatedLifecycle.supersede(db, ref, BASIS)).toEqual({
      status: "refused",
      reason: "user-override",
    });
    expect(state(ref).status).toBe("verified");
    expect(lines(ref)).toEqual([]);
  });

  it("does not bring back a row the user superseded, and a user action cancelled by an undo no longer holds the row", () => {
    const ref = row("fact", "candidate", "explicit");
    automatedLifecycle.supersede(db, ref, BASIS);
    decide(ref, "approve");
    undo(ref); // the approval is cancelled: the row is the propagation's again
    expect(automatedLifecycle.explicitEvidence(db, ref, BASIS).status).toBe("unchanged");
    expect(automatedLifecycle.evidenceReturned(db, ref, BASIS).status).toBe("applied");
  });

  // an undo line with no reverts_seq cannot be written by the gate; read as "before line 0" it
  // restored a candidate (S01-T01 hand-off 14)
  it("refuses to restore from an undo line that names no line", () => {
    const ref = row("fact", "candidate", "explicit");
    automatedLifecycle.supersede(db, ref, BASIS);
    db.run(
      `INSERT INTO fact_history (fact_id, seq, at, actor, action, from_status, to_status,
         from_epistemic, to_epistemic, reverts_seq)
       VALUES (?, 2, '2026-11-22T00:00:00Z', 'user', 'undo', 'superseded', 'superseded',
         'explicit', 'explicit', NULL)`,
      [ref.id],
    );
    expect(automatedLifecycle.evidenceReturned(db, ref, BASIS)).toEqual({
      status: "refused",
      reason: "invalid-transition",
    });
    expect(state(ref).status).toBe("superseded");
    expect(lines(ref)).toHaveLength(2);
  });

  it("the automated entry has no approve, reject or user action to call (type and keys)", () => {
    expect(Object.keys(automatedLifecycle).sort()).toEqual(
      ["created", "evidenceReturned", "explicitEvidence", "raiseDispute", "supersede"].sort(),
    );
    // @ts-expect-error the automated entry has no approve
    expect(automatedLifecycle.approve).toBeUndefined();
    // @ts-expect-error nor a reject
    expect(automatedLifecycle.reject).toBeUndefined();
    // @ts-expect-error nor an undo
    expect(automatedLifecycle.undo).toBeUndefined();
  });
});
