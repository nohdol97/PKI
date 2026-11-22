// S01-R5, R6, R11, R12: the lifecycle gate. `lifecycle.transitions` walks the whole table, the
// history lines `lifecycle.history` reads are the audit trail, and `epistemic.changes` covers the
// one automatic epistemic change. The oracle below is written out from the spec's tables, not
// read from the implementation's `TRANSITIONS`.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setStatusForTest } from "@pki/testkit";
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
  type Actor,
  type EntryKind,
  type EntryRef,
} from "./semantic-lifecycle.ts";
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
const ACTORS: Actor[] = ["user", "extraction", "propagation", "policy"];
const KINDS: EntryKind[] = ["item", "fact", "relation"];
const BASIS = { sourceId: 7, version: 3 };

const attrs = (
  status: KnowledgeStatus,
  epistemic: EpistemicType = "explicit",
): KnowledgeAttributes => ({
  epistemic,
  status,
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
});

let counter = 0;
/** A row of `kind` inserted at `status` (an INSERT is not gated), with no history. */
function row(
  kind: EntryKind,
  status: KnowledgeStatus,
  epistemic: EpistemicType = "explicit",
): EntryRef {
  counter++;
  const a = attrs(status, epistemic);
  const owner = insertItem(db, { type: "p", name: `item-${counter}`, ...a });
  if (kind === "item") return { kind, id: owner };
  if (kind === "fact") {
    return { kind, id: saveFact(db, { itemId: owner, kind: "k", value: `v${counter}`, ...a }).id };
  }
  return {
    kind,
    id: saveRelation(db, { subjectId: owner, type: "T", objectId: owner, ...a }).id,
  };
}

const TABLE = { item: "items", fact: "facts", relation: "relations" } as const;
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

let version = 0;
/** Gives the row evidence from a new version of a new source, and returns the version row id. */
function cite(ref: EntryRef): number {
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
  return id;
}

// the spec's R5 table: [from, to, who, kinds that take the row]
const FACT_OR_RELATION: EntryKind[] = ["fact", "relation"];
const TABLE_R5: [KnowledgeStatus, KnowledgeStatus, Actor, EntryKind[]][] = [
  ["candidate", "verified", "user", KINDS],
  ["candidate", "verified", "policy", FACT_OR_RELATION],
  ["candidate", "rejected", "user", KINDS],
  ["verified", "disputed", "user", KINDS],
  ["verified", "disputed", "policy", FACT_OR_RELATION],
  ["disputed", "verified", "user", KINDS],
  ["disputed", "rejected", "user", KINDS],
  ["superseded", "verified", "user", KINDS],
  ["rejected", "verified", "user", KINDS],
  ["candidate", "superseded", "propagation", FACT_OR_RELATION],
  ["verified", "superseded", "propagation", FACT_OR_RELATION],
  ["disputed", "superseded", "propagation", FACT_OR_RELATION],
  ["verified", "superseded", "user", FACT_OR_RELATION],
];

describe("lifecycle.transitions", () => {
  const cases = KINDS.flatMap((kind) =>
    STATUSES.flatMap((from) =>
      STATUSES.flatMap((to) => ACTORS.map((actor) => ({ kind, from, to, actor }))),
    ),
  );

  it.each(cases)(
    "$kind $from -> $to by $actor: applies only what the table lists, else refuses",
    ({ kind, from, to, actor }) => {
      const ref = row(kind, from);
      const listed = TABLE_R5.some(
        ([f, t, a, kinds]) => f === from && t === to && a === actor && kinds.includes(kind),
      );
      const outcome = applyTransition(db, ref, actor, to);
      if (from === to) {
        expect(outcome).toEqual({ status: "unchanged" });
      } else if (listed) {
        expect(outcome).toEqual({ status: "applied", seq: 1 });
        const stored = read(ref);
        expect(stored?.status).toBe(to);
        // only a user's approval changes the epistemic type (R7)
        expect(stored?.epistemic).toBe(
          actor === "user" && to === "verified" ? "user-approved" : "explicit",
        );
        expect(lines(ref)).toHaveLength(1);
        return;
      } else {
        expect(outcome).toEqual({ status: "refused", reason: "invalid-transition" });
      }
      expect(read(ref)).toMatchObject({ status: from, epistemic: "explicit" });
      expect(lines(ref)).toEqual([]); // a refusal and an unchanged call write nothing
    },
  );

  it("takes an item only on the user's rows: no propagation, no policy", () => {
    const item = row("item", "candidate");
    expect(automatedLifecycle.supersede(db, item, BASIS)).toEqual({
      status: "refused",
      reason: "invalid-transition",
    });
    expect(applyTransition(db, item, "policy", "verified")).toEqual({
      status: "refused",
      reason: "invalid-transition",
    });
    expect(applyTransition(db, item, "user", "verified").status).toBe("applied");
  });

  it("refuses a row that does not exist", () => {
    expect(applyTransition(db, { kind: "fact", id: 404 }, "user", "verified")).toEqual({
      status: "refused",
      reason: "not-found",
    });
    expect(automatedLifecycle.supersede(db, { kind: "fact", id: 404 }, BASIS)).toEqual({
      status: "refused",
      reason: "not-found",
    });
  });

  describe("a policy dispute", () => {
    it("needs the source version it rests on", () => {
      const fact = row("fact", "verified", "user-approved");
      expect(automatedLifecycle.raiseDispute(db, fact, null)).toEqual({
        status: "refused",
        reason: "basis-required",
      });
      expect(read(fact)?.status).toBe("verified");
      expect(lines(fact)).toEqual([]);
    });

    it("moves a verified fact to disputed, keeps its epistemic type, and writes the basis and actor policy", () => {
      const fact = row("fact", "verified", "user-approved");
      expect(automatedLifecycle.raiseDispute(db, fact, BASIS)).toEqual({
        status: "applied",
        seq: 1,
      });
      expect(read(fact)).toMatchObject({ status: "disputed", epistemic: "user-approved" });
      expect(lines(fact)).toMatchObject([
        {
          actor: "policy",
          basis_source_id: 7,
          basis_version: 3,
          from_status: "verified",
          to_status: "disputed",
        },
      ]);
    });

    it("is refused on any other status", () => {
      const fact = row("fact", "candidate");
      expect(automatedLifecycle.raiseDispute(db, fact, BASIS)).toEqual({
        status: "refused",
        reason: "invalid-transition",
      });
    });
  });

  describe("restoring by returned evidence (R5, R12)", () => {
    const restored = (before: KnowledgeStatus, epistemic: EpistemicType) => {
      const ref = row("fact", before, epistemic);
      expect(automatedLifecycle.supersede(db, ref, BASIS).status).toBe("applied");
      expect(read(ref)?.status).toBe("superseded");
      return {
        ref,
        outcome: automatedLifecycle.evidenceReturned(db, ref, { sourceId: 7, version: 4 }),
      };
    };

    it.each([
      ["candidate", "explicit"],
      ["verified", "user-approved"],
      ["disputed", "inferred"],
      ["candidate", "hypothesis"],
    ] as const)(
      "brings a propagation-superseded %s/%s row back to exactly that state",
      (before, epistemic) => {
        const { ref, outcome } = restored(before, epistemic);
        expect(outcome).toEqual({ status: "applied", seq: 2 });
        expect(read(ref)).toMatchObject({ status: before, epistemic });
        expect(lines(ref)[1]).toMatchObject({
          actor: "extraction",
          from_status: "superseded",
          to_status: before,
          basis_source_id: 7,
          basis_version: 4,
          reverts_seq: 1, // names the propagation's supersede line it reverts (R6)
        });
      },
    );

    it("does not bring back a row the user superseded (a value fix): user-override, no line", () => {
      const ref = row("fact", "verified", "user-approved");
      applyTransition(db, ref, "user", "superseded");
      expect(automatedLifecycle.evidenceReturned(db, ref, BASIS)).toEqual({
        status: "refused",
        reason: "user-override",
      });
      expect(read(ref)?.status).toBe("superseded");
      expect(lines(ref)).toHaveLength(1);
    });

    it("brings a superseded row with no history (older than S01) back as a candidate, keeping its epistemic type", () => {
      const ref = row("relation", "superseded", "hypothesis");
      expect(automatedLifecycle.evidenceReturned(db, ref, BASIS)).toEqual({
        status: "applied",
        seq: 1,
      });
      expect(read(ref)).toMatchObject({ status: "candidate", epistemic: "hypothesis" });
    });

    it("refuses a superseded row whose newest line is no propagation supersede (not the user's, not a restore)", () => {
      const ref = row("fact", "superseded");
      automatedLifecycle.created(db, ref, "extraction", null);
      expect(automatedLifecycle.evidenceReturned(db, ref, BASIS)).toEqual({
        status: "refused",
        reason: "invalid-transition",
      });
    });

    it.each(["candidate", "verified", "disputed", "rejected"] as const)(
      "leaves a %s row alone: unchanged, no line",
      (status) => {
        const ref = row("fact", status);
        expect(automatedLifecycle.evidenceReturned(db, ref, BASIS)).toEqual({
          status: "unchanged",
        });
        expect(read(ref)?.status).toBe(status);
        expect(lines(ref)).toEqual([]);
      },
    );

    it("refuses an item (it holds no evidence)", () => {
      const item = row("item", "candidate");
      expect(automatedLifecycle.evidenceReturned(db, item, BASIS)).toEqual({
        status: "refused",
        reason: "invalid-transition",
      });
    });

    /** Writes the lines a cancellation (S01-T02) would, so the gate's reading of them is fixed now. */
    const forge = (
      ref: EntryRef,
      seq: number,
      actor: Actor,
      action: string,
      from: KnowledgeStatus,
      to: KnowledgeStatus,
      revertsSeq: number | null = null,
    ) => {
      db.run(
        `INSERT INTO ${HISTORY[ref.kind]} (${FK[ref.kind]}, seq, at, actor, action, from_status, to_status,
           from_epistemic, to_epistemic, reverts_seq)
         VALUES (?, ?, '2026-11-22T00:00:00Z', ?, ?, ?, ?, 'explicit', 'explicit', ?)`,
        [ref.id, seq, actor, action, from, to, revertsSeq],
      );
      db.run(`UPDATE ${TABLE[ref.kind]} SET status = ? WHERE id = ?`, [to, ref.id]);
    };

    it("reads a cancellation as the line before the action it reverted: propagation's supersede restores", () => {
      const ref = row("fact", "candidate");
      forge(ref, 1, "propagation", "supersede", "candidate", "superseded");
      forge(ref, 2, "user", "approve", "superseded", "verified");
      forge(ref, 3, "user", "undo", "verified", "superseded", 2);
      expect(automatedLifecycle.evidenceReturned(db, ref, BASIS)).toEqual({
        status: "applied",
        seq: 4,
      });
      expect(read(ref)?.status).toBe("candidate"); // before the propagation's supersede, not before the user's approval
      expect(lines(ref).at(-1)).toMatchObject({ action: "evidence-returned", reverts_seq: 1 });
    });

    it("reads a cancellation as the line before the action it reverted: a user's supersede does not", () => {
      const ref = row("fact", "verified");
      forge(ref, 1, "user", "replace", "verified", "superseded");
      forge(ref, 2, "user", "approve", "superseded", "verified");
      forge(ref, 3, "user", "undo", "verified", "superseded", 2);
      expect(automatedLifecycle.evidenceReturned(db, ref, BASIS)).toEqual({
        status: "refused",
        reason: "user-override",
      });
    });

    it("follows a cancellation of a cancellation back to the line that made the state", () => {
      const ref = row("fact", "candidate");
      forge(ref, 1, "propagation", "supersede", "candidate", "superseded");
      forge(ref, 2, "user", "approve", "superseded", "verified");
      forge(ref, 3, "user", "undo", "verified", "superseded", 2); // superseded by line 1's state
      forge(ref, 4, "user", "approve", "superseded", "verified");
      forge(ref, 5, "user", "undo", "verified", "superseded", 4); // made by line 3, which is made by line 1
      expect(automatedLifecycle.evidenceReturned(db, ref, BASIS).status).toBe("applied");
      expect(read(ref)?.status).toBe("candidate");
      expect(lines(ref).at(-1)).toMatchObject({ action: "evidence-returned", reverts_seq: 1 });
    });
  });
});

describe("lifecycle.history", () => {
  it("writes one line per change, numbered 1, 2, 3, with actor, states, reason and basis", () => {
    const fact = row("fact", "candidate");
    automatedLifecycle.created(
      db,
      fact,
      "extraction",
      { sourceId: 1, version: 1 },
      "2026-11-22T01:00:00.000Z",
    );
    expect(
      automatedLifecycle.supersede(
        db,
        fact,
        { sourceId: 1, version: 2 },
        "2026-11-22T02:00:00.000Z",
      ),
    ).toEqual({
      status: "applied",
      seq: 2,
    });
    automatedLifecycle.evidenceReturned(
      db,
      fact,
      { sourceId: 1, version: 3 },
      "2026-11-22T03:00:00.000Z",
    );
    applyTransition(db, fact, "user", "verified", { at: "2026-11-22T04:00:00.000Z" });
    expect(lines(fact)).toEqual([
      {
        fact_id: fact.id,
        seq: 1,
        at: "2026-11-22T01:00:00.000Z",
        actor: "extraction",
        action: "created",
        from_status: null,
        to_status: "candidate",
        from_epistemic: null,
        to_epistemic: "explicit",
        reason: null,
        basis_source_id: 1,
        basis_version: 1,
        batch: null,
        reverts_seq: null,
      },
      {
        fact_id: fact.id,
        seq: 2,
        at: "2026-11-22T02:00:00.000Z",
        actor: "propagation",
        action: "supersede",
        from_status: "candidate",
        to_status: "superseded",
        from_epistemic: "explicit",
        to_epistemic: "explicit",
        reason: "no-current-evidence",
        basis_source_id: 1,
        basis_version: 2,
        batch: null,
        reverts_seq: null,
      },
      {
        fact_id: fact.id,
        seq: 3,
        at: "2026-11-22T03:00:00.000Z",
        actor: "extraction",
        action: "evidence-returned",
        from_status: "superseded",
        to_status: "candidate",
        from_epistemic: "explicit",
        to_epistemic: "explicit",
        reason: null,
        basis_source_id: 1,
        basis_version: 3,
        batch: null,
        reverts_seq: 2,
      },
      {
        fact_id: fact.id,
        seq: 4,
        at: "2026-11-22T04:00:00.000Z",
        actor: "user",
        action: "approve",
        from_status: "candidate",
        to_status: "verified",
        from_epistemic: "explicit",
        to_epistemic: "user-approved",
        reason: "accepted-without-current-evidence",
        basis_source_id: null,
        basis_version: null,
        batch: null,
        reverts_seq: null,
      },
    ]);
  });

  it("numbers each row's lines on their own, and a creation line has no earlier state", () => {
    const [a, b] = [row("fact", "candidate"), row("relation", "candidate")] as [EntryRef, EntryRef];
    automatedLifecycle.created(db, a, "extraction", null);
    automatedLifecycle.created(db, b, "extraction", null);
    applyTransition(db, a, "user", "rejected");
    expect(lines(a).map((l) => l.seq)).toEqual([1, 2]);
    expect(lines(b).map((l) => l.seq)).toEqual([1]);
    expect(lines(b)[0]).toMatchObject({
      from_status: null,
      from_epistemic: null,
      basis_source_id: null,
    });
  });

  it("stamps a line from the clock when none is given", () => {
    const ref = row("fact", "candidate");
    applyTransition(db, ref, "user", "rejected");
    expect(lines(ref)[0]?.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it("gives an approval the reason accepted-without-current-evidence only for a fact or relation with no current evidence", () => {
    const reasonOf = (ref: EntryRef) => lines(ref)[0]?.reason;
    const noEvidence = row("fact", "candidate");
    const withEvidence = row("fact", "candidate");
    cite(withEvidence);
    const relationNone = row("relation", "disputed");
    const relationCurrent = row("relation", "rejected");
    cite(relationCurrent);
    const item = row("item", "candidate");
    for (const ref of [noEvidence, withEvidence, relationNone, relationCurrent, item]) {
      expect(applyTransition(db, ref, "user", "verified").status).toBe("applied");
    }
    expect(reasonOf(noEvidence)).toBe("accepted-without-current-evidence");
    expect(reasonOf(withEvidence)).toBeNull();
    expect(reasonOf(relationNone)).toBe("accepted-without-current-evidence");
    expect(reasonOf(relationCurrent)).toBeNull();
    expect(reasonOf(item)).toBeNull();
  });

  it("counts evidence of a version a newer one replaced as past, so an approval on it has no current evidence", () => {
    const fact = row("fact", "superseded");
    saveSourceRecord(db, "c1", { externalId: "replaced", title: "t", body: "abc" });
    const old = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
    addEvidence(db, {
      target: { factId: fact.id },
      sourceVersionId: old,
      start: 0,
      end: 1,
      quote: "a",
    });
    saveSourceRecord(db, "c1", { externalId: "replaced", title: "t", body: "abcd" }); // a newer version
    applyTransition(db, fact, "user", "verified");
    expect(lines(fact)[0]?.reason).toBe("accepted-without-current-evidence");
  });

  it("writes nothing for an unchanged call, and stops at a refusal", () => {
    const ref = row("fact", "verified");
    expect(automatedLifecycle.explicitEvidence(db, ref, BASIS)).toEqual({ status: "unchanged" });
    expect(automatedLifecycle.supersede(db, row("fact", "superseded"), BASIS)).toEqual({
      status: "unchanged",
    });
    expect(lines(ref)).toEqual([]);
  });

  it("goes with its row when the row is deleted", () => {
    const ref = row("fact", "candidate");
    applyTransition(db, ref, "user", "rejected");
    expect(lines(ref)).toHaveLength(1);
    db.run("DELETE FROM facts WHERE id = ?", [ref.id]);
    expect(lines(ref)).toEqual([]);
  });

  it("rolls back with the caller's transaction (the gate opens none)", () => {
    const ref = row("fact", "candidate");
    expect(() =>
      db.transaction(() => {
        applyTransition(db, ref, "user", "rejected");
        throw new Error("the caller fails after the gate");
      }),
    ).toThrow(/the caller fails/);
    expect(read(ref)?.status).toBe("candidate");
    expect(lines(ref)).toEqual([]);
  });

  it("holds none of the row's text in any column of any line", () => {
    const canary = ["QZ-name-canary", "QZ-value-canary", "QZ-quote-canary"] as const;
    const owner = insertItem(db, { type: "p", name: canary[0], ...attrs("candidate") });
    const fact = {
      kind: "fact",
      id: saveFact(db, { itemId: owner, kind: "k", value: canary[1], ...attrs("candidate") }).id,
    } as const;
    saveSourceRecord(db, "c1", { externalId: "canary", title: "t", body: canary[2] });
    const versionId = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
    addEvidence(db, {
      target: { factId: fact.id },
      sourceVersionId: versionId,
      start: 0,
      end: canary[2].length,
      quote: canary[2],
    });
    automatedLifecycle.created(db, { kind: "item", id: owner }, "extraction", BASIS);
    automatedLifecycle.created(db, fact, "extraction", BASIS);
    automatedLifecycle.supersede(db, fact, BASIS);
    automatedLifecycle.evidenceReturned(db, fact, BASIS);
    applyTransition(db, fact, "user", "verified");
    applyTransition(db, { kind: "item", id: owner }, "user", "rejected");
    const dump = JSON.stringify(HISTORY_TABLES.flatMap((t) => db.all(`SELECT * FROM ${t}`)));
    expect(dump).toContain("supersede"); // the dump holds lines
    for (const text of canary) expect(dump).not.toContain(text);
  });
});

const HISTORY_TABLES = ["item_history", "fact_history", "relation_history"];

describe("epistemic.changes (the gate side)", () => {
  it("lifts a hypothesis row to explicit on explicit evidence, keeps its status, and writes a line", () => {
    for (const status of ["candidate", "verified", "rejected"] as const) {
      const fact = row("fact", status, "hypothesis");
      expect(automatedLifecycle.explicitEvidence(db, fact, BASIS)).toEqual({
        status: "applied",
        seq: 1,
      });
      expect(read(fact)).toMatchObject({ status, epistemic: "explicit" });
      expect(lines(fact)[0]).toMatchObject({
        actor: "extraction",
        from_status: status,
        to_status: status,
        from_epistemic: "hypothesis",
        to_epistemic: "explicit",
        basis_source_id: 7,
      });
    }
  });

  it("leaves explicit, inferred and user-approved rows alone, and never lowers an epistemic type", () => {
    for (const epistemic of ["explicit", "inferred", "user-approved"] as const) {
      const relation = row("relation", "candidate", epistemic);
      expect(automatedLifecycle.explicitEvidence(db, relation, BASIS)).toEqual({
        status: "unchanged",
      });
      expect(read(relation)?.epistemic).toBe(epistemic);
      expect(lines(relation)).toEqual([]);
    }
  });

  it("is refused on an item", () => {
    expect(
      automatedLifecycle.explicitEvidence(db, row("item", "candidate", "hypothesis"), BASIS),
    ).toEqual({
      status: "refused",
      reason: "invalid-transition",
    });
  });
});

describe("the testkit status seed", () => {
  it("passes the schema gate by writing the line first, numbering lines on, and keeps the epistemic type", () => {
    const fact = row("fact", "candidate", "hypothesis");
    setStatusForTest(db, "fact", fact.id, "rejected");
    setStatusForTest(db, "fact", fact.id, "superseded", "propagation");
    expect(read(fact)).toMatchObject({ status: "superseded", epistemic: "hypothesis" });
    expect(lines(fact).map((l) => [l.seq, l.actor, l.from_status, l.to_status])).toEqual([
      [1, "user", "candidate", "rejected"],
      [2, "propagation", "rejected", "superseded"],
    ]);
    // a restore treats it as the propagation's supersede it says it is
    expect(automatedLifecycle.evidenceReturned(db, fact, BASIS).status).toBe("applied");
    expect(read(fact)?.status).toBe("rejected");
  });

  it("refuses a row that does not exist", () => {
    expect(() => setStatusForTest(db, "item", 404, "verified")).toThrow(/not found/);
  });
});
