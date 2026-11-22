// S01-T06 (R18..R20): the type-definition registry's checks and their application, and the
// automated actor's candidate path at function level. `ontology.checks` walks the three checks of
// R19; `ontology.candidates` (the parts T06 owns) the R20 rule that an automated change is a
// candidate and needs its source. Approving, rejecting and undoing are T07's and are not tested here.
import { setOntologyStatusForTest, setStatusForTest } from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { insertItem, saveFact, saveRelation, type KnowledgeAttributes } from "./knowledge.ts";
import { migrate } from "./migrations.ts";
import {
  applyOntologyChange as applyAutomated,
  applyUserOntologyChange,
  checkOntologyChange,
  listOntologyElements,
  readOntologyElement,
  type ElementRule,
  type OntologyChange,
} from "./ontology.ts";
import { readKnowledgeRevision } from "./revisions.ts";
import type { Actor, Basis } from "./semantic-lifecycle.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
};
const item = (type: string, name: string) => insertItem(db, { type, name, ...attrs });
const fact = (itemId: number, kind: string, value: string) =>
  saveFact(db, { itemId, kind, value, ...attrs }).id;
const relation = (subjectId: number, type: string, objectId: number) =>
  saveRelation(db, { subjectId, type, objectId, ...attrs }).id;

const FEEDS: ElementRule = {
  elementKind: "relation-type",
  subjectTypes: ["System"],
  objectTypes: ["Project"],
  symmetric: false,
};
const fk = (
  over: Partial<Extract<ElementRule, { elementKind: "fact-kind" }>> = {},
): ElementRule => ({
  elementKind: "fact-kind",
  itemTypes: ["Project"],
  valueType: "text",
  cardinality: "many",
  ...over,
});
/** The user's path is package-internal, the automated one public: a test picks by actor. */
const applyOntologyChange = (
  tx: SqlDriver,
  change: OntologyChange,
  actor: Actor,
  basis: Basis | null = null,
  at?: string,
) =>
  actor === "user"
    ? applyUserOntologyChange(tx, change, at)
    : applyAutomated(tx, change, actor, basis, at);
const addUser = (name: string, rule: ElementRule) =>
  applyOntologyChange(db, { op: "add", name, rule }, "user");

/** Everything the registry holds, to see that a refusal or a check changed nothing. */
const dump = () => ({
  elements: db.all("SELECT * FROM ontology_elements ORDER BY id"),
  history: db.all("SELECT * FROM ontology_history ORDER BY element_id, seq"),
  basis: db.all("SELECT * FROM ontology_basis ORDER BY element_id"),
  revision: readKnowledgeRevision(db),
});

let versions = 0;
/** A stored source version a proposal can name: its number pair. */
function sourceVersion() {
  const saved = saveSourceRecord(db, "c1", {
    externalId: `doc-${versions++}`,
    title: "t",
    body: "본문",
  });
  if (saved.status !== "created") throw new Error(saved.status);
  return { sourceId: saved.sourceId, version: saved.version };
}

function refusalOf(outcome: ReturnType<typeof applyOntologyChange>) {
  if (outcome.status !== "refused") throw new Error(`not refused: ${JSON.stringify(outcome)}`);
  return outcome;
}

describe("ontology.checks: the duplicate check (S01-R19 step 1)", () => {
  it("reports a name that differs only in case, `_`, `.` or `-`, with the status of what it matches", () => {
    for (const name of ["project", "PROJECT", "Pro_ject", "Pro.ject", "Pro-ject"]) {
      expect(
        checkOntologyChange(db, { op: "add", name, rule: { elementKind: "item-type" } }).duplicates,
        name,
      ).toEqual([{ name: "Project", status: "verified" }]);
    }
    const check = checkOntologyChange(db, { op: "add", name: "Target.Date", rule: fk() });
    expect(check.duplicates).toEqual([{ name: "target_date", status: "verified" }]);
    expect(check.applicable).toBe(false);
  });

  it("compares within the kind: the same name as another kind is not a duplicate", () => {
    const check = checkOntologyChange(db, { op: "add", name: "Project", rule: FEEDS });
    expect(check.duplicates).toEqual([]);
  });

  it("counts a rejected and a superseded name as a duplicate", () => {
    const rejected = addUser("Gone", { elementKind: "item-type" });
    const retired = addUser("Retired", { elementKind: "item-type" });
    if (rejected.status !== "applied" || retired.status !== "applied") throw new Error("setup");
    setOntologyStatusForTest(db, rejected.id, "rejected");
    setOntologyStatusForTest(db, retired.id, "superseded");
    const dup = (name: string) =>
      checkOntologyChange(db, { op: "add", name, rule: { elementKind: "item-type" } }).duplicates;
    expect(dup("gone")).toEqual([{ name: "Gone", status: "rejected" }]);
    expect(dup("RETIRED")).toEqual([{ name: "Retired", status: "superseded" }]);
  });

  it("refuses an add with `duplicate` and the count, no name, and changes nothing", () => {
    const before = dump();
    const outcome = refusalOf(
      applyOntologyChange(
        db,
        { op: "add", name: "project", rule: { elementKind: "item-type" } },
        "user",
      ),
    );
    expect(outcome).toMatchObject({ reason: "duplicate", duplicates: 1 });
    expect(JSON.stringify(outcome)).not.toContain("Project");
    expect(dump()).toEqual(before);
  });
});

describe("ontology.checks: the shape check (R19 step 2)", () => {
  const errors = (change: OntologyChange) => checkOntologyChange(db, change).schemaErrors;

  it("refuses a name that is not an identifier", () => {
    for (const name of ["", "1abc", "a b", "a-b", "가나", "a".repeat(41), "_a"]) {
      expect(errors({ op: "add", name, rule: { elementKind: "item-type" } }), name).toEqual([
        "name-not-identifier",
      ]);
    }
    expect(errors({ op: "add", name: "a".repeat(40), rule: { elementKind: "item-type" } })).toEqual(
      [],
    );
  });

  it("refuses a rule that names an item type that does not exist or is not verified", () => {
    expect(errors({ op: "add", name: "k1", rule: fk({ itemTypes: ["Nothing"] }) })).toEqual([
      "item-type-unknown",
    ]);
    const candidate = applyOntologyChange(
      db,
      { op: "add", name: "Cand", rule: { elementKind: "item-type" } },
      "extraction",
      sourceVersion(),
    );
    expect(candidate.status).toBe("candidate");
    expect(errors({ op: "add", name: "k2", rule: fk({ itemTypes: ["Cand"] }) })).toEqual([
      "item-type-not-verified",
    ]);
    expect(
      errors({
        op: "add",
        name: "R1",
        rule: { ...FEEDS, objectTypes: ["Cand"] } as ElementRule,
      }),
    ).toEqual(["item-type-not-verified"]);
  });

  it("refuses a value kind or a count outside the closed lists, empty lists and a wrong rule kind", () => {
    const bad = (rule: unknown): OntologyChange => ({
      op: "add",
      name: "k",
      rule: rule as ElementRule,
    });
    expect(errors(bad(fk({ valueType: "number" as never })))).toEqual(["value-type-invalid"]);
    expect(errors(bad(fk({ cardinality: "two" as never })))).toEqual(["cardinality-invalid"]);
    expect(errors(bad(fk({ itemTypes: [] })))).toEqual(["item-types-invalid"]);
    expect(errors(bad({ ...FEEDS, subjectTypes: [] }))).toEqual(["subject-types-invalid"]);
    expect(errors(bad({ ...FEEDS, objectTypes: "Project" }))).toEqual(["object-types-invalid"]);
    expect(errors(bad({ ...FEEDS, symmetric: "no" }))).toEqual(["symmetric-invalid"]);
    expect(errors(bad({ elementKind: "item-type", extra: 1 }))).toEqual(["rule-malformed"]);
    expect(errors(bad({ elementKind: "other" }))).toEqual(["rule-kind-unknown"]);
    expect(errors(bad(null))).toEqual(["rule-kind-unknown"]);
    expect(errors(bad("text"))).toEqual(["rule-kind-unknown"]);
  });

  it("refuses with `schema-invalid` and codes only: the offending names are not in the answer", () => {
    const before = dump();
    const outcome = refusalOf(
      applyOntologyChange(
        db,
        { op: "add", name: "k", rule: fk({ itemTypes: ["QzNothing"] }) },
        "user",
      ),
    );
    expect(outcome).toMatchObject({
      reason: "schema-invalid",
      schemaErrors: ["item-type-unknown"],
    });
    expect(JSON.stringify(outcome)).not.toContain("QzNothing");
    expect(dump()).toEqual(before);
  });

  it("refuses a rule change or a retirement of an element that does not exist or is not verified", () => {
    expect(errors({ op: "retire", elementKind: "fact-kind", name: "nope" })).toEqual([
      "element-not-found",
    ]);
    expect(
      refusalOf(
        applyOntologyChange(db, { op: "retire", elementKind: "fact-kind", name: "nope" }, "user"),
      ).reason,
    ).toBe("not-found");
    const rejected = addUser("Gone", { elementKind: "item-type" });
    if (rejected.status !== "applied") throw new Error("setup");
    setOntologyStatusForTest(db, rejected.id, "rejected");
    expect(errors({ op: "retire", elementKind: "item-type", name: "Gone" })).toEqual([
      "element-not-verified",
    ]);
  });

  it("refuses a rule with a key of another shape: an extra or a missing key", () => {
    const keyed = (rule: object): OntologyChange => ({
      op: "add",
      name: "k",
      rule: rule as ElementRule,
    });
    expect(errors(keyed({ ...fk(), extra: 1 }))).toEqual(["rule-malformed"]);
    expect(errors(keyed({ ...FEEDS, extra: 1 }))).toEqual(["rule-malformed"]);
    const short: Record<string, unknown> = { ...fk() };
    delete short.cardinality;
    expect(errors(keyed(short))).toContain("rule-malformed");
  });

  it("stores a rule with its type lists sorted and without repeats, and compares a change in that form", () => {
    addUser("sorted_kind", fk({ itemTypes: ["System", "Project", "System"] }));
    expect(readOntologyElement(db, "fact-kind", "sorted_kind")?.rule).toEqual(
      fk({ itemTypes: ["Project", "System"] }),
    );
    expect(
      errors({
        op: "change-rule",
        elementKind: "fact-kind",
        name: "sorted_kind",
        rule: fk({ itemTypes: ["System", "Project"] }),
      }),
    ).toEqual(["rule-unchanged"]);
  });

  it("refuses a rule for an item type, and a rule change that changes nothing", () => {
    expect(
      errors({
        op: "change-rule",
        elementKind: "item-type",
        name: "Project",
        rule: { elementKind: "item-type" },
      }),
    ).toEqual(["item-type-has-no-rule"]);
    const same = fk();
    addUser("same_kind", same);
    expect(
      errors({ op: "change-rule", elementKind: "fact-kind", name: "same_kind", rule: same }),
    ).toEqual(["rule-unchanged"]);
    expect(
      errors({
        op: "change-rule",
        elementKind: "fact-kind",
        name: "same_kind",
        rule: { ...FEEDS },
      }),
    ).toEqual(["rule-kind-mismatch"]);
  });
});

describe("ontology.checks: the effect on existing data (R19 step 3)", () => {
  const change = (name: string, rule: ElementRule): OntologyChange => ({
    op: "change-rule",
    elementKind: rule.elementKind,
    name,
    rule,
  });

  function feeds() {
    addUser("FEEDS", FEEDS);
    const sys = [item("System", "S1"), item("System", "S2"), item("System", "S3")];
    const proj = item("Project", "P1");
    const live = sys.map((s) => relation(s, "FEEDS", proj));
    const gone = relation(proj, "FEEDS", proj); // a rejected row is not live
    setStatusForTest(db, "relation", gone, "rejected");
    return { sys, proj, live };
  }

  it("counts every live row of a relation type whose direction is reversed, and refuses", () => {
    feeds();
    const before = dump();
    const reversed: ElementRule = { ...FEEDS, subjectTypes: ["Project"], objectTypes: ["System"] };
    const check = checkOntologyChange(db, change("FEEDS", reversed));
    expect(check.impact).toEqual({ liveRows: 3, violations: 3 });
    expect(check.applicable).toBe(false);
    const outcome = refusalOf(applyOntologyChange(db, change("FEEDS", reversed), "user"));
    expect(outcome).toMatchObject({
      reason: "existing-data-violation",
      impact: { liveRows: 3, violations: 3 },
    });
    expect(dump()).toEqual(before);
  });

  it("counts every live row of a flipped direction even when each row still fits the new sides", () => {
    // System -> System fits both [System, Project] -> [System] and [System] -> [System, Project],
    // but the sides are swapped, so what each row says is reversed (R19 step 3)
    addUser("MIX", { ...FEEDS, subjectTypes: ["System", "Project"], objectTypes: ["System"] });
    relation(item("System", "S1"), "MIX", item("System", "S2"));
    relation(item("System", "S3"), "MIX", item("System", "S4"));
    const flipped: ElementRule = {
      ...FEEDS,
      subjectTypes: ["System"],
      objectTypes: ["System", "Project"],
    };
    expect(checkOntologyChange(db, change("MIX", flipped)).impact).toEqual({
      liveRows: 2,
      violations: 2,
    });
    // a symmetric relation has no direction to reverse
    const symmetric: ElementRule = { ...flipped, symmetric: true };
    expect(checkOntologyChange(db, change("MIX", symmetric)).impact).toEqual({
      liveRows: 2,
      violations: 0,
    });
  });

  it("counts the rows a narrower subject type leaves out", () => {
    addUser("LINKS", { ...FEEDS, subjectTypes: ["System", "Project"], objectTypes: ["Project"] });
    const p = item("Project", "P");
    relation(item("System", "S"), "LINKS", p);
    relation(item("Project", "Q"), "LINKS", p);
    relation(item("Project", "R"), "LINKS", p);
    const check = checkOntologyChange(db, change("LINKS", { ...FEEDS, subjectTypes: ["System"] }));
    expect(check.impact).toEqual({ liveRows: 3, violations: 2 });
    expect(check.applicable).toBe(false);
  });

  it("counts the items that hold two live values where the count would become one", () => {
    addUser("tag_kind", fk());
    const [a, b, c] = [
      item("Project", "A"),
      item("Project", "B"),
      item("Project", "C"),
    ] as number[];
    fact(a as number, "tag_kind", "x");
    fact(a as number, "tag_kind", "y");
    fact(b as number, "tag_kind", "x");
    fact(b as number, "tag_kind", "y");
    fact(b as number, "tag_kind", "z");
    fact(c as number, "tag_kind", "x");
    const rejected = fact(c as number, "tag_kind", "w"); // a rejected value is not a second value
    setStatusForTest(db, "fact", rejected, "rejected");
    const check = checkOntologyChange(db, change("tag_kind", fk({ cardinality: "one" })));
    expect(check.impact).toEqual({ liveRows: 6, violations: 2 });
    expect(check.applicable).toBe(false);
  });

  it("counts facts that do not fit a narrower item type or a date value kind", () => {
    addUser("note_kind", fk({ itemTypes: ["Project", "System"] }));
    fact(item("Project", "A"), "note_kind", "2026-12-01");
    fact(item("System", "B"), "note_kind", "2026-12-02");
    fact(item("System", "C"), "note_kind", "soon");
    expect(
      checkOntologyChange(db, change("note_kind", fk({ itemTypes: ["Project"] }))).impact,
    ).toEqual({ liveRows: 3, violations: 2 });
    expect(
      checkOntologyChange(
        db,
        change("note_kind", fk({ itemTypes: ["Project", "System"], valueType: "date" })),
      ).impact,
    ).toEqual({ liveRows: 3, violations: 1 });
  });

  it("takes only a calendar date for a date value kind: a day that does not exist is a misfit", () => {
    addUser("when_kind", fk());
    const p = item("Project", "P");
    fact(p, "when_kind", "2026-02-28");
    fact(p, "when_kind", "2026-02-30"); // Date.parse reads it as 2026-03-02; it is not a date
    fact(p, "when_kind", "2026-13-01");
    expect(checkOntologyChange(db, change("when_kind", fk({ valueType: "date" }))).impact).toEqual({
      liveRows: 3,
      violations: 2,
    });
  });

  it("counts neither a superseded nor a rejected row as live", () => {
    addUser("tag_kind", fk());
    const p = item("Project", "P");
    fact(p, "tag_kind", "a");
    const old = fact(p, "tag_kind", "b");
    const no = fact(p, "tag_kind", "c");
    setStatusForTest(db, "fact", old, "superseded");
    setStatusForTest(db, "fact", no, "rejected");
    expect(
      checkOntologyChange(db, { op: "retire", elementKind: "fact-kind", name: "tag_kind" }).impact,
    ).toEqual({ liveRows: 1, violations: 1 });
  });

  it("counts every live row of a retirement, and the verified rules that name a retired item type", () => {
    addUser("tag_kind", fk());
    fact(item("Project", "A"), "tag_kind", "x");
    fact(item("Project", "B"), "tag_kind", "y");
    const retire = (kind: "fact-kind" | "item-type", name: string): OntologyChange => ({
      op: "retire",
      elementKind: kind,
      name,
    });
    expect(checkOntologyChange(db, retire("fact-kind", "tag_kind")).impact).toEqual({
      liveRows: 2,
      violations: 2,
    });
    // Concept has no live item, but the definition and the three alias kinds name it
    expect(checkOntologyChange(db, retire("item-type", "Concept")).impact).toEqual({
      liveRows: 0,
      violations: 4,
    });
    expect(applyOntologyChange(db, retire("item-type", "Concept"), "user")).toMatchObject({
      status: "refused",
      reason: "existing-data-violation",
    });
  });

  it("applies a widening: the edition and the knowledge revision rise, one history line of numbers", () => {
    feeds();
    const before = readKnowledgeRevision(db);
    const widened: ElementRule = { ...FEEDS, subjectTypes: ["Project", "System"] };
    const outcome = applyOntologyChange(
      db,
      change("FEEDS", widened),
      "user",
      null,
      "2026-11-23T00:00:00.000Z",
    );
    expect(outcome).toMatchObject({ status: "applied", edition: 2, seq: 2 });
    expect(readOntologyElement(db, "relation-type", "FEEDS")).toMatchObject({
      status: "verified",
      edition: 2,
      rule: { subjectTypes: ["Project", "System"] },
    });
    expect(readKnowledgeRevision(db)).toBeGreaterThan(before);
    expect(
      db.all(
        `SELECT seq, at, actor, action, from_status, to_status, from_edition, to_edition, reason,
           basis_source_id, basis_version FROM ontology_history WHERE seq = 2`,
      ),
    ).toEqual([
      {
        seq: 2,
        at: "2026-11-23T00:00:00.000Z",
        actor: "user",
        action: "change-rule",
        from_status: "verified",
        to_status: "verified",
        from_edition: 1,
        to_edition: 2,
        reason: null,
        basis_source_id: null,
        basis_version: null,
      },
    ]);
  });

  it("applies the previous rule again as a new rule change, through the same checks", () => {
    feeds();
    const wider: ElementRule = { ...FEEDS, subjectTypes: ["Project", "System"] };
    expect(applyOntologyChange(db, change("FEEDS", wider), "user")).toMatchObject({ edition: 2 });
    // narrowing back is a change that must pass R19 again: the new Project rows would not fit
    relation(item("Project", "Q"), "FEEDS", item("Project", "R"));
    expect(refusalOf(applyOntologyChange(db, change("FEEDS", FEEDS), "user")).reason).toBe(
      "existing-data-violation",
    );
    db.run("DELETE FROM relations WHERE subject_id IN (SELECT id FROM items WHERE name = 'Q')");
    expect(applyOntologyChange(db, change("FEEDS", FEEDS), "user")).toMatchObject({
      status: "applied",
      edition: 3,
    });
  });

  it("retires an element with no live row: it becomes superseded, the edition rises, a line says so", () => {
    addUser("tag_kind", fk());
    const unused = checkOntologyChange(db, {
      op: "retire",
      elementKind: "fact-kind",
      name: "tag_kind",
    });
    expect(unused).toMatchObject({ applicable: true, impact: { liveRows: 0, violations: 0 } });
    const outcome = applyOntologyChange(
      db,
      { op: "retire", elementKind: "fact-kind", name: "tag_kind" },
      "user",
    );
    expect(outcome).toMatchObject({ status: "applied", edition: 2 });
    expect(readOntologyElement(db, "fact-kind", "tag_kind")).toMatchObject({
      status: "superseded",
      edition: 2,
    });
    expect(
      db.all(
        "SELECT action, from_status, to_status, from_edition, to_edition FROM ontology_history WHERE seq = 2",
      ),
    ).toEqual([
      {
        action: "retire",
        from_status: "verified",
        to_status: "superseded",
        from_edition: 1,
        to_edition: 2,
      },
    ]);
  });

  it("a check alone changes nothing", () => {
    feeds();
    const before = dump();
    for (const c of [
      change("FEEDS", { ...FEEDS, subjectTypes: ["Project", "System"] }),
      change("FEEDS", { ...FEEDS, subjectTypes: ["Project"], objectTypes: ["System"] }),
      { op: "retire", elementKind: "relation-type", name: "FEEDS" } satisfies OntologyChange,
      { op: "add", name: "Fresh", rule: { elementKind: "item-type" } } satisfies OntologyChange,
    ]) {
      checkOntologyChange(db, c);
    }
    expect(dump()).toEqual(before);
  });

  it("lists nothing and keeps the verified seed for a change that is refused", () => {
    const seeded = listOntologyElements(db);
    expect(seeded).toHaveLength(10);
    applyOntologyChange(db, { op: "retire", elementKind: "item-type", name: "Concept" }, "user");
    expect(listOntologyElements(db)).toEqual(seeded);
  });
});

describe("ontology.candidates: the automated path at function level (R20)", () => {
  const proposal = (name = "ZetaCanary"): OntologyChange => ({
    op: "add",
    name,
    rule: { elementKind: "item-type" },
  });

  it("records an automated add as a candidate with its source, and it is not in force", () => {
    const basis = sourceVersion();
    const before = readKnowledgeRevision(db);
    const outcome = applyOntologyChange(
      db,
      proposal(),
      "extraction",
      basis,
      "2026-11-23T00:00:00.000Z",
    );
    if (outcome.status !== "candidate") throw new Error(JSON.stringify(outcome));
    expect(readOntologyElement(db, "item-type", "ZetaCanary")).toMatchObject({
      id: outcome.id,
      status: "candidate",
      edition: 1,
    });
    expect(
      db.all("SELECT source_id, version FROM ontology_basis WHERE element_id = ?", [outcome.id]),
    ).toEqual([{ source_id: basis.sourceId, version: basis.version }]);
    expect(
      db.all(
        `SELECT actor, action, from_status, to_status, from_edition, to_edition, basis_source_id, basis_version
         FROM ontology_history WHERE element_id = ?`,
        [outcome.id],
      ),
    ).toEqual([
      {
        actor: "extraction",
        action: "created",
        from_status: null,
        to_status: "candidate",
        from_edition: null,
        to_edition: 1,
        basis_source_id: basis.sourceId,
        basis_version: basis.version,
      },
    ]);
    expect(readKnowledgeRevision(db)).toBeGreaterThan(before);
    // a candidate is no verified item type: a rule cannot name it yet
    expect(
      checkOntologyChange(db, { op: "add", name: "uses", rule: fk({ itemTypes: ["ZetaCanary"] }) })
        .schemaErrors,
    ).toEqual(["item-type-not-verified"]);
  });

  it("does not promote a candidate, however often it is proposed or whoever proposes", () => {
    for (const actor of ["extraction", "policy", "propagation"] as const) {
      const name = `From${actor}`;
      expect(applyOntologyChange(db, proposal(name), actor, sourceVersion())).toMatchObject({
        status: "candidate",
      });
      expect(readOntologyElement(db, "item-type", name)?.status).toBe("candidate");
      // the same name again is a duplicate of the candidate, not a second candidate
      expect(
        refusalOf(applyOntologyChange(db, proposal(name), actor, sourceVersion())).reason,
      ).toBe("duplicate");
    }
  });

  it("refuses a proposal with no source, or a source version that is not stored, and writes nothing", () => {
    const before = dump();
    expect(refusalOf(applyOntologyChange(db, proposal(), "extraction", null)).reason).toBe(
      "basis-required",
    );
    expect(
      refusalOf(applyOntologyChange(db, proposal(), "extraction", { sourceId: 99, version: 1 }))
        .reason,
    ).toBe("basis-required");
    const known = sourceVersion();
    expect(
      refusalOf(
        applyOntologyChange(db, proposal(), "policy", {
          sourceId: known.sourceId,
          version: known.version + 1,
        }),
      ).reason,
    ).toBe("basis-required");
    expect(dump()).toEqual(before);
  });

  it("the public entry refuses the user, at run time as well as by type, and writes nothing", () => {
    const before = dump();
    // the type excludes "user"; this is a caller that got past the type
    const asUser = "user" as unknown as "extraction";
    expect(refusalOf(applyAutomated(db, proposal("Sneaky"), asUser, sourceVersion())).reason).toBe(
      "invalid-transition",
    );
    expect(refusalOf(applyAutomated(db, proposal("Sneaky"), asUser, null)).reason).toBe(
      "invalid-transition",
    );
    expect(dump()).toEqual(before);
    expect(readOntologyElement(db, "item-type", "Sneaky")).toBeUndefined();
  });

  it("proposes only additions: a rule change or a retirement from an automated actor is refused", () => {
    const before = dump();
    const basis = sourceVersion();
    for (const change of [
      {
        op: "change-rule",
        elementKind: "fact-kind",
        name: "definition",
        rule: fk({ itemTypes: ["Concept", "Project"] }),
      },
      { op: "retire", elementKind: "fact-kind", name: "definition" },
    ] satisfies OntologyChange[]) {
      expect(refusalOf(applyOntologyChange(db, change, "extraction", basis)).reason).toBe(
        "invalid-transition",
      );
    }
    expect(dump()).toEqual(before);
  });

  it("runs the checks before recording: a malformed or duplicate proposal is refused, not stored", () => {
    const basis = sourceVersion();
    const before = dump();
    expect(
      refusalOf(applyOntologyChange(db, proposal("1bad name"), "extraction", basis)).reason,
    ).toBe("schema-invalid");
    expect(
      refusalOf(applyOntologyChange(db, proposal("project"), "extraction", basis)).reason,
    ).toBe("duplicate");
    expect(dump()).toEqual(before);
  });

  it("absorbs a name the user rejected: no new candidate appears", () => {
    const first = applyOntologyChange(db, proposal(), "extraction", sourceVersion());
    if (first.status !== "candidate") throw new Error("setup");
    setOntologyStatusForTest(db, first.id, "rejected");
    const count = listOntologyElements(db).length;
    expect(
      refusalOf(applyOntologyChange(db, proposal("zetacanary"), "extraction", sourceVersion()))
        .reason,
    ).toBe("duplicate");
    expect(listOntologyElements(db)).toHaveLength(count);
    expect(readOntologyElement(db, "item-type", "ZetaCanary")?.status).toBe("rejected");
  });

  it("applies a user add as verified, with no lineage row", () => {
    const outcome = applyOntologyChange(db, proposal("Mine"), "user");
    expect(outcome).toMatchObject({ status: "applied", edition: 1, seq: 1 });
    expect(readOntologyElement(db, "item-type", "Mine")?.status).toBe("verified");
    expect(db.all("SELECT count(*) AS n FROM ontology_basis")).toEqual([{ n: 0 }]);
    expect(
      db.all(
        "SELECT actor, action, to_status, basis_source_id FROM ontology_history WHERE seq = 1 AND to_status = 'verified'",
      ),
    ).toEqual([{ actor: "user", action: "created", to_status: "verified", basis_source_id: null }]);
  });

  it("copies no name into a history line or a refusal", () => {
    const basis = sourceVersion();
    const outputs: unknown[] = [];
    outputs.push(applyOntologyChange(db, proposal("QzSourceName"), "extraction", basis));
    outputs.push(applyOntologyChange(db, proposal("qzsourcename"), "extraction", basis));
    outputs.push(applyOntologyChange(db, proposal("QzOther"), "extraction", null));
    outputs.push(
      applyOntologyChange(
        db,
        { op: "add", name: "QzFact", rule: fk({ itemTypes: ["QzNoType"] }) },
        "extraction",
        basis,
      ),
    );
    const text = JSON.stringify([outputs, db.all("SELECT * FROM ontology_history")]).toLowerCase();
    for (const name of ["qzsourcename", "qzother", "qzfact", "qznotype"]) {
      expect(text, name).not.toContain(name);
    }
  });
});
