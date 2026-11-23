// S01-T07 `ontology.enforce` (S01-R21, R4, R18): an extraction result is fitted to the `verified`
// type definitions before it is written. An item type, fact kind or relation type that is not a
// verified element, a value that is not of the fact kind's value kind (the old calendar-date check
// is now the `date` kind's), and a relation whose ends do not fit its direction are dropped alone and
// counted in `other`; a `one` value count does not stop a write. The seed is compared with the
// prompt's lists. All data is synthetic.
import { NOT_EXTRACTED_NAMES } from "@pki/contracts";
import {
  createBroker,
  createUserActionLedger,
  EXTRACT_ALIAS_FACT_KINDS,
  EXTRACT_ANALYTICAL_FACT_KINDS,
  EXTRACT_ANALYTICAL_ITEM_TYPES,
  EXTRACT_ANALYTICAL_RELATION_TYPES,
  EXTRACT_DEFINITION_FACT_KIND,
  EXTRACT_FACT_KINDS,
  EXTRACT_IDENTIFIER_FACT_KINDS,
  EXTRACT_ITEM_TYPES,
  EXTRACT_RELATION_TYPES,
  EXTRACT_STATEMENT_FACT_KIND,
  type Broker,
} from "@pki/providers";
import {
  addEvidence,
  automatedLifecycle,
  closeJob,
  insertItem,
  isFenceCurrent,
  leaseNextJob,
  listOntologyElements,
  migrate,
  readExtractionDrops,
  registerConnectorInstance,
  registerJob,
  saveFact,
  saveSourceRecord,
  userDecisions,
  type OntologyChange,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { FakeProvider, setOntologyStatusForTest, type FakeStep } from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CANONICAL_KINDS, propagateCanonical } from "./canonical-kinds.ts";
import { createExtractHandler } from "./extraction.ts";
import { knowledgeCandidates } from "./linking.ts";

const T0 = new Date("2026-11-21T00:00:00.000Z");
let db: SqlDriver;
let handler: ReturnType<typeof createExtractHandler>;
let recording: { call(raw: unknown): ReturnType<Broker["call"]> };

function setUp(script: FakeStep[] = []) {
  const provider = new FakeProvider({
    answer: () => ({ items: [], facts: [], relations: [], terms: [], definitions: [] }),
    script,
  });
  const broker = createBroker({
    db,
    provider: () => provider,
    userActions: createUserActionLedger().redeemer,
    candidates: knowledgeCandidates(db),
    egress: { decide: () => ({ allowed: true, destination: "fake", policyVersion: "pv" }) },
    execution: { decide: () => ({ run: true }) },
    recorder: {
      record: () => undefined,
      begin: () => () => undefined,
      attemptTimes: () => [],
      interruptStarted: () => 0,
    },
    clock: { now: () => 0, sleep: async () => undefined },
  });
  recording = { call: (raw) => broker.call(raw) };
  handler = createExtractHandler({ db, now: () => T0 });
}
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "fixtures", "test-fixtures");
  setUp();
});
afterEach(() => db.close());

let documents = 0;
const BODY =
  "미리내 프로젝트의 목표일은 2026-12-05입니다. 물결 시스템의 목표일은 2026-12-06입니다. 미리내 프로젝트는 물결 시스템에 기댑니다.";
const Q_PROJECT = "미리내 프로젝트의 목표일은 2026-12-05입니다";
const Q_SYSTEM = "물결 시스템의 목표일은 2026-12-06입니다";
const Q_REL = "미리내 프로젝트는 물결 시스템에 기댑니다";

function imported(body = BODY): StoredJob {
  return db.transaction(() => {
    const saved = saveSourceRecord(db, "fixtures", {
      externalId: `doc-${documents++}`,
      title: "t",
      body,
    });
    if (saved.status !== "created") throw new Error("expected a new version");
    const r = registerJob(db, {
      kind: "extract",
      sourceId: saved.sourceId,
      fenceVersion: saved.version,
      at: T0,
    });
    if (!r.registered) throw new Error("expected a new job");
    return r.job;
  });
}
async function run(): Promise<StoredJob> {
  const job = leaseNextJob(db, { kinds: ["extract"], now: T0, leaseMs: 60_000 });
  if (
    !job ||
    !isFenceCurrent(db, {
      sourceId: job.sourceId as number,
      fenceVersion: job.fenceVersion as number,
    })
  ) {
    throw new Error("expected a current job");
  }
  const result = await handler(job, { broker: recording });
  if (result.status !== "succeeded") throw new Error(result.status);
  closeJob(db, job, result);
  return job;
}
const answer = (o: object): FakeStep => ({
  output: { items: [], facts: [], relations: [], terms: [], definitions: [], ...o },
});
const project = { ref: "p", type: "Project", name: "미리내 프로젝트", existingItemId: null };
const system = { ref: "s", type: "System", name: "물결 시스템", existingItemId: null };
const fact = (item: string, kind: string, value: string, quote: string) => ({
  item,
  kind,
  value,
  epistemic: "explicit",
  quote,
});
const relation = (subject: string, object: string) => ({
  subject,
  type: "DEPENDS_ON",
  object,
  quote: Q_REL,
});
const items = () => db.all("SELECT type, name FROM items ORDER BY id");
const facts = () => db.all("SELECT kind, value FROM facts ORDER BY id");
const relations = () => db.all("SELECT type FROM relations ORDER BY id");
const idOf = (kind: string, name: string) =>
  (
    listOntologyElements(db).find((e) => e.elementKind === kind && e.name === name) as {
      id: number;
    }
  ).id;
const change = (c: OntologyChange) => {
  const out = userDecisions.ontology.change(db, c);
  if (out.status !== "applied") throw new Error(JSON.stringify(out));
};
const factRule = (name: string, over: object) => {
  const e = listOntologyElements(db).find((x) => x.name === name) as { rule: object };
  change({
    op: "change-rule",
    elementKind: "fact-kind",
    name,
    rule: { ...e.rule, ...over } as never,
  });
};

describe("ontology.enforce: the registry decides what is written (S01-R21)", () => {
  it("keeps what fits the seed", async () => {
    setUp([
      answer({
        items: [project, system],
        facts: [fact("p", "target_date", "2026-12-05", Q_PROJECT)],
        relations: [relation("p", "s")],
      }),
    ]);
    imported();
    const job = await run();
    expect(facts()).toEqual([{ kind: "target_date", value: "2026-12-05" }]);
    expect(relations()).toEqual([{ type: "DEPENDS_ON" }]);
    expect(readExtractionDrops(db, job.id)).toEqual({ quotes: 0, other: 0 });
  });

  it("drops a value that is no calendar date under the date kind, and keeps the same text once the kind's value kind is text", async () => {
    const bad = ["2026-02-30", "2026-11-31", "12월 5일", "2026-1-5"];
    setUp([
      answer({ items: [project], facts: bad.map((v) => fact("p", "target_date", v, Q_PROJECT)) }),
    ]);
    imported();
    const first = await run();
    expect(facts()).toEqual([]);
    expect(items()).toEqual([]);
    expect(readExtractionDrops(db, first.id)).toEqual({ quotes: 0, other: 4 });
    factRule("target_date", { valueType: "text" });
    setUp([
      answer({
        items: [project],
        facts: bad.slice(2).map((v) => fact("p", "target_date", v, Q_PROJECT)),
      }),
    ]);
    imported();
    const second = await run();
    expect(facts()).toEqual([
      { kind: "target_date", value: "12월 5일" },
      { kind: "target_date", value: "2026-1-5" },
    ]);
    expect(readExtractionDrops(db, second.id)).toEqual({ quotes: 0, other: 0 });
  });

  it.each(["candidate", "rejected", "superseded"] as const)(
    "drops a fact of a fact kind that is %s, a relation of a relation type that is %s, and an item type that is %s with what rests on it",
    async (status) => {
      setOntologyStatusForTest(db, idOf("fact-kind", "target_date"), status);
      setUp([
        answer({
          items: [project, system],
          facts: [
            fact("p", "target_date", "2026-12-05", Q_PROJECT),
            fact("s", "completion_date", "2026-12-06", Q_SYSTEM),
          ],
        }),
      ]);
      imported();
      const one = await run();
      expect(facts()).toEqual([{ kind: "completion_date", value: "2026-12-06" }]);
      expect(readExtractionDrops(db, one.id)).toEqual({ quotes: 0, other: 1 });

      setOntologyStatusForTest(db, idOf("relation-type", "DEPENDS_ON"), status);
      setUp([answer({ items: [project, system], relations: [relation("p", "s")] })]);
      imported();
      const two = await run();
      expect(relations()).toEqual([]);
      expect(readExtractionDrops(db, two.id)).toEqual({ quotes: 0, other: 1 });

      setOntologyStatusForTest(db, idOf("item-type", "Project"), status);
      setUp([
        answer({
          items: [project, system],
          facts: [
            fact("p", "completion_date", "2026-12-05", Q_PROJECT),
            fact("s", "completion_date", "2026-12-06", Q_SYSTEM),
          ],
        }),
      ]);
      imported();
      const three = await run();
      expect(facts().length).toBe(2); // the earlier completion_date and the System's new one
      expect(items().filter((i) => i.type === "Project")).toEqual([]);
      expect(readExtractionDrops(db, three.id)).toEqual({ quotes: 0, other: 1 });
    },
  );

  it.each(["text", "surface-form"] as const)(
    "drops a value that is empty after trimming under the %s kind, and keeps a value with text (review F4)",
    async (valueType) => {
      // the prompt's schema takes any string of one character or more, so "   " reaches the check
      factRule("target_date", { valueType });
      setUp([
        answer({
          items: [project],
          facts: [
            fact("p", "target_date", "   ", Q_PROJECT),
            fact("p", "target_date", "soon", Q_PROJECT),
          ],
        }),
      ]);
      imported();
      const job = await run();
      expect(facts()).toEqual([{ kind: "target_date", value: "soon" }]);
      expect(readExtractionDrops(db, job.id)).toEqual({ quotes: 0, other: 1 });
    },
  );

  it("drops a fact whose item type the fact kind's rule does not name, for a new item and for an existing one by its stored type", async () => {
    factRule("target_date", { itemTypes: ["System"] });
    setUp([
      answer({
        items: [project, system],
        facts: [
          fact("p", "target_date", "2026-12-05", Q_PROJECT),
          fact("s", "target_date", "2026-12-06", Q_SYSTEM),
        ],
      }),
    ]);
    imported();
    const one = await run();
    expect(facts()).toEqual([{ kind: "target_date", value: "2026-12-06" }]);
    expect(readExtractionDrops(db, one.id)).toEqual({ quotes: 0, other: 1 });

    // the answer calls the stored Project a System: the stored type decides
    const stored = db.all("SELECT id FROM items WHERE type = 'System'")[0]?.id as number;
    expect(stored).toBeGreaterThan(0);
    const projectId = insertItem(db, {
      type: "Project",
      name: "미리내 프로젝트",
      epistemic: "explicit",
      status: "candidate",
      validAt: null,
      observedAt: "2026-11-21T00:00:00Z",
    });
    setUp([
      answer({
        items: [
          { ref: "x", type: "System", name: "미리내 프로젝트", existingItemId: String(projectId) },
        ],
        facts: [fact("x", "target_date", "2026-12-05", Q_PROJECT)],
      }),
    ]);
    imported();
    const two = await run();
    expect(facts()).toEqual([{ kind: "target_date", value: "2026-12-06" }]);
    expect(readExtractionDrops(db, two.id)).toEqual({ quotes: 0, other: 1 });

    // and the other way round: the answer calls the stored System a Project; the stored type fits the rule
    setUp([
      answer({
        items: [{ ref: "y", type: "Project", name: "물결 시스템", existingItemId: String(stored) }],
        facts: [fact("y", "target_date", "2026-12-07", Q_SYSTEM)],
      }),
    ]);
    imported();
    const three = await run();
    expect(facts()).toEqual([
      { kind: "target_date", value: "2026-12-06" },
      { kind: "target_date", value: "2026-12-07" },
    ]);
    expect(readExtractionDrops(db, three.id)).toEqual({ quotes: 0, other: 0 });
  });

  it("drops a relation that runs against its direction, with no item made for it, and keeps the one that fits", async () => {
    change({
      op: "change-rule",
      elementKind: "relation-type",
      name: "DEPENDS_ON",
      rule: {
        elementKind: "relation-type",
        subjectTypes: ["System"],
        objectTypes: ["Project"],
        symmetric: false,
      },
    });
    setUp([answer({ items: [project, system], relations: [relation("p", "s")] })]);
    imported();
    const wrong = await run();
    expect(relations()).toEqual([]);
    expect(items()).toEqual([]);
    expect(readExtractionDrops(db, wrong.id)).toEqual({ quotes: 0, other: 1 });
    setUp([answer({ items: [project, system], relations: [relation("s", "p")] })]);
    imported();
    const right = await run();
    expect(relations()).toEqual([{ type: "DEPENDS_ON" }]);
    expect(readExtractionDrops(db, right.id)).toEqual({ quotes: 0, other: 0 });
  });

  it("checks each end of a relation against its side of the direction, and that both end types are verified", async () => {
    change({
      op: "change-rule",
      elementKind: "relation-type",
      name: "DEPENDS_ON",
      rule: {
        elementKind: "relation-type",
        subjectTypes: ["System"],
        objectTypes: ["Project"],
        symmetric: false,
      },
    });
    const body = (a: string, b: string) =>
      answer({ items: [project, system], relations: [relation(a, b)] });
    // only the subject is wrong (Project -> Project), only the object is wrong (System -> System)
    for (const [a, b] of [
      ["p", "p"],
      ["s", "s"],
    ]) {
      setUp([body(a as string, b as string)]);
      imported();
      const job = await run();
      expect(relations(), `${a}${b}`).toEqual([]);
      expect(readExtractionDrops(db, job.id)).toEqual({ quotes: 0, other: 1 });
    }
    // an end type that is no longer verified drops the relation even where a rule still lists it
    setOntologyStatusForTest(db, idOf("item-type", "Project"), "superseded");
    setUp([body("s", "p")]);
    imported();
    expect(readExtractionDrops(db, (await run()).id)).toEqual({ quotes: 0, other: 1 });
    expect(relations()).toEqual([]);
    setOntologyStatusForTest(db, idOf("item-type", "Project"), "verified");
    setOntologyStatusForTest(db, idOf("item-type", "System"), "superseded");
    setUp([body("s", "p")]);
    imported();
    expect(readExtractionDrops(db, (await run()).id)).toEqual({ quotes: 0, other: 1 });
    expect(relations()).toEqual([]);
  });

  it("does not stop a write for a value count of one: two values for one item are both written", async () => {
    setUp([
      answer({
        items: [project],
        facts: [
          fact("p", "target_date", "2026-12-05", Q_PROJECT),
          fact("p", "target_date", "2026-12-06", Q_SYSTEM),
        ],
      }),
    ]);
    imported();
    const job = await run();
    expect(facts()).toHaveLength(2);
    expect(readExtractionDrops(db, job.id)).toEqual({ quotes: 0, other: 0 });
  });
});

describe("ontology.enforce: a new item type goes through the same devices (S01-R4)", () => {
  it("approves, undoes and deletes an item of a type added through the change path like any other", () => {
    change({ op: "add", name: "Team", rule: { elementKind: "item-type" } });
    change({
      op: "add",
      name: "team_note",
      rule: {
        elementKind: "fact-kind",
        itemTypes: ["Team"],
        valueType: "text",
        cardinality: "many",
      },
    });
    const saved = saveSourceRecord(db, "fixtures", {
      externalId: "t",
      title: "t",
      body: "팀 메모",
    });
    if (saved.status !== "created") throw new Error(saved.status);
    const basis = { sourceId: saved.sourceId, version: saved.version };
    const versionId = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
    const attrs = {
      epistemic: "explicit",
      status: "candidate",
      validAt: null,
      observedAt: "2026-11-21T00:00:00Z",
    } as const;
    const item = insertItem(db, { type: "Team", name: "팀", ...attrs });
    const note = saveFact(db, { itemId: item, kind: "team_note", value: "팀 메모", ...attrs }).id;
    automatedLifecycle.created(db, { kind: "item", id: item }, "extraction", basis);
    automatedLifecycle.created(db, { kind: "fact", id: note }, "extraction", basis);
    addEvidence(db, {
      target: { factId: note },
      sourceVersionId: versionId,
      start: 0,
      end: 4,
      quote: "팀 메모",
    });
    const ref = { kind: "item", id: item } as const;
    expect(userDecisions.decide(db, ref, "approve")).toMatchObject({ status: "applied" });
    expect(db.all("SELECT status FROM items WHERE id = ?", [item])).toEqual([
      { status: "verified" },
    ]);
    expect(userDecisions.undo(db, ref)).toMatchObject({ status: "applied" });
    expect(db.all("SELECT status FROM items WHERE id = ?", [item])).toEqual([
      { status: "candidate" },
    ]);
    expect(CANONICAL_KINDS.map((k) => k.kind)).toContain("item");
    db.transaction(() =>
      propagateCanonical(db, {
        kind: "source-deleted",
        sourceId: saved.sourceId,
        coversVersion: 1,
        lastRevision: null,
      }),
    );
    expect(db.all("SELECT 1 FROM facts WHERE id = ?", [note])).toEqual([]);
    expect(db.all("SELECT 1 FROM items WHERE id = ?", [item])).toEqual([]);
  });
});

describe("ontology.enforce: the seed and the prompt's lists (S01-R18)", () => {
  /** The item types S02-R2 adds to the date kinds' and DEPENDS_ON's rules (S02-T02 puts them into the prompt). */
  const S02_WIDENED = ["Commitment", "Task"];
  /** The item types a surface form is written on, and a definition (S01-R2, R3). */
  const FORM_TYPES = ["Concept", "Project", "System"];
  // "Items are projects (Project) or systems (System)" carry the dates and the relation; Concept carries
  // the definitions (S01-R17)
  const WORK = ["Project", "System"];
  const seed = (kind: string) =>
    listOntologyElements(db).filter((e) => e.elementKind === kind && e.origin === "seed");

  it("holds every name the prompt lists, verified, with the shape the prompt's instructions describe", () => {
    for (const type of EXTRACT_ITEM_TYPES) {
      expect(seed("item-type").find((e) => e.name === type)?.status).toBe("verified");
    }
    for (const name of EXTRACT_FACT_KINDS) {
      const element = seed("fact-kind").find((e) => e.name === name);
      expect(element?.status).toBe("verified");
      // "the date as YYYY-MM-DD", one per item; S02-R2 widens it to Task and Commitment
      expect(element?.rule).toEqual({
        elementKind: "fact-kind",
        itemTypes: [...WORK, ...S02_WIDENED].sort(),
        valueType: "date",
        cardinality: "one",
      });
    }
    for (const name of EXTRACT_ALIAS_FACT_KINDS) {
      // a surface form is written on any of the item types, as the text it is, any number of them;
      // S03-R2 widens it to Metric and Dataset (the analytical migration)
      expect(seed("fact-kind").find((e) => e.name === name)?.rule).toEqual({
        elementKind: "fact-kind",
        itemTypes: [...FORM_TYPES, "Dataset", "Metric"].sort(),
        valueType: "surface-form",
        cardinality: "many",
      });
    }
    expect(seed("fact-kind").find((e) => e.name === EXTRACT_DEFINITION_FACT_KIND)?.rule).toEqual({
      elementKind: "fact-kind",
      itemTypes: ["Concept", "Dataset", "Metric"], // S03-R2 widens it
      valueType: "text",
      cardinality: "many",
    });
    for (const name of EXTRACT_RELATION_TYPES) {
      expect(seed("relation-type").find((e) => e.name === name)?.status).toBe("verified");
    }
    expect(seed("relation-type").find((e) => e.name === "DEPENDS_ON")?.rule).toEqual({
      elementKind: "relation-type",
      subjectTypes: [...WORK, ...S02_WIDENED].sort(),
      objectTypes: [...WORK, ...S02_WIDENED, "Dependency"].sort(),
      symmetric: false,
    });
    // S02-R2: an identifier is a text of its own value type; the key is one per item, the e-mail many
    expect(seed("fact-kind").find((e) => e.name === "identifier.key")?.rule).toMatchObject({
      valueType: "identifier",
      cardinality: "one",
      itemTypes: [...EXTRACT_ITEM_TYPES].sort(),
    });
    expect(seed("fact-kind").find((e) => e.name === "identifier.email")?.rule).toMatchObject({
      valueType: "identifier",
      cardinality: "many",
      itemTypes: ["Organization", "Person"],
    });
    expect(
      seed("fact-kind").find((e) => e.name === EXTRACT_STATEMENT_FACT_KIND)?.rule,
    ).toMatchObject({ valueType: "text", cardinality: "many" });
  });

  it("is the prompt's lists, a closed list: S01-T08 put Concept, definition and alias.* into the prompt, S02-T02 the rest of S02's catalogue, S03-T07 the analytical names", () => {
    // `dataset.column` is seeded and never extracted (S03-R2): the catalogue says so
    const prompt = {
      "item-type": [...EXTRACT_ITEM_TYPES, ...EXTRACT_ANALYTICAL_ITEM_TYPES] as string[],
      "fact-kind": [
        ...EXTRACT_FACT_KINDS,
        ...EXTRACT_IDENTIFIER_FACT_KINDS,
        ...EXTRACT_ALIAS_FACT_KINDS,
        EXTRACT_DEFINITION_FACT_KIND,
        EXTRACT_STATEMENT_FACT_KIND,
        ...EXTRACT_ANALYTICAL_FACT_KINDS,
      ] as string[],
      "relation-type": [
        ...EXTRACT_RELATION_TYPES,
        ...EXTRACT_ANALYTICAL_RELATION_TYPES,
      ] as string[],
    };
    for (const kind of ["item-type", "fact-kind", "relation-type"] as const) {
      const names = seed(kind)
        .map((e) => e.name)
        .filter((name) => !NOT_EXTRACTED_NAMES.includes(name));
      expect([...names].sort(), kind).toEqual([...prompt[kind]].sort());
    }
    for (const name of ["Concept", "definition", ...EXTRACT_ALIAS_FACT_KINDS]) {
      expect([...prompt["item-type"], ...prompt["fact-kind"]]).toContain(name);
    }
    expect(
      listOntologyElements(db).every((e) => e.status === "verified" && e.origin === "seed"),
    ).toBe(true);
  });
});
