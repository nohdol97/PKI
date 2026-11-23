// S01-T05 `autoverify.conditions` (S01-R9, C1) and the judgement part of `epistemic.confidence-independent`
// (R10, C2): the policy promotes a candidate fact or relation to verified only when all five conditions
// hold, says which did not, takes the promotion back when the independent sources or the single value
// are lost, and never reads confidence. The gate's own protections (the user's rows, the items) are
// seen here from the judgement's side; every state the user is in comes from the real user entry.
// The setting defaults OFF: with it off nothing is written. All data is synthetic.
import {
  addEvidence,
  automatedLifecycle,
  findSourceVersionId,
  insertItem,
  listOntologyElements,
  migrate,
  readFact,
  readRelation,
  registerConnectorInstance,
  saveFact,
  saveRelation,
  saveSourceRecord,
  userDecisions,
  writeSetting,
  type EntryRef,
  type EvidenceTarget,
  type KnowledgeAttributes,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { setOntologyStatusForTest, setStatusForTest } from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTO_VERIFY_SETTING,
  assessAfterExtraction,
  assessAfterPropagation,
  assessAfterUserAction,
  assessAutoVerify,
  readAutoVerify,
} from "./auto-verify.ts";
import { DEPENDENCY_DELAY, DEPENDS_ON, recomputeDependencyDelay } from "./dependency-delay.ts";

const T = "2026-11-23T00:00:00.000Z";
const DATE = "2026-12-01";
const OTHER_DATE = "2026-12-09";

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "imported", "jsonl-import");
});
afterEach(() => db.close());

const enable = (on = true) => writeSetting(db, AUTO_VERIFY_SETTING, on ? "on" : "off");

/** Stores a version of the source `externalId` and returns its ids. */
function version(externalId: string, body: string) {
  const saved = saveSourceRecord(db, "imported", { externalId, title: "t", body });
  if (saved.status !== "created") throw new Error("expected a new version");
  const versionId = findSourceVersionId(db, saved.sourceId, saved.version) as number;
  return { sourceId: saved.sourceId, versionId, body };
}
/** Evidence of `target` quoting `quote` in the version (ASCII, so offsets are code points). */
function cite(target: EvidenceTarget, v: { versionId: number; body: string }, quote: string) {
  const start = v.body.indexOf(quote);
  if (start < 0) throw new Error("quote not in body");
  addEvidence(db, {
    target,
    sourceVersionId: v.versionId,
    start,
    end: start + quote.length,
    quote,
  });
}

const attrs = (over: Partial<KnowledgeAttributes> = {}): KnowledgeAttributes => ({
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: T,
  ...over,
});
const project = (name: string) => insertItem(db, { type: "Project", name, ...attrs() });

interface FactOptions {
  kind?: string;
  value?: string;
  attributes?: Partial<KnowledgeAttributes>;
}
/** A candidate fact with its creation line, as extraction leaves it. */
function fact(
  itemId: number,
  { kind = "target_date", value = DATE, attributes }: FactOptions = {},
) {
  const saved = saveFact(db, { itemId, kind, value, ...attrs(attributes) });
  const ref: EntryRef = { kind: "fact", id: saved.id };
  automatedLifecycle.created(db, ref, "extraction", null, T);
  return ref;
}
const cited = (ref: EntryRef, ...sources: { versionId: number; body: string }[]) => {
  for (const s of sources) cite({ factId: ref.id }, s, DATE);
};
const BODY = (tag: string) => `${tag} says the date is ${DATE} for the project`;
const twoSources = (tag = "") => [
  version(`a${tag}`, BODY(`alpha${tag}`)),
  version(`b${tag}`, BODY(`beta${tag}`)),
];

/** A fact that satisfies all five conditions (`tag` keeps the sources of a second one apart). */
function qualifying(over: FactOptions = {}, tag = "") {
  const item = project(`Alpha${tag}`);
  const ref = fact(item, over);
  cited(ref, ...twoSources(tag));
  return { item, ref };
}

const lines = (ref: EntryRef) =>
  db.all(
    `SELECT seq, actor, action, from_status, to_status, from_epistemic, to_epistemic, reason, reverts_seq
     FROM ${ref.kind}_history WHERE ${ref.kind}_id = ? ORDER BY seq`,
    [ref.id],
  );
const state = (ref: EntryRef) =>
  (ref.kind === "fact" ? readFact(db, ref.id) : readRelation(db, ref.id)) as {
    status: string;
    epistemic: string;
    confidence: number | null;
  };
const dump = () => ({
  facts: db.all("SELECT * FROM facts ORDER BY id"),
  history: db.all("SELECT * FROM fact_history ORDER BY fact_id, seq"),
  relations: db.all("SELECT * FROM relations ORDER BY id"),
  relationHistory: db.all("SELECT * FROM relation_history ORDER BY relation_id, seq"),
});
const unmet = (...conditions: string[]) => ({
  status: "refused",
  reason: "auto-verify-unmet",
  unmet: conditions,
});

describe("the setting (S01-R9 1, provisional decision 3)", () => {
  it("is named semantic.autoVerify and reads off until it is exactly 'on'", () => {
    expect(AUTO_VERIFY_SETTING).toBe("semantic.autoVerify");
    expect(readAutoVerify(db)).toBe(false);
    for (const value of ["off", "ON", "true", "1", ""]) {
      writeSetting(db, AUTO_VERIFY_SETTING, value);
      expect(readAutoVerify(db)).toBe(false);
    }
    writeSetting(db, AUTO_VERIFY_SETTING, "on");
    expect(readAutoVerify(db)).toBe(true);
  });

  it("OFF (the default): a row that meets every other condition is not promoted and nothing is written", () => {
    const { ref } = qualifying();
    const before = dump();
    expect(assessAutoVerify(db, ref, T)).toEqual(unmet("disabled"));
    enable(false);
    expect(assessAutoVerify(db, ref, T)).toEqual(unmet("disabled"));
    expect(dump()).toEqual(before);
    expect(state(ref)).toMatchObject({ status: "candidate" });
  });

  it("OFF after ON: nothing is promoted, but a row the policy promoted is taken back when it loses condition 3 (R9, review M1)", () => {
    enable();
    const { ref } = qualifying();
    expect(assessAutoVerify(db, ref, T)).toMatchObject({ status: "applied" });
    enable(false);
    // grounds still hold: left as it is, no line
    const before = dump();
    expect(assessAutoVerify(db, ref, T)).toEqual({ status: "unchanged" });
    expect(dump()).toEqual(before);
    db.run("DELETE FROM evidence WHERE fact_id = ? AND id = (SELECT max(id) FROM evidence)", [
      ref.id,
    ]);
    expect(assessAutoVerify(db, ref, T)).toMatchObject({ status: "applied" });
    expect(state(ref).status).toBe("candidate");
    expect(lines(ref).at(-1)).toMatchObject({
      actor: "policy",
      action: "auto-verify-reverted",
      reason: "independent-sources",
    });
  });

  it("OFF after ON: a candidate that meets every condition is still not promoted", () => {
    enable(false);
    const { ref } = qualifying();
    expect(assessAutoVerify(db, ref, T)).toEqual(unmet("disabled"));
    expect(state(ref).status).toBe("candidate");
  });

  it("OFF after ON: a verified row the policy did not promote, or the user decided, is never reverted", () => {
    enable(false);
    const { ref } = qualifying();
    userDecisions.decide(db, ref, "approve");
    db.run("DELETE FROM evidence");
    expect(assessAutoVerify(db, ref, T)).toEqual({ status: "refused", reason: "user-override" });
  });

  it("the three hooks restore under OFF-after-ON through the propagation and user-action calls", () => {
    enable();
    const { item, ref } = qualifying();
    assessAutoVerify(db, ref, T);
    enable(false);
    db.run("DELETE FROM evidence WHERE fact_id = ? AND id = (SELECT max(id) FROM evidence)", [
      ref.id,
    ]);
    assessAfterPropagation(db, { itemIds: [item], relationIds: [] }, T);
    expect(state(ref).status).toBe("candidate");
  });
});

describe("with the setting off the hooks only read the setting (dark launch)", () => {
  /** The driver with every statement it is handed recorded. */
  function spied() {
    const sql: string[] = [];
    const tx = new Proxy(db, {
      get(target, name, receiver) {
        const member = Reflect.get(target, name, receiver) as unknown;
        if ((name === "all" || name === "run") && typeof member === "function") {
          return (text: string, params?: unknown[]) => {
            sql.push(text);
            return (member as (...a: unknown[]) => unknown).call(target, text, params);
          };
        }
        return member;
      },
    });
    return { tx, sql };
  }

  it("with the key never written no hook (extraction, propagation, user action) reads or writes a row", () => {
    const { ref } = qualifying();
    const { tx, sql } = spied();
    assessAfterExtraction(tx, { factIds: [ref.id], relationIds: [1] }, T);
    assessAfterPropagation(tx, { itemIds: [1], relationIds: [1] }, T);
    assessAfterUserAction(tx, { itemIds: [1], relationIds: [1] }, T);
    expect(sql).toHaveLength(3);
    expect(sql.every((text) => text.includes("FROM settings"))).toBe(true);
  });

  it("with it on the same calls do read rows", () => {
    enable();
    const { ref } = qualifying();
    const { tx, sql } = spied();
    assessAfterExtraction(tx, { factIds: [ref.id], relationIds: [] }, T);
    expect(sql.length).toBeGreaterThan(2);
  });
});

describe("promotion when all five conditions hold (S01-R9)", () => {
  it("promotes a fact: verified, epistemic and confidence as they were, one line by the policy", () => {
    enable();
    const { ref } = qualifying({ attributes: { confidence: 0.4 } });
    const outcome = assessAutoVerify(db, ref, T);
    expect(outcome).toEqual({ status: "applied", seq: 2 });
    expect(state(ref)).toMatchObject({
      status: "verified",
      epistemic: "explicit",
      confidence: 0.4,
    });
    expect(lines(ref).at(-1)).toMatchObject({
      seq: 2,
      actor: "policy",
      action: "auto-verify",
      from_status: "candidate",
      to_status: "verified",
      from_epistemic: "explicit",
      to_epistemic: "explicit",
    });
  });

  it("promotes a relation (no value-count condition for a relation)", () => {
    enable();
    const x = project("X");
    const y = project("Y");
    const saved = saveRelation(db, { subjectId: x, type: DEPENDS_ON, objectId: y, ...attrs() });
    const ref: EntryRef = { kind: "relation", id: saved.id };
    automatedLifecycle.created(db, ref, "extraction", null, T);
    const [a, b] = twoSources() as [ReturnType<typeof version>, ReturnType<typeof version>];
    cite({ relationId: ref.id }, a, DATE);
    expect(assessAutoVerify(db, ref, T)).toEqual(unmet("independent-sources"));
    cite({ relationId: ref.id }, b, DATE);
    expect(assessAutoVerify(db, ref, T)).toMatchObject({ status: "applied" });
    expect(state(ref).status).toBe("verified");
  });

  it("a second assessment writes nothing (idempotent)", () => {
    enable();
    const { ref } = qualifying();
    assessAutoVerify(db, ref, T);
    const before = dump();
    expect(assessAutoVerify(db, ref, T)).toEqual({ status: "unchanged" });
    expect(dump()).toEqual(before);
  });

  it("a candidate that is refused stays untouched and says so again each time", () => {
    enable();
    const item = project("Alpha");
    const ref = fact(item);
    cited(ref, version("a", BODY("alpha")));
    const before = dump();
    expect(assessAutoVerify(db, ref, T)).toEqual(unmet("independent-sources"));
    expect(assessAutoVerify(db, ref, T)).toEqual(unmet("independent-sources"));
    expect(dump()).toEqual(before);
  });
});

describe("each condition alone fails with its own name (C1)", () => {
  it("2: a hypothesis is not promoted", () => {
    enable();
    const { ref } = qualifying({ attributes: { epistemic: "hypothesis" } });
    expect(assessAutoVerify(db, ref, T)).toEqual(unmet("not-explicit"));
    expect(state(ref)).toMatchObject({ status: "candidate", epistemic: "hypothesis" });
  });

  it("2: an inferred row is not promoted", () => {
    enable();
    const { ref } = qualifying({ attributes: { epistemic: "inferred" } });
    expect(assessAutoVerify(db, ref, T)).toEqual(unmet("not-explicit"));
  });

  it("3: one source is not enough", () => {
    enable();
    const item = project("Alpha");
    const ref = fact(item);
    cited(ref, version("a", BODY("alpha")));
    expect(assessAutoVerify(db, ref, T)).toEqual(unmet("independent-sources"));
  });

  it("3: two versions of one source are one source (the older is not even current)", () => {
    enable();
    const item = project("Alpha");
    const ref = fact(item);
    const first = version("a", BODY("alpha one"));
    const second = version("a", BODY("alpha two"));
    cited(ref, first, second);
    expect(assessAutoVerify(db, ref, T)).toEqual(unmet("independent-sources"));
  });

  it("3: two sources with the same content are one", () => {
    enable();
    const item = project("Alpha");
    const ref = fact(item);
    cited(ref, version("a", BODY("same")), version("b", BODY("same")));
    expect(assessAutoVerify(db, ref, T)).toEqual(unmet("independent-sources"));
  });

  it("3: a source a tombstone covers is not counted, a lifted one still covers its versions", () => {
    enable();
    const item = project("Alpha");
    const ref = fact(item);
    const a = version("a", BODY("alpha"));
    const b = version("b", BODY("beta"));
    cited(ref, a, b);
    db.run(
      "INSERT INTO tombstones (source_id, covers_version, at, reason) VALUES (?, 1, ?, 'user-deleted')",
      [b.sourceId, T],
    );
    expect(assessAutoVerify(db, ref, T)).toEqual(unmet("independent-sources"));
    db.run("UPDATE tombstones SET lifted_at = ?", [T]);
    expect(assessAutoVerify(db, ref, T)).toEqual(unmet("independent-sources"));
  });

  it("3: a row the user wrote is no evidence (a source count of zero says independent-sources)", () => {
    enable();
    const item = project("Alpha");
    const ref = fact(item);
    expect(assessAutoVerify(db, ref, T)).toEqual(unmet("independent-sources"));
  });

  it("4: a fact kind that is not a verified type definition", () => {
    enable();
    const item = project("Alpha");
    const ref = fact(item, { kind: "mystery_kind" });
    cited(ref, ...twoSources());
    expect(assessAutoVerify(db, ref, T)).toEqual(unmet("type-unverified"));
    // a known kind whose definition is retired or still a candidate is the same
    const element = listOntologyElements(db).find((e) => e.name === "completion_date");
    const known = fact(item, { kind: "completion_date", value: DATE });
    cited(known, version("c", BODY("gamma")), version("d", BODY("delta")));
    expect(assessAutoVerify(db, known, T)).toMatchObject({ status: "applied" });
    const other = fact(project("Beta"), { kind: "completion_date", value: DATE });
    cited(other, version("e", BODY("eps")), version("f", BODY("zeta")));
    setOntologyStatusForTest(db, (element as { id: number }).id, "superseded");
    expect(assessAutoVerify(db, other, T)).toEqual(unmet("type-unverified"));
    setOntologyStatusForTest(db, (element as { id: number }).id, "candidate");
    expect(assessAutoVerify(db, other, T)).toEqual(unmet("type-unverified"));
  });

  it("4: a relation type that is not a verified type definition", () => {
    enable();
    const x = project("X");
    const y = project("Y");
    const saved = saveRelation(db, { subjectId: x, type: "MYSTERY", objectId: y, ...attrs() });
    const ref: EntryRef = { kind: "relation", id: saved.id };
    automatedLifecycle.created(db, ref, "extraction", null, T);
    for (const v of twoSources()) cite({ relationId: ref.id }, v, DATE);
    expect(assessAutoVerify(db, ref, T)).toEqual(unmet("type-unverified"));
  });

  describe("5: a different value in a valid row of the same item and kind (cardinality one)", () => {
    const rival = (
      itemId: number,
      status: KnowledgeAttributes["status"],
      withEvidence = true,
      value = OTHER_DATE,
    ) => {
      const ref = fact(itemId, { value, attributes: { status } });
      if (withEvidence) cite({ factId: ref.id }, version(`r${ref.id}`, `rival ${value}`), value);
      return ref;
    };

    it("a candidate with current evidence blocks, and the promotion waits", () => {
      enable();
      const { item, ref } = qualifying();
      rival(item, "candidate");
      expect(assessAutoVerify(db, ref, T)).toEqual(unmet("conflicting-value"));
    });

    it("a verified or disputed rival blocks too", () => {
      enable();
      const { item, ref } = qualifying();
      rival(item, "disputed");
      expect(assessAutoVerify(db, ref, T)).toEqual(unmet("conflicting-value"));
    });

    it("a superseded or rejected rival does not, nor does one with no current evidence", () => {
      enable();
      const { item, ref } = qualifying();
      rival(item, "superseded");
      rival(item, "rejected", true, "2026-12-10");
      const bare = fact(item, { value: "2026-12-11" }); // candidate, no evidence: not valid
      expect(state(bare).status).toBe("candidate");
      expect(assessAutoVerify(db, ref, T)).toMatchObject({ status: "applied" });
    });

    it("a row the user wrote blocks even with no evidence (T04 hand-off 10), but not once it is retired", () => {
      enable();
      const { item, ref } = qualifying();
      const added = userDecisions.add(db, {
        kind: "fact",
        itemId: item,
        factKind: "target_date",
        value: OTHER_DATE,
      });
      expect(added.status).toBe("applied");
      expect(assessAutoVerify(db, ref, T)).toEqual(unmet("conflicting-value"));
      const authored = (added as { ref: EntryRef }).ref;
      expect(userDecisions.decide(db, authored, "dispute").status).toBe("applied");
      expect(userDecisions.decide(db, authored, "reject").status).toBe("applied");
      expect(assessAutoVerify(db, ref, T)).toMatchObject({ status: "applied" });
    });

    it("a user-approved row with no current evidence blocks", () => {
      enable();
      const { item, ref } = qualifying();
      const old = rival(item, "candidate", false);
      expect(userDecisions.decide(db, old, "approve").status).toBe("applied");
      expect(assessAutoVerify(db, ref, T)).toEqual(unmet("conflicting-value"));
    });

    it("a kind whose value count is many has no such condition", () => {
      enable();
      const concept = insertItem(db, { type: "Concept", name: "Term", ...attrs() });
      const a = fact(concept, { kind: "alias.synonym", value: DATE });
      const sources = twoSources();
      cited(a, ...sources);
      const b = fact(concept, { kind: "alias.synonym", value: OTHER_DATE });
      cite({ factId: b.id }, version("m", `m ${OTHER_DATE}`), OTHER_DATE);
      expect(assessAutoVerify(db, a, T)).toMatchObject({ status: "applied" });
    });

    it("the same value is the same row, never a conflict", () => {
      enable();
      const { ref } = qualifying();
      expect(assessAutoVerify(db, ref, T)).toMatchObject({ status: "applied" });
    });
  });

  it("several unmet conditions are all named, in the order of the spec", () => {
    enable();
    const item = project("Alpha");
    const ref = fact(item, { kind: "mystery_kind", attributes: { epistemic: "hypothesis" } });
    cited(ref, version("a", BODY("alpha")));
    expect(assessAutoVerify(db, ref, T)).toEqual(
      unmet("not-explicit", "independent-sources", "type-unverified"),
    );
    const item2 = project("Beta");
    const ref2 = fact(item2, { attributes: { epistemic: "hypothesis" } });
    cite({ factId: ref2.id }, version("q", BODY("q")), DATE);
    fact(item2, { value: OTHER_DATE }); // a rival with no evidence is not valid: only the first two stay unmet
    expect(assessAutoVerify(db, ref2, T)).toEqual(unmet("not-explicit", "independent-sources"));
  });
});

describe("what the policy never touches (S01-R9, R12, provisional decision 12)", () => {
  it("an item is never promoted (invalid-transition, nothing written)", () => {
    enable();
    const item = project("Alpha");
    const ref: EntryRef = { kind: "item", id: item };
    automatedLifecycle.created(db, ref, "extraction", null, T);
    const before = db.all("SELECT * FROM item_history");
    expect(assessAutoVerify(db, ref, T)).toEqual({
      status: "refused",
      reason: "invalid-transition",
    });
    expect(db.all("SELECT * FROM item_history")).toEqual(before);
    expect(db.all("SELECT status FROM items WHERE id = ?", [item])[0]).toEqual({
      status: "candidate",
    });
  });

  it("a row that is not stored is not-found", () => {
    enable();
    expect(assessAutoVerify(db, { kind: "fact", id: 999 }, T)).toEqual({
      status: "refused",
      reason: "not-found",
    });
  });

  it("a row the user decided is user-override before any condition is looked at", () => {
    enable();
    const item = project("Alpha");
    const ref = fact(item, { attributes: { epistemic: "hypothesis" } }); // conditions 2 and 3 fail too
    for (const action of ["approve", "reject"] as const) {
      const row = fact(item, { value: action === "approve" ? "2026-12-02" : "2026-12-03" });
      expect(userDecisions.decide(db, row, action).status).toBe("applied");
      const before = dump();
      expect(assessAutoVerify(db, row, T)).toEqual({ status: "refused", reason: "user-override" });
      expect(dump()).toEqual(before);
    }
    // the user's approved rows are valid values of their own, so the conflict is named too
    expect(assessAutoVerify(db, ref, T)).toEqual(
      unmet("not-explicit", "independent-sources", "conflicting-value"),
    );
  });

  it("a row the user wrote is user-override", () => {
    enable();
    const item = project("Alpha");
    const added = userDecisions.add(db, {
      kind: "fact",
      itemId: item,
      factKind: "target_date",
      value: DATE,
    }) as { ref: EntryRef };
    expect(assessAutoVerify(db, added.ref, T)).toEqual({
      status: "refused",
      reason: "user-override",
    });
  });

  it("a user-decided row stays user-override when the setting is off (nothing to say about conditions)", () => {
    const { ref } = qualifying();
    userDecisions.decide(db, ref, "approve");
    expect(assessAutoVerify(db, ref, T)).toEqual({ status: "refused", reason: "user-override" });
  });

  it("a user action that was cancelled no longer protects the row", () => {
    enable();
    const { ref } = qualifying();
    userDecisions.decide(db, ref, "approve");
    expect(userDecisions.undo(db, ref).status).toBe("applied");
    expect(assessAutoVerify(db, ref, T)).toMatchObject({ status: "applied" });
  });

  it("a disputed, superseded or rejected row is left alone", () => {
    enable();
    for (const status of ["disputed", "superseded", "rejected"] as const) {
      const { ref } = qualifying({ value: DATE }, status);
      setStatusForTest(db, "fact", ref.id, status, "extraction");
      const before = dump();
      expect(assessAutoVerify(db, ref, T)).toEqual({ status: "unchanged" });
      expect(dump()).toEqual(before);
    }
  });
});

describe("confidence is not a condition (R10, C2 `epistemic.confidence-independent`)", () => {
  it.each([null, 0, 0.01, 0.99, 1])(
    "a row with confidence %s promotes when the conditions hold",
    (c) => {
      enable();
      const { ref } = qualifying({ attributes: c === null ? {} : { confidence: c } });
      expect(assessAutoVerify(db, ref, T)).toMatchObject({ status: "applied" });
      expect(state(ref).confidence).toBe(c);
    },
  );

  it.each([null, 0, 1])("a row with confidence %s does not promote when a condition fails", (c) => {
    enable();
    const item = project("Alpha");
    const ref = fact(item, { attributes: c === null ? {} : { confidence: c } });
    cited(ref, version("a", BODY("alpha"))); // one source only
    expect(assessAutoVerify(db, ref, T)).toEqual(unmet("independent-sources"));
    expect(state(ref).status).toBe("candidate");
    expect(state(ref).confidence).toBe(c);
  });

  it("two rows that differ only in confidence get the same answer, qualifying or not", () => {
    enable();
    const low = qualifying({ attributes: { confidence: 0.01 } }, "-low");
    const high = qualifying({ attributes: { confidence: 0.99 } }, "-high");
    const [lowOut, highOut] = [low.ref, high.ref].map((r) => assessAutoVerify(db, r, T));
    expect(lowOut).toMatchObject({ status: "applied", seq: 2 });
    expect(highOut).toMatchObject({ status: "applied", seq: 2 });
    const bare = (confidence: number) => {
      const ref = fact(project(`Bare${confidence}`), { attributes: { confidence } });
      cite({ factId: ref.id }, version(`s${confidence}`, BODY(`s${confidence}`)), DATE);
      return assessAutoVerify(db, ref, T);
    };
    expect(bare(0.01)).toEqual(bare(0.99));
  });

  it("a restore does not change confidence either", () => {
    enable();
    const { ref } = qualifying({ attributes: { confidence: 0.7 } });
    assessAutoVerify(db, ref, T);
    db.run("DELETE FROM evidence WHERE id = (SELECT max(id) FROM evidence)");
    expect(assessAutoVerify(db, ref, T)).toMatchObject({ status: "applied" });
    expect(state(ref)).toMatchObject({ status: "candidate", confidence: 0.7 });
  });
});

describe("a promotion is taken back when a condition is lost (R9, R5 restore)", () => {
  it("3: an evidence row of one source gone: back to candidate with the line the spec names", () => {
    enable();
    const { ref } = qualifying();
    assessAutoVerify(db, ref, T);
    db.run("DELETE FROM evidence WHERE id = (SELECT max(id) FROM evidence)");
    expect(assessAutoVerify(db, ref, T)).toEqual({ status: "applied", seq: 3 });
    expect(state(ref)).toMatchObject({ status: "candidate", epistemic: "explicit" });
    expect(lines(ref).at(-1)).toEqual({
      seq: 3,
      actor: "policy",
      action: "auto-verify-reverted",
      from_status: "verified",
      to_status: "candidate",
      from_epistemic: "explicit",
      to_epistemic: "explicit",
      reason: "independent-sources",
      reverts_seq: 2,
    });
  });

  it("3: a new version of one source that no longer says it leaves one current source", () => {
    enable();
    const item = project("Alpha");
    const ref = fact(item);
    const [a, b] = twoSources() as [ReturnType<typeof version>, ReturnType<typeof version>];
    cited(ref, a, b);
    assessAutoVerify(db, ref, T);
    version("b", "beta now says something else"); // b's evidence is no longer current
    expect(assessAutoVerify(db, ref, T)).toMatchObject({ status: "applied" });
    expect(lines(ref).at(-1)).toMatchObject({ reason: "independent-sources" });
    expect(state(ref).status).toBe("candidate");
  });

  it("5: a valid row with another value appears: back to candidate, reason conflicting-value", () => {
    enable();
    const { item, ref } = qualifying();
    assessAutoVerify(db, ref, T);
    const rival = fact(item, { value: OTHER_DATE });
    cite({ factId: rival.id }, version("r", `rival ${OTHER_DATE}`), OTHER_DATE);
    expect(assessAutoVerify(db, ref, T)).toMatchObject({ status: "applied" });
    expect(state(ref).status).toBe("candidate");
    expect(lines(ref).at(-1)).toMatchObject({
      actor: "policy",
      action: "auto-verify-reverted",
      reason: "conflicting-value",
      reverts_seq: 2,
    });
  });

  it("a condition that is still met leaves the promotion in place", () => {
    enable();
    const { ref } = qualifying();
    assessAutoVerify(db, ref, T);
    const before = dump();
    expect(assessAutoVerify(db, ref, T)).toEqual({ status: "unchanged" });
    expect(dump()).toEqual(before);
  });

  it("the restore is not undone by a second assessment and a regained condition promotes again", () => {
    enable();
    const { ref } = qualifying();
    assessAutoVerify(db, ref, T);
    db.run("DELETE FROM evidence WHERE id = (SELECT max(id) FROM evidence)");
    assessAutoVerify(db, ref, T);
    const reverted = lines(ref).length;
    expect(assessAutoVerify(db, ref, T)).toEqual(unmet("independent-sources"));
    expect(lines(ref)).toHaveLength(reverted);
    cite({ factId: ref.id }, version("c", BODY("gamma")), DATE);
    expect(assessAutoVerify(db, ref, T)).toMatchObject({ status: "applied" });
    expect(lines(ref).map((l) => l.action)).toEqual([
      "created",
      "auto-verify",
      "auto-verify-reverted",
      "auto-verify",
    ]);
  });

  it("a verified row the policy did not promote is never taken back", () => {
    enable();
    const { item, ref } = qualifying();
    // verified by an extraction-side line, as a state the policy has no part in
    db.run(
      `INSERT INTO fact_history (fact_id, seq, at, actor, action, from_status, to_status, from_epistemic, to_epistemic)
       VALUES (?, 2, ?, 'extraction', 'test-set', 'candidate', 'verified', 'explicit', 'explicit')`,
      [ref.id, T],
    );
    db.run("UPDATE facts SET status = 'verified' WHERE id = ?", [ref.id]);
    const rival = fact(item, { value: OTHER_DATE });
    cite({ factId: rival.id }, version("r", `rival ${OTHER_DATE}`), OTHER_DATE);
    const before = dump();
    expect(assessAutoVerify(db, ref, T)).toEqual({ status: "unchanged" });
    expect(dump()).toEqual(before);
  });

  it("a promotion that survives a supersede and the evidence's return is still the policy's to take back", () => {
    enable();
    const { ref } = qualifying();
    assessAutoVerify(db, ref, T);
    const basis = { sourceId: 1, version: 2 };
    expect(automatedLifecycle.supersede(db, ref, basis, T).status).toBe("applied");
    expect(state(ref).status).toBe("superseded");
    expect(automatedLifecycle.evidenceReturned(db, ref, basis, T).status).toBe("applied");
    expect(state(ref).status).toBe("verified");
    db.run("DELETE FROM evidence WHERE id = (SELECT max(id) FROM evidence)");
    expect(assessAutoVerify(db, ref, T)).toMatchObject({ status: "applied" });
    expect(state(ref).status).toBe("candidate");
  });

  it("a row the user then approved is never taken back (user-override, no line)", () => {
    enable();
    const { ref } = qualifying();
    assessAutoVerify(db, ref, T);
    expect(userDecisions.decide(db, ref, "approve").status).toBe("applied"); // not `unchanged`
    expect(state(ref)).toMatchObject({ status: "verified", epistemic: "user-approved" });
    db.run("DELETE FROM evidence WHERE id = (SELECT max(id) FROM evidence)");
    const before = dump();
    expect(assessAutoVerify(db, ref, T)).toEqual({ status: "refused", reason: "user-override" });
    expect(dump()).toEqual(before);
  });

  it("cancelling that approval gives the row back to the policy, epistemic as it was", () => {
    enable();
    const { ref } = qualifying();
    assessAutoVerify(db, ref, T);
    userDecisions.decide(db, ref, "approve");
    expect(userDecisions.undo(db, ref).status).toBe("applied");
    expect(state(ref)).toMatchObject({ status: "verified", epistemic: "explicit" });
    db.run("DELETE FROM evidence WHERE id = (SELECT max(id) FROM evidence)");
    expect(assessAutoVerify(db, ref, T)).toMatchObject({ status: "applied" });
    expect(state(ref).status).toBe("candidate");
  });

  it("approving a row that is already verified by the user stays unchanged", () => {
    enable();
    const { ref } = qualifying();
    userDecisions.decide(db, ref, "approve");
    expect(userDecisions.decide(db, ref, "approve")).toEqual({ status: "unchanged" });
  });

  it("the user disputing a promoted row then approving it is the user's from then on", () => {
    enable();
    const { ref } = qualifying();
    assessAutoVerify(db, ref, T);
    userDecisions.decide(db, ref, "dispute");
    userDecisions.decide(db, ref, "approve");
    db.run("DELETE FROM evidence WHERE id = (SELECT max(id) FROM evidence)");
    expect(assessAutoVerify(db, ref, T)).toEqual({ status: "refused", reason: "user-override" });
  });
});

describe("the judgement does not move the Insight (decision: no recompute after a promotion)", () => {
  it("the rule's valid-row predicate reads superseded and rejected only: a promotion changes nothing it reads", () => {
    enable();
    const x = project("X");
    const y = project("Y");
    const target = fact(x, { value: "2026-12-01" });
    const done = fact(y, { kind: "completion_date", value: "2026-12-20" });
    const rel = saveRelation(db, { subjectId: x, type: DEPENDS_ON, objectId: y, ...attrs() });
    const relRef: EntryRef = { kind: "relation", id: rel.id };
    automatedLifecycle.created(db, relRef, "extraction", null, T);
    const [a, b] = twoSources() as [ReturnType<typeof version>, ReturnType<typeof version>];
    cite({ factId: target.id }, a, DATE);
    cite({ factId: target.id }, b, DATE);
    cite({ factId: done.id }, a, DATE);
    cite({ relationId: rel.id }, a, DATE);
    expect(recomputeDependencyDelay(db, [x, y]).map((r) => r.outcome)).toEqual(["created"]);
    expect(assessAutoVerify(db, target, T)).toMatchObject({ status: "applied" });
    expect(state(target).status).toBe("verified");
    const again = recomputeDependencyDelay(db, [x, y]);
    expect(again.map((r) => r.outcome)).toEqual(["unchanged"]);
    expect(again[0]?.key.rule).toBe(DEPENDENCY_DELAY);
  });
});

describe("the judgement after a user action (review M2)", () => {
  it("P5: a user-written rival value takes the promoted sibling back, and only the call after the action does it", () => {
    enable();
    const { item, ref } = qualifying();
    assessAutoVerify(db, ref, T);
    const added = userDecisions.add(db, {
      kind: "fact",
      itemId: item,
      factKind: "target_date",
      value: OTHER_DATE,
    }) as { ref: EntryRef };
    expect(state(ref).status).toBe("verified"); // the gate alone judges nothing
    assessAfterUserAction(db, { itemIds: [item], relationIds: [] }, T);
    expect(state(ref).status).toBe("candidate");
    expect(lines(ref).at(-1)).toMatchObject({ reason: "conflicting-value" });
    expect(state(added.ref as EntryRef).status).toBe("verified"); // the user's own row is untouched
  });

  it("P6: dispute, a source goes, undo: the row is the policy's again and is taken back", () => {
    enable();
    const { item, ref } = qualifying();
    assessAutoVerify(db, ref, T);
    userDecisions.decide(db, ref, "dispute");
    db.run("DELETE FROM evidence WHERE id = (SELECT max(id) FROM evidence)");
    userDecisions.undo(db, ref);
    expect(state(ref).status).toBe("verified");
    assessAfterUserAction(db, { itemIds: [item], relationIds: [] }, T);
    expect(state(ref).status).toBe("candidate");
  });

  it("a relation is judged by its own id", () => {
    enable();
    const x = project("X");
    const y = project("Y");
    const saved = saveRelation(db, { subjectId: x, type: DEPENDS_ON, objectId: y, ...attrs() });
    const ref: EntryRef = { kind: "relation", id: saved.id };
    automatedLifecycle.created(db, ref, "extraction", null, T);
    for (const v of twoSources()) cite({ relationId: ref.id }, v, DATE);
    assessAfterUserAction(db, { itemIds: [], relationIds: [ref.id] }, T);
    expect(state(ref).status).toBe("verified");
  });
});

describe("alias and definition facts are promotable (review W5, R4, R16)", () => {
  it.each([
    ["alias.abbreviation", "PRJ"],
    ["alias.translation", "Projekt"],
    ["definition", "a text that two sources both state"],
  ])("%s on a concept is promoted by two independent sources", (kind, value) => {
    enable();
    const concept = insertItem(db, { type: "Concept", name: `C-${kind}`, ...attrs() });
    const ref = fact(concept, { kind, value });
    for (const v of [version(`x-${kind}`, `x ${value}`), version(`y-${kind}`, `y ${value}`)]) {
      cite({ factId: ref.id }, v, value);
    }
    expect(assessAutoVerify(db, ref, T)).toMatchObject({ status: "applied" });
    expect(state(ref).status).toBe("verified");
  });
});

describe("the revert reason names the first lost condition", () => {
  it("both conditions lost: independent-sources first", () => {
    enable();
    const { item, ref } = qualifying();
    assessAutoVerify(db, ref, T);
    db.run("DELETE FROM evidence WHERE id = (SELECT max(id) FROM evidence)");
    const rival = fact(item, { value: OTHER_DATE });
    cite({ factId: rival.id }, version("r", `rival ${OTHER_DATE}`), OTHER_DATE);
    expect(assessAutoVerify(db, ref, T)).toMatchObject({ status: "applied" });
    expect(lines(ref).at(-1)).toMatchObject({ reason: "independent-sources" });
  });
});

describe("state-neutral lines between the promotion and the loss (review D1-S2)", () => {
  it("a merge-like line the history carries does not hide the policy's promotion: the row is still reverted", () => {
    enable();
    const { ref } = qualifying();
    assessAutoVerify(db, ref, T);
    // forged: S02 writes such lines on items today and may write them on facts later
    db.run(
      `INSERT INTO fact_history (fact_id, seq, at, actor, action, from_status, to_status, from_epistemic, to_epistemic)
       VALUES (?, 3, ?, 'user', 'set-validity', 'verified', 'verified', 'explicit', 'explicit')`,
      [ref.id, T],
    );
    db.run("DELETE FROM evidence WHERE id = (SELECT max(id) FROM evidence)");
    expect(assessAutoVerify(db, ref, T)).toMatchObject({ status: "applied" });
    expect(state(ref).status).toBe("candidate");
    expect(lines(ref).at(-1)).toMatchObject({ action: "auto-verify-reverted", reverts_seq: 2 });
  });
});

describe("user actions with the setting off after on (review D1-S1)", () => {
  it("P6 with the setting off: dispute, a source goes, undo, and the user-action judgement still reverts", () => {
    enable();
    const { item, ref } = qualifying();
    assessAutoVerify(db, ref, T);
    enable(false);
    userDecisions.decide(db, ref, "dispute");
    db.run("DELETE FROM evidence WHERE id = (SELECT max(id) FROM evidence)");
    userDecisions.undo(db, ref);
    assessAfterUserAction(db, { itemIds: [item], relationIds: [] }, T);
    expect(state(ref).status).toBe("candidate");
    expect(lines(ref).at(-1)).toMatchObject({ action: "auto-verify-reverted" });
  });
});
