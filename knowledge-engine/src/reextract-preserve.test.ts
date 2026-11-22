// S01-T03 `reextract.preserve` (S01-R12, R13, R14): what the user decided or wrote survives extraction
// running again, on the same source version and on a new one, through the real extract handler and
// the real propagation. The user's rows are made by the real user entry (approve, reject, value fix,
// direct add); no history line or column is forged. All data is synthetic.
import { createBroker, createUserActionLedger, type Broker } from "@pki/providers";
import {
  closeJob,
  isFenceCurrent,
  leaseNextJob,
  listEvidence,
  migrate,
  registerConnectorInstance,
  registerJob,
  saveSourceRecord,
  userDecisions,
  type EntryRef,
  type SqlDriver,
  type StoredJob,
  type UserEntry,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { FakeProvider, fixtureExtraction, type FakeStep } from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExtractHandler } from "./extraction.ts";
import { knowledgeCandidates } from "./linking.ts";
import { propagateNewVersion } from "./propagation.ts";

const T0 = new Date("2026-11-23T00:00:00.000Z");
const NAME = "미리내 프로젝트";
const sentence = (date: string) => `${NAME}의 완료 목표는 ${date}입니다`;
const body = (dates: string[]) => [`${NAME} 일정 메모`, ...dates.map(sentence)].join("\n");

// the values the source states, and what the user does with each
const APPROVED = "2026-12-05";
const REJECTED = "2026-12-06";
const FIXED_VERIFIED = "2026-12-07"; // approved, then its value fixed: the old row is superseded
const FIXED_CANDIDATE = "2026-12-08"; // a candidate whose value is fixed: the old row is rejected
const ALL = [APPROVED, REJECTED, FIXED_VERIFIED, FIXED_CANDIDATE];

let db: SqlDriver;
let revision = 0;
let provider: FakeProvider;
let handler: ReturnType<typeof createExtractHandler>;
let recording: { call(raw: unknown): ReturnType<Broker["call"]> };

function setUp(script: FakeStep[]) {
  provider = new FakeProvider({ answer: fixtureExtraction(), script });
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

/** The provider's answer for a source stating `dates`; `existing` is the item an earlier extraction made. */
const answer = (dates: string[], existing: string | null = null): FakeStep => ({
  output: {
    items: [{ ref: "a", type: "Project", name: NAME, existingItemId: existing }],
    facts: dates.map((date) => ({
      item: "a",
      kind: "target_date",
      value: date,
      epistemic: "explicit",
      quote: sentence(date),
    })),
    definitions: [],
    terms: [],
    relations: [],
  },
});

beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "imported", "jsonl-import");
});
afterEach(() => db.close());

/** Stores a version of the source and queues its extraction job, as a sync does. */
function store(dates: string[]): StoredJob {
  return db.transaction(() => {
    const saved = saveSourceRecord(db, "imported", {
      externalId: "doc",
      title: "t",
      body: `${body(dates)}\n개정 ${++revision}`, // a new revision is a new version, whatever the statements say
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

async function runNext() {
  const job = leaseNextJob(db, { kinds: ["extract"], now: T0, leaseMs: 60_000 });
  const fence = { sourceId: job?.sourceId as number, fenceVersion: job?.fenceVersion as number };
  if (!job || !isFenceCurrent(db, fence)) throw new Error("expected a current job");
  const result = await handler(job, { broker: recording });
  if (result.status === "succeeded" || result.status === "held") closeJob(db, job, result);
  return result.status;
}

/** A new source version arrives: the product stores it and propagates, then extracts it. */
async function newVersion(dates: string[]) {
  const job = store(dates);
  const propagation = propagateNewVersion(db, job.sourceId as number);
  return { job, propagation, extraction: () => runNext() };
}

const fact = (value: string): EntryRef => ({
  kind: "fact",
  id: db.all("SELECT id FROM facts WHERE value = ?", [value])[0]?.id as number,
});
const snapshot = () =>
  db.all(
    "SELECT id, item_id, kind, value, status, epistemic, confidence, user_authored FROM facts ORDER BY id",
  );
const histories = () =>
  db.all(
    "SELECT fact_id, seq, actor, action, from_status, to_status FROM fact_history ORDER BY fact_id, seq",
  );
const evidenceCount = (ref: EntryRef) => listEvidence(db, { factId: ref.id }).length;
const state = (value: string) => {
  const r = db.all("SELECT status, epistemic, user_authored FROM facts WHERE value = ?", [
    value,
  ])[0];
  return r && { status: r.status, epistemic: r.epistemic, authored: r.user_authored };
};
const itemId = () => db.all("SELECT id FROM items")[0]?.id as number;

function add(entry: UserEntry) {
  const r = userDecisions.add(db, entry);
  if (r.status !== "applied") throw new Error(`add refused: ${r.reason}`);
  return r.ref;
}
function fix(old: EntryRef, value: string) {
  const r = userDecisions.replaceValue(db, old, value);
  if (r.status !== "applied") throw new Error(`fix refused: ${r.reason}`);
  return r.added;
}

/** v1 extracted and the user's four decisions and one direct add made; returns the new rows. */
async function userCorrected() {
  store(ALL);
  expect(await runNext()).toBe("succeeded");
  userDecisions.decide(db, fact(APPROVED), "approve");
  userDecisions.decide(db, fact(REJECTED), "reject");
  userDecisions.decide(db, fact(FIXED_VERIFIED), "approve");
  const fixedVerified = fix(fact(FIXED_VERIFIED), "2026-12-27");
  const fixedCandidate = fix(fact(FIXED_CANDIDATE), "2026-12-28");
  const written = add({
    kind: "fact",
    itemId: itemId(),
    factKind: "target_date",
    value: "2026-12-25",
  });
  return { fixedVerified, fixedCandidate, written };
}

describe("reextract.preserve: the same source version again", () => {
  it("leaves every approved, rejected, fixed and added row as it is, and writes no line", async () => {
    setUp([answer(ALL), answer(ALL, "1")]);
    await userCorrected();
    const rows = snapshot();
    const lines = histories();
    // the job ran and was closed; the same version is extracted once more (a retried or re-queued job)
    db.run("DELETE FROM jobs");
    const version = db.all("SELECT source_id, version FROM source_versions ORDER BY id DESC")[0];
    const queued = registerJob(db, {
      kind: "extract",
      sourceId: version?.source_id as number,
      fenceVersion: version?.version as number,
      at: T0,
    });
    expect(queued.registered).toBe(true);
    expect(await runNext()).toBe("succeeded");
    expect(provider.requests).toHaveLength(2);
    expect(snapshot()).toEqual(rows);
    expect(histories()).toEqual(lines);
    for (const value of ALL) expect(evidenceCount(fact(value))).toBe(1); // the same span is not added twice
  });
});

describe("reextract.preserve: a new source version", () => {
  it("keeps the status, the epistemic type and the value of all four kinds of correction", async () => {
    setUp([answer(ALL), answer(ALL, "1")]);
    const { fixedVerified, fixedCandidate, written } = await userCorrected();
    const before = snapshot();

    const next = await newVersion(ALL);
    // the propagation passes the user's rows over: the rejected, the fixed, the written; and counts only what it superseded
    expect(next.propagation.facts).toEqual([fact(APPROVED).id]); // approved WITH current evidence: it is superseded like any
    expect(state("2026-12-25")).toEqual({
      status: "verified",
      epistemic: "user-approved",
      authored: 1,
    });
    expect(state(REJECTED)?.status).toBe("rejected");
    expect(state(FIXED_VERIFIED)?.status).toBe("superseded");
    expect(state(FIXED_CANDIDATE)?.status).toBe("rejected");
    await next.extraction();

    // the source states every old value again; nothing the user decided or wrote moved
    expect(snapshot()).toEqual(before);
    expect(state(APPROVED)).toEqual({
      status: "verified",
      epistemic: "user-approved",
      authored: 0,
    });
    expect(state(REJECTED)).toEqual({ status: "rejected", epistemic: "explicit", authored: 0 });
    expect(state(FIXED_VERIFIED)?.status).toBe("superseded"); // verified-then-corrected: not revived
    expect(state(FIXED_CANDIDATE)?.status).toBe("rejected");
    for (const row of [fixedVerified, fixedCandidate, written]) {
      expect(
        db.all("SELECT status, epistemic, user_authored FROM facts WHERE id = ?", [row.id]),
      ).toEqual([{ status: "verified", epistemic: "user-approved", user_authored: 1 }]);
    }
    // the evidence of the new version is added to the rows it states again, all the same
    for (const value of ALL) expect(evidenceCount(fact(value))).toBe(2);
  });

  it("does not bring a corrected old value back to candidate when it is stated again, the row it was fixed to staying verified", async () => {
    setUp([answer(ALL), answer([FIXED_VERIFIED, FIXED_CANDIDATE], "1")]);
    const { fixedVerified, fixedCandidate } = await userCorrected();
    const next = await newVersion([FIXED_VERIFIED, FIXED_CANDIDATE]);
    await next.extraction();
    expect(state(FIXED_VERIFIED)?.status).toBe("superseded");
    expect(state(FIXED_CANDIDATE)?.status).toBe("rejected");
    expect(
      db.all("SELECT status FROM facts WHERE id IN (?, ?)", [fixedVerified.id, fixedCandidate.id]),
    ).toEqual([{ status: "verified" }, { status: "verified" }]);
  });

  it("keeps the user's row verified when an extraction attached evidence to it and the next version drops the value (R14)", async () => {
    const mine = "2026-12-09";
    setUp([answer([APPROVED]), answer([APPROVED, mine], "1"), answer([APPROVED], "1")]);
    store([APPROVED]);
    await runNext();
    // the user wrote the value before any source stated it
    const written = add({ kind: "fact", itemId: itemId(), factKind: "target_date", value: mine });

    const stated = await newVersion([APPROVED, mine]);
    await stated.extraction();
    expect(evidenceCount(written)).toBe(1); // the extraction found the row by its value and added the evidence
    expect(state(mine)).toEqual({ status: "verified", epistemic: "user-approved", authored: 1 });

    const dropped = await newVersion([APPROVED]);
    // the evidence of the row is past evidence now; the approved candidate beside it is superseded, the user's row is not
    expect(dropped.propagation.facts).toEqual([fact(APPROVED).id]);
    await dropped.extraction();
    expect(state(mine)).toEqual({ status: "verified", epistemic: "user-approved", authored: 1 });
    expect(histories().filter((l) => l.fact_id === written.id)).toHaveLength(1); // the creation line alone
  });

  it("brings an approved row back, verified and user-approved, when the source drops the content and states it again", async () => {
    setUp([answer([APPROVED]), answer([]), answer([APPROVED], "1")]);
    store([APPROVED]);
    await runNext();
    userDecisions.decide(db, fact(APPROVED), "approve");
    const approved = fact(APPROVED);

    const dropped = await newVersion([]);
    expect(dropped.propagation.facts).toEqual([approved.id]);
    await dropped.extraction();
    expect(state(APPROVED)?.status).toBe("superseded");

    const back = await newVersion([APPROVED]);
    await back.extraction();
    expect(state(APPROVED)).toEqual({
      status: "verified",
      epistemic: "user-approved",
      authored: 0,
    });
    expect(
      histories()
        .filter((l) => l.fact_id === approved.id)
        .map((l) => [l.actor, l.action]),
    ).toEqual([
      ["extraction", "created"],
      ["user", "approve"],
      ["propagation", "supersede"],
      ["extraction", "evidence-returned"],
    ]);
  });
});
