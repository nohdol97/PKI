// S01-T03: the user's direct add and value fix (S01-R7), the undo of both (R8), and the refusal of a
// value the item already has (`value-exists`, provisional decision 13). `lifecycle.undo` (value fix,
// direct add), `correction.duplicate-value`. Every state is reached through the user entry and the
// automated entry; no history line or column is forged. All data is synthetic.
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
import { automatedLifecycle, isUserDecided, type EntryRef } from "./semantic-lifecycle.ts";
import { userDecisions, type UserEntry } from "./semantic-user.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

const BASIS = { sourceId: 7, version: 3 };
const AT = "2026-11-23T01:02:03.000Z";
const attrs = (status: KnowledgeStatus, epistemic: EpistemicType): KnowledgeAttributes => ({
  epistemic,
  status,
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
});

const TABLE = { item: "items", fact: "facts", relation: "relations" } as const;
const HISTORY = {
  item: "item_history",
  fact: "fact_history",
  relation: "relation_history",
} as const;
const FK = { item: "item_id", fact: "fact_id", relation: "relation_id" } as const;
const lines = (ref: EntryRef) =>
  db.all(`SELECT * FROM ${HISTORY[ref.kind]} WHERE ${FK[ref.kind]} = ? ORDER BY seq`, [ref.id]);
const stored = (ref: EntryRef) =>
  db.all(
    `SELECT status, epistemic, user_authored, confidence FROM ${TABLE[ref.kind]} WHERE id = ?`,
    [ref.id],
  )[0];
const state = (ref: EntryRef) => {
  const r = stored(ref);
  return r && { status: r.status, epistemic: r.epistemic };
};
const everything = () => ({
  items: db.all("SELECT * FROM items ORDER BY id"),
  facts: db.all("SELECT * FROM facts ORDER BY id"),
  relations: db.all("SELECT * FROM relations ORDER BY id"),
  history: [
    ...db.all("SELECT * FROM item_history ORDER BY item_id, seq"),
    ...db.all("SELECT * FROM fact_history ORDER BY fact_id, seq"),
    ...db.all("SELECT * FROM relation_history ORDER BY relation_id, seq"),
  ],
});

let counter = 0;
const newItem = (status: KnowledgeStatus = "verified", epistemic: EpistemicType = "explicit") => {
  counter++;
  return insertItem(db, { type: "Project", name: `p-${counter}`, ...attrs(status, epistemic) });
};
/** A fact the extraction would have made: a creation line, then optionally moved to `status`. */
function extracted(
  owner: number,
  value: string,
  status: KnowledgeStatus = "candidate",
  epistemic: EpistemicType = "explicit",
): EntryRef {
  const ref: EntryRef = {
    kind: "fact",
    id: saveFact(db, {
      itemId: owner,
      kind: "target_date",
      value,
      ...attrs("candidate", epistemic),
    }).id,
  };
  automatedLifecycle.created(db, ref, "extraction", BASIS);
  moveTo(ref, status);
  return ref;
}
function extractedRelation(subject: number, object: number, status: KnowledgeStatus = "candidate") {
  const ref: EntryRef = {
    kind: "relation",
    id: saveRelation(db, {
      subjectId: subject,
      type: "DEPENDS_ON",
      objectId: object,
      ...attrs("candidate", "explicit"),
    }).id,
  };
  automatedLifecycle.created(db, ref, "extraction", BASIS);
  moveTo(ref, status);
  return ref;
}
/** Reaches `status` the way the product does: the user's actions and the propagation's. */
function moveTo(ref: EntryRef, status: KnowledgeStatus) {
  if (status === "verified") userDecisions.decide(db, ref, "approve");
  if (status === "rejected") userDecisions.decide(db, ref, "reject");
  if (status === "superseded") automatedLifecycle.supersede(db, ref, BASIS);
  if (status === "disputed") {
    userDecisions.decide(db, ref, "approve");
    userDecisions.decide(db, ref, "dispute");
  }
}

let version = 0;
function cite(ref: EntryRef) {
  version++;
  saveSourceRecord(db, "c1", { externalId: `e${version}`, title: "t", body: "abc" });
  const id = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
  addEvidence(db, {
    target: ref.kind === "fact" ? { factId: ref.id } : { relationId: ref.id },
    sourceVersionId: id,
    start: 0,
    end: 1,
    quote: "a",
  });
  return `e${version}`;
}

const factEntry = (itemId: number, value: string, factKind = "target_date"): UserEntry => ({
  kind: "fact",
  itemId,
  factKind,
  value,
});
function added(entry: UserEntry, at?: string): EntryRef {
  const r = userDecisions.add(db, entry, at);
  if (r.status !== "applied") throw new Error(`add refused: ${r.reason}`);
  return r.ref;
}
function replaced(fact: EntryRef, value: string, at?: string) {
  const r = userDecisions.replaceValue(db, fact, value, at);
  if (r.status !== "applied") throw new Error(`replace refused: ${r.reason}`);
  return r;
}

describe("a direct add (S01-R7)", () => {
  it("writes a verified, user-approved row the user wrote, with no confidence, and one creation line", () => {
    const owner = newItem();
    const result = userDecisions.add(db, factEntry(owner, "2026-12-24"), AT);
    expect(result).toMatchObject({ status: "applied", seq: 1 });
    const ref = added(factEntry(owner, "2026-12-25"), AT);
    expect(stored(ref)).toEqual({
      status: "verified",
      epistemic: "user-approved",
      user_authored: 1,
      confidence: null,
    });
    expect(readFact(db, ref.id)).toMatchObject({
      itemId: owner,
      kind: "target_date",
      value: "2026-12-25",
      validAt: null,
      observedAt: AT,
    });
    expect(lines(ref)).toEqual([
      expect.objectContaining({
        seq: 1,
        at: AT,
        actor: "user",
        action: "created",
        from_status: null,
        to_status: "verified",
        from_epistemic: null,
        to_epistemic: "user-approved",
        reason: null,
        batch: null,
        reverts_seq: null,
      }),
    ]);
  });

  it("adds an item and a relation the same way, and each counts as decided by the user", () => {
    const owner = newItem();
    const item = added({ kind: "item", type: "Concept", name: "합성 개념" }, AT);
    const relation = added(
      { kind: "relation", subjectId: owner, type: "DEPENDS_ON", objectId: item.id },
      AT,
    );
    for (const ref of [item, relation]) {
      expect(stored(ref)).toMatchObject({
        status: "verified",
        epistemic: "user-approved",
        user_authored: 1,
      });
      expect(lines(ref)).toHaveLength(1);
      expect(isUserDecided(db, ref)).toBe(true);
    }
    expect(readItem(db, item.id)).toMatchObject({ type: "Concept", name: "합성 개념" });
    expect(readRelation(db, relation.id)).toMatchObject({ subjectId: owner, objectId: item.id });
  });

  it("is not-found, and writes nothing, for an item or a relation end that is not stored", () => {
    const owner = newItem();
    const before = everything();
    expect(userDecisions.add(db, factEntry(999, "x"))).toEqual({
      status: "refused",
      reason: "not-found",
    });
    expect(
      userDecisions.add(db, { kind: "relation", subjectId: owner, type: "T", objectId: 999 }),
    ).toEqual({ status: "refused", reason: "not-found" });
    expect(
      userDecisions.add(db, { kind: "relation", subjectId: 999, type: "T", objectId: owner }),
    ).toEqual({ status: "refused", reason: "not-found" });
    expect(everything()).toEqual(before);
  });

  it("is not changed by the propagation or by evidence: the row stays verified and no line is written", () => {
    const owner = newItem();
    const ref = added(factEntry(owner, "2026-12-24"));
    expect(automatedLifecycle.supersede(db, ref, BASIS)).toEqual({
      status: "refused",
      reason: "user-override",
    });
    expect(automatedLifecycle.explicitEvidence(db, ref, BASIS)).toEqual({
      status: "refused",
      reason: "user-override",
    });
    expect(automatedLifecycle.evidenceReturned(db, ref, BASIS).status).toBe("unchanged");
    expect(state(ref)).toEqual({ status: "verified", epistemic: "user-approved" });
    expect(lines(ref)).toHaveLength(1);
  });

  it("refuses a creation line the automated entry is asked to write for the user", () => {
    const owner = newItem();
    const ref = {
      kind: "fact",
      id: saveFact(db, { itemId: owner, kind: "k", value: "v", ...attrs("candidate", "explicit") })
        .id,
    } as const;
    expect(() => automatedLifecycle.created(db, ref, "user", null)).toThrow(/user entry/);
    expect(lines(ref)).toEqual([]);
  });
});

describe("lifecycle.undo (direct add) (S01-R8, provisional decision 6)", () => {
  it.each(["item", "fact", "relation"] as const)(
    "deletes a %s the user added when nothing came to it, and its history goes with it",
    (kind) => {
      const owner = newItem();
      const ref =
        kind === "item"
          ? added({ kind: "item", type: "Concept", name: "n" })
          : kind === "fact"
            ? added(factEntry(owner, "2026-12-24"))
            : added({ kind: "relation", subjectId: owner, type: "T", objectId: owner });
      expect(userDecisions.undo(db, ref)).toEqual({ status: "removed" });
      expect(stored(ref)).toBeUndefined();
      expect(lines(ref)).toEqual([]);
      expect(userDecisions.undo(db, ref)).toEqual({ status: "refused", reason: "not-found" });
    },
  );

  it.each(["fact", "relation"] as const)(
    "keeps a %s that evidence came to as a candidate hypothesis that is no longer the user's",
    (kind) => {
      const owner = newItem();
      const ref =
        kind === "fact"
          ? added(factEntry(owner, "2026-12-24"))
          : added({ kind: "relation", subjectId: owner, type: "T", objectId: owner });
      cite(ref);
      expect(userDecisions.undo(db, ref, AT)).toEqual({ status: "applied", seq: 2 });
      expect(stored(ref)).toMatchObject({
        status: "candidate",
        epistemic: "hypothesis",
        user_authored: 0,
      });
      expect(lines(ref)[1]).toMatchObject({
        actor: "user",
        action: "undo",
        from_status: "verified",
        to_status: "candidate",
        from_epistemic: "user-approved",
        to_epistemic: "hypothesis",
        reverts_seq: 1,
      });
      // it follows the rules of a row from a source now (R8): not protected, raised by explicit evidence
      expect(isUserDecided(db, ref)).toBe(false);
      expect(automatedLifecycle.explicitEvidence(db, ref, BASIS).status).toBe("applied");
      expect(state(ref)).toEqual({ status: "candidate", epistemic: "explicit" });
      expect(automatedLifecycle.supersede(db, ref, BASIS).status).toBe("applied");
    },
  );

  it("keeps a fact whose only evidence is past evidence: any evidence counts", () => {
    const owner = newItem();
    const ref = added(factEntry(owner, "2026-12-24"));
    const external = cite(ref);
    saveSourceRecord(db, "c1", { externalId: external, title: "t", body: "xyz" }); // a newer version
    expect(userDecisions.undo(db, ref).status).toBe("applied");
    expect(stored(ref)).toMatchObject({ status: "candidate", user_authored: 0 });
  });

  it("does not delete an item facts or relations hang on: not-latest, nothing changes", () => {
    const item = added({ kind: "item", type: "Concept", name: "n" });
    added(factEntry(item.id, "2026-12-24"));
    const before = everything();
    expect(userDecisions.undo(db, item)).toEqual({ status: "refused", reason: "not-latest" });
    expect(everything()).toEqual(before);
    const other = added({ kind: "item", type: "Concept", name: "m" });
    added({ kind: "relation", subjectId: newItem(), type: "T", objectId: other.id });
    expect(userDecisions.undo(db, other)).toEqual({ status: "refused", reason: "not-latest" });
  });

  it("is a second undo's nothing-to-undo after an undo that kept the row, and not-latest after a later line of another actor", () => {
    const owner = newItem();
    const ref = added(factEntry(owner, "2026-12-24"));
    cite(ref);
    userDecisions.undo(db, ref);
    expect(userDecisions.undo(db, ref)).toEqual({ status: "refused", reason: "nothing-to-undo" });

    const later = added(factEntry(owner, "2026-12-26"));
    expect(automatedLifecycle.raiseDispute(db, later, BASIS).status).toBe("applied");
    expect(userDecisions.undo(db, later)).toEqual({ status: "refused", reason: "not-latest" });
    expect(state(later)).toEqual({ status: "disputed", epistemic: "user-approved" });
  });

  it("is a user action after the add that an undo takes back, and the add itself then cannot be undone", () => {
    const owner = newItem();
    const ref = added(factEntry(owner, "2026-12-24"));
    userDecisions.decide(db, ref, "dispute");
    expect(userDecisions.undo(db, ref).status).toBe("applied");
    expect(state(ref)).toEqual({ status: "verified", epistemic: "user-approved" });
    expect(userDecisions.undo(db, ref)).toEqual({ status: "refused", reason: "nothing-to-undo" });
    expect(stored(ref)).toBeDefined();
  });

  it("can add the same value again after the undo", () => {
    const owner = newItem();
    const ref = added(factEntry(owner, "2026-12-24"));
    userDecisions.undo(db, ref);
    expect(added(factEntry(owner, "2026-12-24"))).toBeDefined();
  });
});

describe("a value fix (S01-R7)", () => {
  it("supersedes a verified fact and adds the new value as the user's row, in one batch", () => {
    const owner = newItem();
    const old = extracted(owner, "2026-12-05", "verified");
    const r = replaced(old, "2026-12-20", AT);
    expect(r.replaced).toEqual(old);
    expect(state(old)).toEqual({ status: "superseded", epistemic: "user-approved" });
    expect(stored(r.added)).toEqual({
      status: "verified",
      epistemic: "user-approved",
      user_authored: 1,
      confidence: null,
    });
    expect(readFact(db, r.added.id)).toMatchObject({
      itemId: owner,
      kind: "target_date",
      value: "2026-12-20",
    });
    const retire = lines(old).at(-1);
    expect(retire).toMatchObject({
      actor: "user",
      action: "replace",
      from_status: "verified",
      to_status: "superseded",
      at: AT,
    });
    expect(lines(r.added)).toHaveLength(1);
    expect(lines(r.added)[0]).toMatchObject({
      action: "created",
      actor: "user",
      batch: retire?.batch,
    });
    expect(retire?.batch).not.toBeNull();
    expect(r.seq).toBe(1);
  });

  it.each(["candidate", "disputed"] as const)(
    "rejects a %s fact and leaves its epistemic type",
    (status) => {
      const owner = newItem();
      const old = extracted(owner, "2026-12-05", status, "hypothesis");
      const epistemic = stored(old)?.epistemic;
      replaced(old, "2026-12-20");
      expect(stored(old)).toMatchObject({ status: "rejected", epistemic });
      expect(lines(old).at(-1)).toMatchObject({ action: "replace", to_status: "rejected" });
    },
  );

  it("gives every fix its own batch number", () => {
    const owner = newItem();
    const a = replaced(extracted(owner, "2026-12-05"), "2026-12-06");
    const b = replaced(extracted(owner, "2026-12-07"), "2026-12-08");
    const batch = (ref: EntryRef) => lines(ref).at(-1)?.batch;
    expect(batch(a.added)).not.toBe(batch(b.added));
    expect(batch(a.replaced)).toBe(batch(a.added));
  });

  it.each(["superseded", "rejected"] as const)(
    "refuses to fix a %s fact: invalid-transition, nothing written",
    (status) => {
      const owner = newItem();
      const old = extracted(owner, "2026-12-05", status);
      const before = everything();
      expect(userDecisions.replaceValue(db, old, "2026-12-20")).toEqual({
        status: "refused",
        reason: "invalid-transition",
      });
      expect(everything()).toEqual(before);
    },
  );

  it("answers invalid-transition, not value-exists, for a retired fact even when the value is taken", () => {
    const owner = newItem();
    const retired = extracted(owner, "2026-12-01", "rejected");
    extracted(owner, "2026-12-05");
    expect(userDecisions.replaceValue(db, retired, "2026-12-05")).toEqual({
      status: "refused",
      reason: "invalid-transition",
    });
  });

  it("is not-found for a fact that is not stored and for a row of another kind", () => {
    const owner = newItem();
    expect(userDecisions.replaceValue(db, { kind: "fact", id: 999 }, "x")).toEqual({
      status: "refused",
      reason: "not-found",
    });
    expect(userDecisions.replaceValue(db, { kind: "item", id: owner }, "x")).toEqual({
      status: "refused",
      reason: "not-found",
    });
  });

  it("can fix a value the user wrote: the user's value is retired and a new one added", () => {
    const owner = newItem();
    const mine = added(factEntry(owner, "2026-12-24"));
    const r = replaced(mine, "2026-12-25");
    expect(state(mine)).toEqual({ status: "superseded", epistemic: "user-approved" });
    expect(stored(r.added)).toMatchObject({ status: "verified", user_authored: 1 });
  });

  it("does not bring the old value back when its evidence returns (R13), but a user approval does", () => {
    const owner = newItem();
    const old = extracted(owner, "2026-12-05", "verified");
    replaced(old, "2026-12-20");
    expect(automatedLifecycle.evidenceReturned(db, old, BASIS)).toEqual({
      status: "refused",
      reason: "user-override",
    });
    // already superseded by the user: the propagation's call finds nothing to do and writes nothing
    expect(automatedLifecycle.supersede(db, old, BASIS).status).toBe("unchanged");
    expect(lines(old).at(-1)?.action).toBe("replace");
    expect(state(old)?.status).toBe("superseded");
    expect(userDecisions.decide(db, old, "approve").status).toBe("applied");
    expect(state(old)).toEqual({ status: "verified", epistemic: "user-approved" });
  });

  it("keeps a rejected old value rejected when the same value is extracted again", () => {
    const owner = newItem();
    const old = extracted(owner, "2026-12-05", "candidate");
    replaced(old, "2026-12-20");
    // the extraction finds the row by its key, adds evidence and asks the three automated calls
    expect(
      saveFact(db, {
        itemId: owner,
        kind: "target_date",
        value: "2026-12-05",
        ...attrs("candidate", "explicit"),
      }),
    ).toMatchObject({ id: old.id, created: false });
    expect(automatedLifecycle.evidenceReturned(db, old, BASIS).status).toBe("unchanged");
    expect(automatedLifecycle.explicitEvidence(db, old, BASIS).status).toBe("refused");
    expect(state(old)?.status).toBe("rejected");
  });
});

describe("lifecycle.undo (value fix) (S01-R8)", () => {
  const setup = (status: KnowledgeStatus = "verified", epistemic: EpistemicType = "explicit") => {
    const owner = newItem();
    const old = extracted(owner, "2026-12-05", status, epistemic);
    const before = state(old);
    return { owner, old, before, ...replaced(old, "2026-12-20") };
  };

  it.each([
    ["verified", "explicit"],
    ["candidate", "hypothesis"],
    ["disputed", "explicit"],
  ] as const)(
    "takes both rows back from the old row, to the state read from the line: %s/%s",
    (status, epistemic) => {
      const { old, added: fresh, before } = setup(status, epistemic);
      // the state before the fix, as the old row's line says (the approval made it user-approved)
      const prior = lines(old).at(-1);
      expect(userDecisions.undo(db, old, AT)).toMatchObject({ status: "applied" });
      expect(state(old)).toEqual({ status: prior?.from_status, epistemic: prior?.from_epistemic });
      expect(state(old)).toEqual(before);
      expect(stored(fresh)).toBeUndefined();
      expect(lines(fresh)).toEqual([]);
      expect(lines(old).at(-1)).toMatchObject({
        actor: "user",
        action: "undo",
        reverts_seq: prior?.seq,
        at: AT,
      });
    },
  );

  it("takes both rows back from the new row too, and answers removed for it", () => {
    const { old, added: fresh, before } = setup();
    expect(userDecisions.undo(db, fresh)).toEqual({ status: "removed" });
    expect(state(old)).toEqual(before);
    expect(stored(fresh)).toBeUndefined();
    expect(lines(old).at(-1)?.action).toBe("undo");
  });

  it("is nothing-to-undo the second time, from either row", () => {
    const { old, added: fresh } = setup();
    userDecisions.undo(db, old);
    expect(userDecisions.undo(db, old)).toEqual({ status: "refused", reason: "nothing-to-undo" });
    expect(userDecisions.undo(db, fresh)).toEqual({ status: "refused", reason: "not-found" });
  });

  it("is all or nothing: a later user action on the new row makes the whole undo not-latest", () => {
    const { old, added: fresh } = setup();
    userDecisions.decide(db, fresh, "dispute");
    const before = everything();
    expect(userDecisions.undo(db, old)).toEqual({ status: "refused", reason: "not-latest" });
    expect(everything()).toEqual(before);
  });

  it("is all or nothing: a later line on the old row (its approval) is what an undo of it takes back, and the batch stays", () => {
    const { old, added: fresh } = setup();
    userDecisions.decide(db, old, "approve");
    expect(userDecisions.undo(db, old).status).toBe("applied");
    expect(state(old)?.status).toBe("superseded");
    expect(stored(fresh)).toBeDefined();
  });

  it("is not-latest, and writes nothing, when a row of the fix is gone", () => {
    const { old, added: fresh } = setup();
    db.run("DELETE FROM facts WHERE id = ?", [fresh.id]); // a source deletion took the new row away
    const before = everything();
    expect(userDecisions.undo(db, old)).toEqual({ status: "refused", reason: "not-latest" });
    expect(everything()).toEqual(before);
  });

  it("keeps the new value as a candidate hypothesis when evidence came to it meanwhile, and restores the old row", () => {
    const { old, added: fresh, before } = setup();
    cite(fresh);
    expect(userDecisions.undo(db, old).status).toBe("applied");
    expect(state(old)).toEqual(before);
    expect(stored(fresh)).toMatchObject({
      status: "candidate",
      epistemic: "hypothesis",
      user_authored: 0,
    });
  });

  it("leaves a row an automated change touched after the fix: the propagation cannot, so only the policy's dispute does", () => {
    const { old, added: fresh } = setup();
    expect(automatedLifecycle.raiseDispute(db, fresh, BASIS).status).toBe("applied");
    const before = everything();
    expect(userDecisions.undo(db, old)).toEqual({ status: "refused", reason: "not-latest" });
    expect(everything()).toEqual(before);
  });

  it("throws, so a caller's transaction rolls back, when a row of the batch cannot be reverted after another was", () => {
    const owner = newItem();
    const old = extracted(owner, "2026-12-05", "verified");
    const fixed = replaced(old, "2026-12-20");
    const batch = lines(old).at(-1)?.batch;
    // a forged third member of the batch whose line cannot be reverted (no state before it); it has the highest id
    const odd = extracted(owner, "2026-12-09", "candidate");
    db.run(
      `INSERT INTO fact_history (fact_id, seq, at, actor, action, from_status, to_status,
         from_epistemic, to_epistemic, batch)
       VALUES (?, ?, '2026-11-23T00:00:00Z', 'user', 'replace', NULL, 'candidate', NULL, 'explicit', ?)`,
      [odd.id, lines(odd).length + 1, batch as number],
    );
    const before = everything();
    expect(() => db.transaction(() => userDecisions.undo(db, old))).toThrow(/cannot be reverted/);
    expect(everything()).toEqual(before); // the rows reverted before the throw are back
    expect(stored(fixed.added)).toBeDefined();
  });

  it("hands a candidate the fix rejected back to the propagation once the fix is undone", () => {
    const { old } = setup("candidate", "explicit");
    userDecisions.undo(db, old);
    expect(automatedLifecycle.supersede(db, old, BASIS).status).toBe("applied");
  });
});

describe("correction.duplicate-value (S01-R7, provisional decision 13)", () => {
  const STATUSES = ["candidate", "verified", "disputed", "superseded", "rejected"] as const;

  it.each(STATUSES)(
    "refuses a direct add of a value a %s fact has, with its id, and changes nothing",
    (status) => {
      const owner = newItem();
      const existing = extracted(owner, "2026-12-05", status);
      const before = everything();
      expect(userDecisions.add(db, factEntry(owner, "2026-12-05"), AT)).toEqual({
        status: "refused",
        reason: "value-exists",
        existing,
      });
      expect(everything()).toEqual(before);
    },
  );

  it.each(STATUSES)("refuses a value fix to a value a %s fact has, with its id", (status) => {
    const owner = newItem();
    const old = extracted(owner, "2026-12-01", "candidate");
    const existing = extracted(owner, "2026-12-05", status);
    const before = everything();
    expect(userDecisions.replaceValue(db, old, "2026-12-05")).toEqual({
      status: "refused",
      reason: "value-exists",
      existing,
    });
    expect(everything()).toEqual(before);
  });

  it("refuses a fix to the fact's own value, naming that fact", () => {
    const owner = newItem();
    const old = extracted(owner, "2026-12-05", "verified");
    expect(userDecisions.replaceValue(db, old, "2026-12-05")).toEqual({
      status: "refused",
      reason: "value-exists",
      existing: old,
    });
  });

  it("takes the same value of another kind or another item as a different row", () => {
    const owner = newItem();
    const other = newItem();
    extracted(owner, "2026-12-05", "verified");
    expect(userDecisions.add(db, factEntry(owner, "2026-12-05", "completion_date")).status).toBe(
      "applied",
    );
    expect(userDecisions.add(db, factEntry(other, "2026-12-05")).status).toBe("applied");
  });

  it.each(STATUSES)(
    "refuses a relation that already exists as %s, and an item with the same type and name",
    (status) => {
      const [a, b] = [newItem(), newItem()] as [number, number];
      const existing = extractedRelation(a, b, status);
      expect(
        userDecisions.add(db, { kind: "relation", subjectId: a, type: "DEPENDS_ON", objectId: b }),
      ).toEqual({ status: "refused", reason: "value-exists", existing });
      // the reverse direction and another type are other rows
      expect(
        userDecisions.add(db, { kind: "relation", subjectId: b, type: "DEPENDS_ON", objectId: a })
          .status,
      ).toBe("applied");
      const name = readItem(db, a)?.name as string;
      expect(userDecisions.add(db, { kind: "item", type: "Project", name })).toEqual({
        status: "refused",
        reason: "value-exists",
        existing: { kind: "item", id: a },
      });
      expect(userDecisions.add(db, { kind: "item", type: "Concept", name }).status).toBe("applied");
    },
  );

  // the advertised next step: approve the row the refusal names
  it.each([
    ["candidate", "explicit"],
    ["candidate", "hypothesis"],
    ["superseded", "explicit"],
    ["rejected", "hypothesis"],
    ["disputed", "explicit"],
  ] as const)(
    "approving the returned id makes a %s/%s row verified and user-approved, and an undo returns it",
    (status, epistemic) => {
      const owner = newItem();
      const existing = extracted(owner, "2026-12-05", status, epistemic);
      const before = state(existing);
      const refused = userDecisions.add(db, factEntry(owner, "2026-12-05"));
      if (refused.status !== "refused" || refused.reason !== "value-exists")
        throw new Error("expected value-exists");
      expect(userDecisions.decide(db, refused.existing, "approve").status).toBe("applied");
      expect(state(existing)).toEqual({ status: "verified", epistemic: "user-approved" });
      expect(userDecisions.undo(db, existing).status).toBe("applied");
      expect(state(existing)).toEqual(before);
    },
  );

  it("an approval of a relation it names works the same", () => {
    const [a, b] = [newItem(), newItem()] as [number, number];
    const existing = extractedRelation(a, b, "rejected");
    userDecisions.decide(db, existing, "approve");
    expect(state(existing)).toEqual({ status: "verified", epistemic: "user-approved" });
  });

  describe("an approval with no current evidence is not superseded again, until it is undone", () => {
    it("a row the propagation superseded", () => {
      const owner = newItem();
      const existing = extracted(owner, "2026-12-05", "candidate");
      const external = cite(existing);
      saveSourceRecord(db, "c1", { externalId: external, title: "t", body: "xyz" });
      expect(automatedLifecycle.supersede(db, existing, BASIS).status).toBe("applied");
      userDecisions.decide(db, existing, "approve");
      expect(lines(existing).at(-1)?.reason).toBe("accepted-without-current-evidence");
      expect(automatedLifecycle.supersede(db, existing, BASIS)).toEqual({
        status: "refused",
        reason: "user-override",
      });
      expect(state(existing)?.status).toBe("verified");
      userDecisions.undo(db, existing);
      // cancelled: it is the propagation's row again and the evidence return restores it
      expect(automatedLifecycle.evidenceReturned(db, existing, BASIS).status).toBe("applied");
      expect(state(existing)).toEqual({ status: "candidate", epistemic: "explicit" });
    });

    it("a rejected row with only past evidence", () => {
      const owner = newItem();
      const existing = extracted(owner, "2026-12-05", "candidate");
      const external = cite(existing);
      userDecisions.decide(db, existing, "reject");
      saveSourceRecord(db, "c1", { externalId: external, title: "t", body: "xyz" });
      userDecisions.decide(db, existing, "approve");
      expect(lines(existing).at(-1)?.reason).toBe("accepted-without-current-evidence");
      expect(automatedLifecycle.supersede(db, existing, BASIS).status).toBe("refused");
      expect(state(existing)?.status).toBe("verified");
      userDecisions.undo(db, existing);
      expect(state(existing)?.status).toBe("rejected");
    });
  });

  it("the value of a row the user replaced is refused too, and its approval is the way back", () => {
    const owner = newItem();
    const old = extracted(owner, "2026-12-05", "verified");
    const r = replaced(old, "2026-12-20");
    expect(userDecisions.add(db, factEntry(owner, "2026-12-05"))).toEqual({
      status: "refused",
      reason: "value-exists",
      existing: old,
    });
    expect(userDecisions.decide(db, old, "approve").status).toBe("applied");
    // the fixed value's row stays verified (R7: only a cancel or a dispute and reject turns it back)
    expect(state(r.added)).toEqual({ status: "verified", epistemic: "user-approved" });
  });
});

describe("the user entry", () => {
  it("has the four row calls and the `ontology` member with its three operations (S01-T07)", () => {
    expect(Object.keys(userDecisions).sort()).toEqual([
      "add",
      "decide",
      "ontology",
      "replaceValue",
      "undo",
    ]);
    expect(Object.keys(userDecisions.ontology).sort()).toEqual(["change", "decide", "undo"]);
  });
});
