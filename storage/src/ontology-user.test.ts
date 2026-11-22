// S01-T07 `ontology.candidates` (approve, reject and undo parts, S01-R5, R20) and the history of a
// rule change and a retirement (R20, T06 hand-off 13 and 14): the user's entry to the type
// definitions. The transition table has three user lines (candidate -> verified, candidate ->
// rejected, verified -> superseded by a retirement) and nothing else, whatever the schema's gate would
// accept; an approval keeps its lineage rows and leaves the element without lineage; an undo of an
// approval with no lineage row left removes the element; an undo of an approval or an add of an
// element that is in use is refused with counts only; a retirement is undone with the edition going
// up, never down; a rule change is not undone. All data is synthetic.
import { setOntologyStatusForTest, setStatusForTest } from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { insertItem, saveFact, saveRelation, type KnowledgeAttributes } from "./knowledge.ts";
import { migrate } from "./migrations.ts";
import {
  applyOntologyChange,
  readOntologyElement,
  readOntologyHistory,
  userOntology,
  type ElementRule,
  type OntologyActionOutcome,
  type OntologyChange,
} from "./ontology.ts";
import { readKnowledgeRevision } from "./revisions.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

const NAME = "QzUniqueName";
const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
};
const TYPE: ElementRule = { elementKind: "item-type" };
const fk = (
  over: Partial<Extract<ElementRule, { elementKind: "fact-kind" }>> = {},
): ElementRule => ({
  elementKind: "fact-kind",
  itemTypes: ["Project"],
  valueType: "text",
  cardinality: "many",
  ...over,
});
const FEEDS: ElementRule = {
  elementKind: "relation-type",
  subjectTypes: ["System"],
  objectTypes: ["Project"],
  symmetric: false,
};

let versions = 0;
function basis() {
  const saved = saveSourceRecord(db, "c1", {
    externalId: `doc-${versions++}`,
    title: "t",
    body: "본문",
  });
  if (saved.status !== "created") throw new Error(saved.status);
  return { sourceId: saved.sourceId, version: saved.version };
}

/** A candidate proposed by extraction from `basis()`. */
function candidate(name: string, rule: ElementRule = TYPE): number {
  const out = applyOntologyChange(db, { op: "add", name, rule }, "extraction", basis());
  if (out.status !== "candidate") throw new Error(JSON.stringify(out));
  return out.id;
}
/** An element the user added: verified, with its creation line and no lineage. */
function userAdded(name: string, rule: ElementRule = TYPE): number {
  const out = userOntology.change(db, { op: "add", name, rule });
  if (out.status !== "applied") throw new Error(JSON.stringify(out));
  return out.id;
}
const idOf = (kind: "item-type" | "fact-kind" | "relation-type", name: string): number =>
  (readOntologyElement(db, kind, name) as { id: number }).id;

const stateOf = (id: number) =>
  db.all("SELECT status, edition FROM ontology_elements WHERE id = ?", [id])[0];
const basisRows = (id: number) =>
  db.all("SELECT source_id, version FROM ontology_basis WHERE element_id = ?", [id]).length;
const actions = (id: number) => readOntologyHistory(db, id).map((l) => l.action);
const dump = () => ({
  elements: db.all("SELECT * FROM ontology_elements ORDER BY id"),
  history: db.all("SELECT * FROM ontology_history ORDER BY element_id, seq"),
  basis: db.all("SELECT * FROM ontology_basis ORDER BY element_id"),
  revision: readKnowledgeRevision(db),
});
const refused = (out: OntologyActionOutcome) => {
  if (out.status !== "refused") throw new Error(`not refused: ${JSON.stringify(out)}`);
  return out;
};

describe("ontology.candidates: approve and reject (S01-R5, R20)", () => {
  it("approves a candidate: verified, the edition kept, a user line after the creation line, the lineage rows kept", () => {
    const id = candidate(NAME);
    const revision = readKnowledgeRevision(db);
    const out = userOntology.decide(db, id, "approve", "2026-11-23T00:00:00.000Z");
    expect(out).toEqual({ status: "applied", id, edition: 1, seq: 2 });
    expect(stateOf(id)).toEqual({ status: "verified", edition: 1 });
    expect(basisRows(id)).toBe(1);
    expect(readKnowledgeRevision(db)).toBeGreaterThan(revision);
    expect(readOntologyHistory(db, id)).toMatchObject([
      { seq: 1, actor: "extraction", action: "created", toStatus: "candidate" },
      {
        seq: 2,
        at: "2026-11-23T00:00:00.000Z",
        actor: "user",
        action: "approve",
        fromStatus: "candidate",
        toStatus: "verified",
        fromEdition: 1,
        toEdition: 1,
        revertsSeq: null,
      },
    ]);
  });

  it("rejects a candidate: rejected, the lineage rows kept", () => {
    const id = candidate(NAME);
    expect(userOntology.decide(db, id, "reject")).toMatchObject({ status: "applied", seq: 2 });
    expect(stateOf(id)).toEqual({ status: "rejected", edition: 1 });
    expect(basisRows(id)).toBe(1);
    expect(actions(id)).toEqual(["created", "reject"]);
  });

  it("answers a repeat with unchanged and writes no line", () => {
    const id = candidate(NAME);
    userOntology.decide(db, id, "approve");
    const before = dump();
    expect(userOntology.decide(db, id, "approve")).toEqual({ status: "unchanged", id });
    expect(dump()).toEqual(before);
    const rejected = candidate("Other");
    userOntology.decide(db, rejected, "reject");
    expect(userOntology.decide(db, rejected, "reject")).toEqual({
      status: "unchanged",
      id: rejected,
    });
    // a seed (no line) is verified already
    expect(userOntology.decide(db, idOf("item-type", "Project"), "approve")).toEqual({
      status: "unchanged",
      id: idOf("item-type", "Project"),
    });
  });

  it("refuses every transition the table does not list, and any dispute, as invalid-transition, writing nothing", () => {
    const cand = candidate("Cand");
    const ver = userAdded("Ver");
    const rej = candidate("Rej");
    userOntology.decide(db, rej, "reject");
    const sup = userAdded("Sup");
    setOntologyStatusForTest(db, sup, "superseded");
    const before = dump();
    const cases: [number, "approve" | "reject" | "dispute"][] = [
      [cand, "dispute"],
      [ver, "dispute"],
      [rej, "dispute"],
      [sup, "dispute"],
      [ver, "reject"],
      [rej, "approve"],
      [sup, "approve"],
      [sup, "reject"],
      [idOf("item-type", "Project"), "reject"],
      [idOf("item-type", "Project"), "dispute"],
    ];
    for (const [id, action] of cases) {
      expect([id, action, refused(userOntology.decide(db, id, action)).reason]).toEqual([
        id,
        action,
        "invalid-transition",
      ]);
    }
    expect(dump()).toEqual(before);
  });

  it("answers not-found for an id that is not stored", () => {
    expect(refused(userOntology.decide(db, 99_999, "approve")).reason).toBe("not-found");
    expect(refused(userOntology.undo(db, 99_999)).reason).toBe("not-found");
  });

  it("checks the candidate's rule again at approval: an item type it names that is no longer verified is a schema-invalid refusal", () => {
    userAdded("Zed");
    const kind = candidate("zed_kind", fk({ itemTypes: ["Zed"] }));
    // nothing verified names Zed, so retiring it is allowed
    expect(
      userOntology.change(db, { op: "retire", elementKind: "item-type", name: "Zed" }).status,
    ).toBe("applied");
    const before = dump();
    const out = refused(userOntology.decide(db, kind, "approve"));
    expect(out).toMatchObject({
      reason: "schema-invalid",
      schemaErrors: ["item-type-not-verified"],
    });
    expect(JSON.stringify(out)).not.toContain("Zed");
    expect(dump()).toEqual(before);
  });

  it("checks the candidate against the rows that exist at approval: a row it does not fit is an existing-data-violation, counted", () => {
    const kind = candidate("due_on", fk({ valueType: "date", cardinality: "one" }));
    const p = insertItem(db, { type: "Project", name: "P1", ...attrs });
    saveFact(db, { itemId: p, kind: "due_on", value: "2026-02-30", ...attrs });
    saveFact(db, { itemId: p, kind: "due_on", value: "2026-03-01", ...attrs });
    const before = dump();
    const out = refused(userOntology.decide(db, kind, "approve"));
    expect(out).toMatchObject({
      reason: "existing-data-violation",
      impact: { liveRows: 2, violations: 2 },
    });
    expect(dump()).toEqual(before);
  });

  it("gives an automated candidate no way in: a rejected name is not proposed anew, and the element is never promoted by itself", () => {
    const id = candidate(NAME);
    userOntology.decide(db, id, "reject");
    const again = applyOntologyChange(
      db,
      { op: "add", name: NAME, rule: TYPE },
      "extraction",
      basis(),
    );
    expect(again).toMatchObject({ status: "refused", reason: "duplicate" });
    expect(stateOf(id)).toEqual({ status: "rejected", edition: 1 });
  });
});

describe("ontology.candidates: undo (S01-R8, R20)", () => {
  it("returns an approval to candidate with the lineage rows that are left", () => {
    const id = candidate(NAME);
    userOntology.decide(db, id, "approve");
    const out = userOntology.undo(db, id);
    expect(out).toEqual({ status: "applied", id, edition: 1, seq: 3 });
    expect(stateOf(id)).toEqual({ status: "candidate", edition: 1 });
    expect(basisRows(id)).toBe(1);
    expect(readOntologyHistory(db, id)[2]).toMatchObject({
      seq: 3,
      actor: "user",
      action: "undo",
      fromStatus: "verified",
      toStatus: "candidate",
      revertsSeq: 2,
    });
  });

  it("returns a rejection to candidate", () => {
    const id = candidate(NAME);
    userOntology.decide(db, id, "reject");
    expect(userOntology.undo(db, id)).toMatchObject({ status: "applied", seq: 3 });
    expect(stateOf(id)).toEqual({ status: "candidate", edition: 1 });
  });

  it("removes the element when the approval is undone and no lineage row is left, history and all", () => {
    const id = candidate(NAME);
    userOntology.decide(db, id, "approve");
    // the proposing source was deleted while the element was verified: its lineage rows went
    db.run("DELETE FROM ontology_basis WHERE element_id = ?", [id]);
    const revision = readKnowledgeRevision(db);
    expect(userOntology.undo(db, id)).toEqual({ status: "removed", id });
    expect(db.all("SELECT 1 FROM ontology_elements WHERE id = ?", [id])).toEqual([]);
    expect(db.all("SELECT 1 FROM ontology_history WHERE element_id = ?", [id])).toEqual([]);
    expect(readKnowledgeRevision(db)).toBeGreaterThan(revision);
  });

  it("keeps the element as a candidate when only some of its lineage rows are gone", () => {
    const id = candidate(NAME);
    const second = basis();
    db.run("INSERT INTO ontology_basis (element_id, source_id, version) VALUES (?, ?, ?)", [
      id,
      second.sourceId,
      second.version,
    ]);
    userOntology.decide(db, id, "approve");
    db.run("DELETE FROM ontology_basis WHERE element_id = ? AND source_id = ?", [
      id,
      second.sourceId,
    ]);
    expect(userOntology.undo(db, id).status).toBe("applied");
    expect(stateOf(id)).toEqual({ status: "candidate", edition: 1 });
    expect(basisRows(id)).toBe(1);
  });

  it("removes an element the user added when the add is undone", () => {
    const id = userAdded(NAME);
    expect(userOntology.undo(db, id)).toEqual({ status: "removed", id });
    expect(readOntologyElement(db, "item-type", NAME)).toBeUndefined();
    // the name is free again
    expect(userOntology.change(db, { op: "add", name: NAME, rule: TYPE }).status).toBe("applied");
  });

  it("removes an element the user added even if a lineage row has found its way onto it", () => {
    const id = userAdded(NAME);
    const b = basis();
    db.run("INSERT INTO ontology_basis (element_id, source_id, version) VALUES (?, ?, ?)", [
      id,
      b.sourceId,
      b.version,
    ]);
    expect(userOntology.undo(db, id)).toEqual({ status: "removed", id });
  });

  it("refuses with the codes of R8: nothing-to-undo for a seed and for a second undo, not-latest after an automated line", () => {
    expect(refused(userOntology.undo(db, idOf("item-type", "Project"))).reason).toBe(
      "nothing-to-undo",
    );
    const id = candidate(NAME);
    // the creation line is the extraction's: not a user action
    expect(refused(userOntology.undo(db, id)).reason).toBe("not-latest");
    userOntology.decide(db, id, "approve");
    userOntology.undo(db, id);
    expect(refused(userOntology.undo(db, id)).reason).toBe("nothing-to-undo");
    const tested = userAdded("Tested");
    setOntologyStatusForTest(db, tested, "superseded"); // a test line, not the user's
    expect(refused(userOntology.undo(db, tested)).reason).toBe("not-latest");
  });

  it("is one step: an approval followed by a retirement is undone as the retirement, then nothing", () => {
    const id = candidate("Gone");
    userOntology.decide(db, id, "approve");
    userOntology.change(db, { op: "retire", elementKind: "item-type", name: "Gone" });
    expect(userOntology.undo(db, id).status).toBe("applied"); // the retirement
    expect(stateOf(id)).toMatchObject({ status: "verified" });
    expect(refused(userOntology.undo(db, id)).reason).toBe("nothing-to-undo");
  });
});

describe("ontology.candidates: an element in use is not undone (R20, T06 hand-off 13 and 14)", () => {
  const countsOf = (out: OntologyActionOutcome) => {
    const r = refused(out);
    return { reason: r.reason, impact: r.impact };
  };

  it.each([
    ["an approval", "approve"],
    ["an add of the user", "add"],
  ] as const)(
    "refuses to undo %s of a fact kind that live rows use, with counts and nothing changed",
    (_n, how) => {
      let id: number;
      if (how === "approve") {
        id = candidate("owner_note", fk());
        userOntology.decide(db, id, "approve");
      } else id = userAdded("owner_note", fk());
      const p = insertItem(db, { type: "Project", name: "P1", ...attrs });
      saveFact(db, { itemId: p, kind: "owner_note", value: "v1", ...attrs });
      saveFact(db, { itemId: p, kind: "owner_note", value: "v2", ...attrs });
      const gone = saveFact(db, { itemId: p, kind: "owner_note", value: "v3", ...attrs }).id;
      setStatusForTest(db, "fact", gone, "rejected"); // not live
      const before = dump();
      const out = userOntology.undo(db, id);
      expect(countsOf(out)).toEqual({
        reason: "existing-data-violation",
        impact: { liveRows: 2, violations: 2 },
      });
      expect(JSON.stringify(out)).not.toContain("owner_note");
      expect(dump()).toEqual(before);
    },
  );

  it("refuses to undo an approved relation type that live relations use", () => {
    const id = candidate("FEEDS", FEEDS);
    userOntology.decide(db, id, "approve");
    const s = insertItem(db, { type: "System", name: "S1", ...attrs });
    const p = insertItem(db, { type: "Project", name: "P1", ...attrs });
    saveRelation(db, { subjectId: s, type: "FEEDS", objectId: p, ...attrs });
    expect(countsOf(userOntology.undo(db, id))).toEqual({
      reason: "existing-data-violation",
      impact: { liveRows: 1, violations: 1 },
    });
  });

  it("refuses to undo an item type that live items use, or that a verified rule names, or that a candidate rule names", () => {
    const id = candidate("Team");
    userOntology.decide(db, id, "approve");
    // 1: a live item of the type
    const item = insertItem(db, { type: "Team", name: "T1", ...attrs });
    expect(countsOf(userOntology.undo(db, id)).impact).toEqual({ liveRows: 1, violations: 1 });
    setStatusForTest(db, "item", item, "rejected");
    // 2: no live item now, and nothing names it: the undo goes through
    const free = candidate("Free");
    userOntology.decide(db, free, "approve");
    // a verified rule names Free
    userAdded("free_kind", fk({ itemTypes: ["Free"] }));
    expect(countsOf(userOntology.undo(db, free)).impact).toEqual({ liveRows: 0, violations: 1 });
    // a candidate rule names Free (a source gave the name; the rule is a candidate still)
    const named = candidate("Named");
    userOntology.decide(db, named, "approve");
    candidate("named_kind", fk({ itemTypes: ["Named"] }));
    expect(countsOf(userOntology.undo(db, named)).impact).toEqual({ liveRows: 0, violations: 1 });
    expect(stateOf(named)).toEqual({ status: "verified", edition: 1 });
  });

  it("does not count a rejected or retired rule that names the type", () => {
    const id = userAdded("Unit");
    const gone = userAdded("unit_kind", fk({ itemTypes: ["Unit"] }));
    setOntologyStatusForTest(db, gone, "rejected");
    expect(userOntology.undo(db, id)).toEqual({ status: "removed", id });
  });

  it("lets an approval be undone once the rows that used the element are rejected", () => {
    const id = userAdded("note_kind", fk());
    const p = insertItem(db, { type: "Project", name: "P1", ...attrs });
    const f = saveFact(db, { itemId: p, kind: "note_kind", value: "v", ...attrs }).id;
    expect(userOntology.undo(db, id).status).toBe("refused");
    setStatusForTest(db, "fact", f, "superseded");
    expect(userOntology.undo(db, id)).toEqual({ status: "removed", id });
  });
});

describe("ontology.candidates: a rule change and a retirement leave history (R20)", () => {
  it("writes a rule change as one text-free line with the editions before and after, and does not undo it", () => {
    const id = userAdded("note_kind", fk());
    const widened = fk({ itemTypes: ["Project", "System"] });
    const out = userOntology.change(db, {
      op: "change-rule",
      elementKind: "fact-kind",
      name: "note_kind",
      rule: widened,
    });
    expect(out).toEqual({ status: "applied", id, edition: 2, seq: 2 });
    expect(readOntologyHistory(db, id)[1]).toMatchObject({
      actor: "user",
      action: "change-rule",
      fromStatus: "verified",
      toStatus: "verified",
      fromEdition: 1,
      toEdition: 2,
    });
    const before = dump();
    expect(refused(userOntology.undo(db, id)).reason).toBe("invalid-transition");
    expect(dump()).toEqual(before);
    // going back is a new rule change, through the checks
    const back = userOntology.change(db, {
      op: "change-rule",
      elementKind: "fact-kind",
      name: "note_kind",
      rule: fk(),
    });
    expect(back).toMatchObject({ status: "applied", edition: 3 });
  });

  it("writes a retirement as one line, and undoes it with the edition going up, never down", () => {
    const id = userAdded("Old");
    const revision = readKnowledgeRevision(db);
    expect(
      userOntology.change(db, { op: "retire", elementKind: "item-type", name: "Old" }),
    ).toEqual({
      status: "applied",
      id,
      edition: 2,
      seq: 2,
    });
    expect(stateOf(id)).toEqual({ status: "superseded", edition: 2 });
    expect(userOntology.undo(db, id)).toEqual({ status: "applied", id, edition: 3, seq: 3 });
    expect(stateOf(id)).toEqual({ status: "verified", edition: 3 });
    expect(readKnowledgeRevision(db)).toBeGreaterThan(revision);
    const lines = readOntologyHistory(db, id);
    expect(lines[2]).toMatchObject({
      action: "undo",
      fromStatus: "superseded",
      toStatus: "verified",
      fromEdition: 2,
      toEdition: 3,
      revertsSeq: 2,
    });
    const editions = lines.map((l) => l.toEdition);
    expect(editions).toEqual([...editions].sort((a, b) => a - b));
    expect(refused(userOntology.undo(db, id)).reason).toBe("nothing-to-undo");
    // it can be retired and undone again, the edition still rising
    userOntology.change(db, { op: "retire", elementKind: "item-type", name: "Old" });
    expect(userOntology.undo(db, id)).toMatchObject({ edition: 5 });
  });

  it("does not bring a retired rule back when the item type it names was retired meanwhile (review F1, P1)", () => {
    userAdded("Widget");
    const rule = userAdded("widget_note", fk({ itemTypes: ["Widget"] }));
    userOntology.change(db, { op: "retire", elementKind: "fact-kind", name: "widget_note" });
    // a retired rule is not counted, so the type may go
    expect(
      userOntology.change(db, { op: "retire", elementKind: "item-type", name: "Widget" }).status,
    ).toBe("applied");
    const before = dump();
    const out = refused(userOntology.undo(db, rule));
    expect(out).toMatchObject({
      reason: "schema-invalid",
      schemaErrors: ["item-type-not-verified"],
    });
    expect(JSON.stringify(out)).not.toContain("Widget");
    expect(dump()).toEqual(before);
    expect(stateOf(rule)).toEqual({ status: "superseded", edition: 2 });
  });

  it("does not bring a retired rule back when the item type it names was removed meanwhile, so a re-added type is not bound to it (review F1, P2)", () => {
    const type = userAdded("Gadget");
    const rule = userAdded("gadget_note", fk({ itemTypes: ["Gadget"] }));
    userOntology.change(db, { op: "retire", elementKind: "fact-kind", name: "gadget_note" });
    expect(userOntology.undo(db, type)).toEqual({ status: "removed", id: type });
    const before = dump();
    expect(refused(userOntology.undo(db, rule))).toMatchObject({
      reason: "schema-invalid",
      schemaErrors: ["item-type-unknown"],
    });
    expect(dump()).toEqual(before);
    userAdded("Gadget");
    expect(readOntologyElement(db, "fact-kind", "gadget_note")?.status).toBe("superseded");
  });

  it("undoes the retirement of a seed, which has no creation line", () => {
    const id = idOf("fact-kind", "alias.translation");
    userOntology.change(db, { op: "retire", elementKind: "fact-kind", name: "alias.translation" });
    expect(userOntology.undo(db, id)).toMatchObject({ status: "applied", edition: 3 });
    expect(stateOf(id)).toEqual({ status: "verified", edition: 3 });
    expect(actions(id)).toEqual(["retire", "undo"]);
  });

  it("holds no name, value or quote in a refusal or in a history line", () => {
    const id = candidate(NAME);
    userOntology.decide(db, id, "approve");
    const refusals = [
      userOntology.decide(db, id, "dispute"),
      userOntology.decide(db, 99_999, "approve"),
      userOntology.change(db, { op: "add", name: NAME.toLowerCase(), rule: TYPE }),
      userOntology.change(db, { op: "retire", elementKind: "item-type", name: "Project" }),
      userOntology.change(db, { op: "add", name: "k", rule: fk({ itemTypes: [NAME + "x"] }) }),
    ];
    const retired = candidate(`${NAME}2`);
    userOntology.decide(db, retired, "approve");
    userOntology.change(db, { op: "retire", elementKind: "item-type", name: `${NAME}2` });
    userOntology.undo(db, retired);
    for (const out of refusals) expect(out.status).toBe("refused");
    expect(JSON.stringify(refusals)).not.toContain("Qz");
    expect(JSON.stringify(readOntologyHistory(db, id))).not.toContain("Qz");
    expect(JSON.stringify(readOntologyHistory(db, retired))).not.toContain("Qz");
  });

  it("changes only the columns it sets: the identity trigger does not fire", () => {
    // a retirement, an undo and an approval all pass the name/kind-fixed trigger
    const id = candidate("Fixed");
    userOntology.decide(db, id, "approve");
    userOntology.change(db, { op: "retire", elementKind: "item-type", name: "Fixed" });
    userOntology.undo(db, id);
    expect(readOntologyElement(db, "item-type", "Fixed")?.id).toBe(id);
  });

  it("applies the user's changes only through the checks: a change an existing row forbids is refused as before", () => {
    const change: OntologyChange = { op: "retire", elementKind: "item-type", name: "Project" };
    expect(userOntology.change(db, change)).toMatchObject({
      status: "refused",
      reason: "existing-data-violation",
    });
  });
});
