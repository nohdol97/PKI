// S01-T05 the places the judgement is called (S01-R9: "after the extraction attached evidence and after
// the propagation took evidence away, in the same transaction"), through the real extract handler and
// the real propagation, tombstone and prune entries. The setting is OFF by default: the first test runs
// the V02 flow with the setting absent and with it 'off' and finds no policy line and the same bytes.
// All data is synthetic; the user's rows are made by the real user entry.
import { createBroker, createUserActionLedger } from "@pki/providers";
import {
  canonicalTransaction,
  closeJob,
  createCommitScope,
  isFenceCurrent,
  leaseNextJob,
  migrate,
  registerConnectorInstance,
  registerJob,
  saveSourceRecord,
  userDecisions,
  writeSetting,
  type CommitScope,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { FakeProvider, fixtureExtraction, type FakeStep } from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTO_VERIFY_SETTING } from "./auto-verify.ts";
import { createExtractHandler } from "./extraction.ts";
import { knowledgeCandidates } from "./linking.ts";
import { defaultEntries } from "./entries.ts";
import { applyTombstone } from "./tombstone-entry.ts";
import { propagateNewVersion } from "./propagation.ts";

const T0 = new Date("2026-11-23T00:00:00.000Z");
const NAME = "미리내 프로젝트";
const sentence = (date: string) => `${NAME}의 완료 목표는 ${date}입니다`;
const DATE = "2026-12-05";
const RIVAL = "2026-12-19";

let db: SqlDriver;
let provider: FakeProvider;
let handler: ReturnType<typeof createExtractHandler>;
let broker: { call(raw: unknown): ReturnType<ReturnType<typeof createBroker>["call"]> };
let revision = 0;

function setUp(script: FakeStep[]) {
  provider = new FakeProvider({ answer: fixtureExtraction(), script });
  const real = createBroker({
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
  broker = { call: (raw) => real.call(raw) };
  handler = createExtractHandler({ db, now: () => T0 });
}

/** What the provider says about the source: `dates` stated, the item new or the one stored (`existing`). */
const says = (
  dates: string[],
  existing: string | null = null,
  epistemic: "explicit" | "hypothesis" = "explicit",
): FakeStep => ({
  output: {
    items: [{ ref: "a", type: "Project", name: NAME, existingItemId: existing }],
    facts: dates.map((date) => ({
      item: "a",
      kind: "target_date",
      value: date,
      epistemic,
      quote: sentence(date),
    })),
    relations: [],
    terms: [],
    definitions: [],
  },
});

beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "imported", "jsonl-import");
});
afterEach(() => db.close());

const IDENTITY = (externalId: string) => ({
  connectorInstanceId: "imported",
  namespace: "",
  externalId,
});
/** Stores a version of source `externalId` stating `dates` and queues its extraction. */
function store(externalId: string, dates: string[], extra: string[] = []): StoredJob {
  return db.transaction(() => {
    const saved = saveSourceRecord(db, "imported", {
      externalId,
      title: externalId,
      body: [`${NAME} 일정 메모`, ...dates.map(sentence), ...extra, `개정 ${++revision}`].join(
        "\n",
      ),
    });
    if (saved.status !== "created") throw new Error("expected a new version");
    const queued = registerJob(db, {
      kind: "extract",
      sourceId: saved.sourceId,
      fenceVersion: saved.version,
      at: T0,
    });
    if (!queued.registered) throw new Error("expected a new job");
    return queued.job;
  });
}
async function run(externalId: string, dates: string[], extra: string[] = [], scope?: CommitScope) {
  store(externalId, dates, extra);
  const job = leaseNextJob(db, { kinds: ["extract"], now: T0, leaseMs: 60_000 });
  const fence = { sourceId: job?.sourceId as number, fenceVersion: job?.fenceVersion as number };
  if (!job || !isFenceCurrent(db, fence)) throw new Error("expected a current job");
  const result = await handler(job, { broker });
  if (result.status !== "succeeded") throw new Error(`extraction ${result.status}`);
  closeJob(db, job, result, undefined, scope);
}
/** A new version of a source already stored: propagation first, then its extraction, as the product runs them. */
async function nextVersion(externalId: string, dates: string[]) {
  const job = store(externalId, dates);
  propagateNewVersion(db, job.sourceId as number);
  const leased = leaseNextJob(db, { kinds: ["extract"], now: T0, leaseMs: 60_000 });
  if (!leased) throw new Error("expected a job");
  const result = await handler(leased, { broker });
  if (result.status !== "succeeded") throw new Error(`extraction ${result.status}`);
  closeJob(db, leased, result);
}
const deleteSource = (externalId: string) =>
  canonicalTransaction(db, (tx) =>
    applyTombstone(tx, {
      identity: IDENTITY(externalId),
      reason: "user-deleted",
      lastRevision: null,
      at: T0.toISOString(),
    }),
  );

const enable = () => writeSetting(db, AUTO_VERIFY_SETTING, "on");
const fact = (value: string) =>
  db.all("SELECT id, status, epistemic FROM facts WHERE value = ?", [value])[0] as
    { id: number; status: string; epistemic: string } | undefined;
const actions = (value: string) =>
  db
    .all(
      `SELECT h.actor, h.action, h.from_status, h.to_status, h.reason FROM fact_history h
       JOIN facts f ON f.id = h.fact_id WHERE f.value = ? ORDER BY h.seq`,
      [value],
    )
    .map(
      (r) =>
        `${r.actor}:${r.action}:${r.from_status ?? "-"}>${r.to_status}${r.reason ? `(${r.reason})` : ""}`,
    );
const dump = () => ({
  facts: db.all("SELECT * FROM facts ORDER BY id"),
  items: db.all("SELECT * FROM items ORDER BY id"),
  history: db.all("SELECT * FROM fact_history ORDER BY fact_id, seq"),
  itemHistory: db.all("SELECT * FROM item_history ORDER BY item_id, seq"),
  evidence: db.all("SELECT * FROM evidence ORDER BY id"),
});
describe("the setting off: the V02 flow is unchanged (S01-R9 1)", () => {
  async function flow(setting: "absent" | "off") {
    db.close();
    db = openBetterSqlite3(":memory:");
    migrate(db);
    registerConnectorInstance(db, "imported", "jsonl-import");
    revision = 0;
    if (setting === "off") writeSetting(db, AUTO_VERIFY_SETTING, "off");
    setUp([says([DATE]), says([DATE], "1"), says([DATE], "1")]);
    await run("one", [DATE]);
    await run("two", [DATE]);
    await nextVersion("two", [RIVAL]);
    deleteSource("one");
    const result = dump();
    const policy = db.all("SELECT 1 FROM fact_history WHERE actor = 'policy'").length;
    return { result, policy };
  }

  it("two sources stating the value leave it a candidate, with no policy line, byte for byte as with no setting", async () => {
    const absent = await flow("absent");
    const off = await flow("off");
    expect(off.policy).toBe(0);
    expect(absent.policy).toBe(0);
    expect(off.result).toEqual(absent.result);
    expect(off.result.facts.every((f) => f.status !== "verified")).toBe(true);
  });
});

describe("after an extraction", () => {
  it("the second independent source promotes the fact in the same write; the first alone does not", async () => {
    enable();
    setUp([says([DATE]), says([DATE], "1")]);
    await run("one", [DATE]);
    expect(fact(DATE)?.status).toBe("candidate");
    expect(actions(DATE)).toEqual(["extraction:created:->candidate"]);
    await run("two", [DATE]);
    expect(fact(DATE)).toMatchObject({ status: "verified", epistemic: "explicit" });
    expect(actions(DATE)).toEqual([
      "extraction:created:->candidate",
      "policy:auto-verify:candidate>verified",
    ]);
  });

  it("a hypothesis stated explicitly by the second source is raised first and then promoted", async () => {
    enable();
    setUp([says([DATE], null, "hypothesis"), says([DATE], "1", "explicit")]);
    await run("one", [DATE]);
    expect(fact(DATE)).toMatchObject({ status: "candidate", epistemic: "hypothesis" });
    await run("two", [DATE]);
    expect(fact(DATE)).toMatchObject({ status: "verified", epistemic: "explicit" });
    expect(actions(DATE).map((a) => a.split("(")[0])).toEqual([
      "extraction:created:->candidate",
      "extraction:explicit-evidence:candidate>candidate",
      "policy:auto-verify:candidate>verified",
    ]);
  });

  it("a second source that states another value takes the first promotion back (the rival is a conflict)", async () => {
    enable();
    setUp([says([DATE]), says([DATE], "1"), says([RIVAL], "1")]);
    await run("one", [DATE]);
    await run("two", [DATE]);
    expect(fact(DATE)?.status).toBe("verified");
    await run("three", [RIVAL]);
    expect(fact(RIVAL)?.status).toBe("candidate");
    expect(fact(DATE)?.status).toBe("candidate");
    expect(actions(DATE).at(-1)).toBe(
      "policy:auto-verify-reverted:verified>candidate(conflicting-value)",
    );
  });

  it("the same extraction run twice writes no second line", async () => {
    enable();
    setUp([says([DATE]), says([DATE], "1"), says([DATE], "1")]);
    await run("one", [DATE]);
    await run("two", [DATE]);
    const before = actions(DATE);
    db.run("DELETE FROM jobs");
    const version = db.all("SELECT source_id, version FROM source_versions ORDER BY id DESC")[0];
    registerJob(db, {
      kind: "extract",
      sourceId: version?.source_id as number,
      fenceVersion: version?.version as number,
      at: T0,
    });
    const job = leaseNextJob(db, { kinds: ["extract"], now: T0, leaseMs: 60_000 });
    const result = await handler(job as StoredJob, { broker });
    expect(result.status).toBe("succeeded");
    closeJob(db, job as StoredJob, result as never);
    expect(actions(DATE)).toEqual(before);
  });

  it("a row the user decided is not touched by the extraction's judgement", async () => {
    enable();
    setUp([says([DATE]), says([DATE], "1")]);
    await run("one", [DATE]);
    userDecisions.decide(db, { kind: "fact", id: fact(DATE)?.id as number }, "reject");
    await run("two", [DATE]);
    expect(fact(DATE)).toMatchObject({ status: "rejected", epistemic: "explicit" });
    expect(actions(DATE).some((a) => a.startsWith("policy:"))).toBe(false);
  });
});

describe("after a propagation", () => {
  async function promoted() {
    enable();
    setUp([says([DATE]), says([DATE], "1"), says([DATE], "1")]);
    await run("one", [DATE]);
    await run("two", [DATE]);
    expect(fact(DATE)?.status).toBe("verified");
  }

  it("deleting one of the two sources takes the promotion back", async () => {
    await promoted();
    deleteSource("two");
    expect(fact(DATE)?.status).toBe("candidate");
    expect(actions(DATE).at(-1)).toBe(
      "policy:auto-verify-reverted:verified>candidate(independent-sources)",
    );
  });

  it("a new version of one source that no longer states the value takes it back, and the value is superseded only when no source holds it", async () => {
    await promoted();
    await nextVersion("two", ["2026-12-31"]);
    expect(fact(DATE)?.status).toBe("candidate");
    expect(actions(DATE).at(-1)).toBe(
      "policy:auto-verify-reverted:verified>candidate(independent-sources)",
    );
  });

  it("a new version that still states the value: between the propagation and its extraction the row has one current source, so it is taken back and promoted again once the extraction attaches the evidence", async () => {
    await promoted();
    await nextVersion("two", [DATE]);
    expect(fact(DATE)?.status).toBe("verified");
    expect(actions(DATE)).toEqual([
      "extraction:created:->candidate",
      "policy:auto-verify:candidate>verified",
      "policy:auto-verify-reverted:verified>candidate(independent-sources)",
      "policy:auto-verify:candidate>verified",
    ]);
  });

  it("pruning the old versions of a source that still states the value changes nothing", async () => {
    await promoted();
    await nextVersion("two", [DATE]);
    const before = actions(DATE);
    expect(fact(DATE)?.status).toBe("verified");
    defaultEntries.pruneVersions(db, IDENTITY("two"), T0.toISOString());
    expect(fact(DATE)?.status).toBe("verified");
    expect(actions(DATE)).toEqual(before);
  });

  it("removing the rival that blocked a promotion lets the fact be promoted at the propagation", async () => {
    enable();
    setUp([says([DATE]), says([RIVAL], "1"), says([DATE], "1")]);
    await run("one", [DATE]);
    await run("rival", [RIVAL]);
    await run("two", [DATE]);
    expect(fact(DATE)?.status).toBe("candidate"); // two sources, but a valid rival exists
    expect(actions(DATE).some((a) => a.startsWith("policy:"))).toBe(false);
    deleteSource("rival");
    expect(fact(RIVAL)).toBeUndefined();
    expect(fact(DATE)?.status).toBe("verified");
  });

  it("a promoted row the user then approved stays when a source goes away", async () => {
    await promoted();
    userDecisions.decide(db, { kind: "fact", id: fact(DATE)?.id as number }, "approve");
    deleteSource("two");
    expect(fact(DATE)).toMatchObject({ status: "verified", epistemic: "user-approved" });
    expect(actions(DATE).some((a) => a.startsWith("policy:auto-verify-reverted"))).toBe(false);
  });

  it("switched off after on: a source goes away and the promoted row is taken back (review M1)", async () => {
    await promoted();
    writeSetting(db, AUTO_VERIFY_SETTING, "off");
    deleteSource("two");
    expect(fact(DATE)?.status).toBe("candidate");
    expect(actions(DATE).at(-1)).toBe(
      "policy:auto-verify-reverted:verified>candidate(independent-sources)",
    );
  });

  it("switched off after on: a new second source does not promote", async () => {
    enable();
    setUp([says([DATE]), says([DATE], "1")]);
    await run("one", [DATE]);
    writeSetting(db, AUTO_VERIFY_SETTING, "off");
    await run("two", [DATE]);
    expect(fact(DATE)?.status).toBe("candidate");
    expect(actions(DATE)).toEqual(["extraction:created:->candidate"]);
  });
});

describe("the scope policy and the judgement (review D1-M1)", () => {
  it("a policy that refuses only the Insight rule item does not skip the judgement: the rival still takes the promotion back", async () => {
    enable();
    setUp([says([DATE]), says([DATE], "1"), says([RIVAL], "1")]);
    await run("one", [DATE]);
    await run("two", [DATE]);
    expect(fact(DATE)?.status).toBe("verified");
    // the judged items of the third run are the fact and then the rule: the second is refused
    let judged = 0;
    const scope = createCommitScope({
      policy: { combinable: () => ++judged !== 2 },
      now: () => T0.toISOString(),
    });
    await run("three", [RIVAL], [], scope);
    expect(judged).toBe(2);
    expect(db.all("SELECT 1 FROM scope_policy_drops")).toHaveLength(1); // the rule item was refused
    expect(fact(RIVAL)?.status).toBe("candidate");
    expect(fact(DATE)?.status).toBe("candidate");
    expect(actions(DATE).at(-1)).toBe(
      "policy:auto-verify-reverted:verified>candidate(conflicting-value)",
    );
  });
});

describe("one answer, many rows (review S1)", () => {
  for (const [label, second] of [
    ["DATE then RIVAL", [DATE, RIVAL]],
    ["RIVAL then DATE", [RIVAL, DATE]],
  ] as const) {
    it(`${label}: no promote-then-revert pair, the same final state and lines`, async () => {
      enable();
      setUp([says([DATE]), says([...second], "1")]);
      await run("one", [DATE]);
      await run("two", [...second]);
      expect(fact(DATE)?.status).toBe("candidate"); // a valid rival exists
      expect(fact(RIVAL)?.status).toBe("candidate");
      expect(actions(DATE)).toEqual(["extraction:created:->candidate"]);
      expect(actions(RIVAL)).toEqual(["extraction:created:->candidate"]);
    });
  }
});

describe("a relation", () => {
  const OTHER = "해오름 시스템";
  const link = `${NAME}는 ${OTHER}에 의존합니다`;
  const relationSays = (existing: [string, string] | null): FakeStep => ({
    output: {
      items: [
        { ref: "a", type: "Project", name: NAME, existingItemId: existing?.[0] ?? null },
        { ref: "b", type: "System", name: OTHER, existingItemId: existing?.[1] ?? null },
      ],
      facts: [],
      relations: [{ subject: "a", type: "DEPENDS_ON", object: "b", quote: link }],
      terms: [],
      definitions: [],
    },
  });
  const relation = () =>
    db.all("SELECT id, status FROM relations")[0] as { id: number; status: string };
  const relationActions = () =>
    db
      .all("SELECT actor, action FROM relation_history ORDER BY seq")
      .map((r) => `${r.actor}:${r.action}`);

  it("is promoted by the second independent source and taken back when that source goes", async () => {
    enable();
    setUp([relationSays(null), relationSays(["1", "2"])]);
    await run("one", [], [link]);
    expect(relation().status).toBe("candidate");
    await run("two", [], [link]);
    expect(relation().status).toBe("verified");
    deleteSource("two");
    expect(relation().status).toBe("candidate");
    expect(relationActions()).toEqual([
      "extraction:created",
      "policy:auto-verify",
      "policy:auto-verify-reverted",
    ]);
  });

  it("off: the same flow leaves it a candidate with only the creation line", async () => {
    setUp([relationSays(null), relationSays(["1", "2"])]);
    await run("one", [], [link]);
    await run("two", [], [link]);
    expect(relation().status).toBe("candidate");
    expect(relationActions()).toEqual(["extraction:created"]);
  });
});
