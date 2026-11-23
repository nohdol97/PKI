// S02-T07 `resolution.split` (extraction side; S02-R15, provisional decision 19): a row the user split away from an
// item is not made again on the original item when the same source says the same thing in a new version; the moved
// row takes the evidence instead. The limits are pinned: another value, and another source's same value, go to
// the original item. The split is made by the real user entry; the extraction runs through the real handler.
// All data is synthetic.
import { createBroker, createUserActionLedger, type Broker } from "@pki/providers";
import {
  closeJob,
  entityGroups,
  isFenceCurrent,
  leaseNextJob,
  listEvidence,
  migrate,
  registerConnectorInstance,
  registerJob,
  saveSourceRecord,
  listSplitMoves,
  userDecisions,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import {
  FakeProvider,
  fixtureExtraction,
  seedLegacyTombstone,
  type FakeStep,
  memoryDbTemplate,
} from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { propagateCanonical } from "./canonical-kinds.ts";
import { createExtractHandler } from "./extraction.ts";
import { knowledgeCandidates } from "./linking.ts";
import { propagateNewVersion } from "./propagation.ts";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);

const T0 = new Date("2026-11-23T00:00:00.000Z");
const NAME = "미리내 프로젝트";
const sentence = (date: string) => `${NAME}의 완료 목표는 ${date}입니다`;
const body = (dates: string[]) => [`${NAME} 일정 메모`, ...dates.map(sentence)].join("\n");

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
  db = freshDb();
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

const fact = (value: string, item?: number): number =>
  db.all(
    item === undefined
      ? "SELECT id FROM facts WHERE value = ?"
      : "SELECT id FROM facts WHERE value = ? AND item_id = ?",
    item === undefined ? [value] : [value, item],
  )[0]?.id as number;
const factsOf = (item: number) =>
  db.all("SELECT value FROM facts WHERE item_id = ? ORDER BY value", [item]).map((r) => r.value);
const evidenceOf = (id: number) => listEvidence(db, { factId: id }).length;
const statusOf = (id: number) => db.all("SELECT status FROM facts WHERE id = ?", [id])[0]?.status;

const D1 = "2026-12-05";
const D2 = "2026-12-06";
const D3 = "2026-12-07";

/** v1 states D1 and D2 on one item; the user splits D2 off to a new item; returns both items. */
async function splitAfterV1() {
  store([D1, D2]);
  expect(await runNext()).toBe("succeeded");
  const original = db.all("SELECT id FROM items WHERE user_authored = 0")[0]?.id as number;
  const split = db.transaction(() =>
    userDecisions.entities.split(db, original, [{ kind: "fact", id: fact(D2) }], "분리된 항목"),
  );
  if (split.status !== "applied") throw new Error(`split refused: ${split.reason}`);
  return { original, created: split.created, moved: fact(D2) };
}

describe("resolution.split: re-extraction of the same source (S02-R15)", () => {
  it("attaches the new version's evidence to the moved row and makes no row on the original item", async () => {
    setUp([answer([D1, D2]), answer([D1, D2], "1")]);
    const { original, created, moved } = await splitAfterV1();
    expect(factsOf(original)).toEqual([D1]);
    expect(factsOf(created)).toEqual([D2]);
    store([D1, D2]);
    expect(await runNext()).toBe("succeeded");
    expect(factsOf(original)).toEqual([D1]); // no D2 again on the original item
    expect(factsOf(created)).toEqual([D2]);
    expect(fact(D2)).toBe(moved);
    expect(evidenceOf(moved)).toBe(2); // the moved row got the new version's span
    expect(statusOf(moved)).toBe("candidate"); // not superseded
    expect(listSplitMoves(db).map((m) => [m.fromItemId, m.toItemId, m.factId])).toEqual([
      [original, created, moved],
    ]);
  });

  it("follows the key into the group the original item joined: the extraction writes on the top, not on the item the row left", async () => {
    // the user's other item carries the same name, so the extraction can pick it as the existing item
    const other = (
      userDecisions.add(db, { kind: "item", type: "Project", name: NAME }) as {
        ref: { id: number };
      }
    ).ref.id;
    setUp([answer([D1, D2]), answer([D1, D2], String(other))]);
    const { original, moved } = await splitAfterV1();
    db.transaction(() => userDecisions.entities.merge(db, original, other)); // `other` is the top
    store([D1, D2]);
    expect(await runNext()).toBe("succeeded");
    expect(factsOf(other)).toEqual([D1]); // D1 is new on the top; D2 was followed to the moved row
    expect(factsOf(original)).toEqual([D1]);
    expect(evidenceOf(moved)).toBe(2);
  });

  it("limit: a new version that states another value puts it on the original item and the moved row loses its evidence", async () => {
    setUp([answer([D1, D2]), answer([D1, D3], "1")]);
    const { original, moved } = await splitAfterV1();
    const job = store([D1, D3]);
    propagateNewVersion(db, job.sourceId as number);
    expect(await runNext()).toBe("succeeded");
    expect(factsOf(original)).toEqual([D1, D3]); // D3 went where the model put it
    expect(statusOf(moved)).toBe("superseded"); // the moved row has no current evidence any more
  });

  it("limit: another source stating the same value puts the row on the original item", async () => {
    setUp([answer([D1, D2]), answer([D2], "1")]);
    const { original, moved } = await splitAfterV1();
    db.transaction(() => {
      const saved = saveSourceRecord(db, "imported", {
        externalId: "doc-2",
        title: "t2",
        body: `${body([D2])}\n다른 문서`,
      });
      if (saved.status !== "created") throw new Error("source");
      registerJob(db, {
        kind: "extract",
        sourceId: saved.sourceId,
        fenceVersion: saved.version,
        at: T0,
      });
    });
    expect(await runNext()).toBe("succeeded");
    expect(factsOf(original)).toEqual([D1, D2]);
    expect(evidenceOf(moved)).toBe(1);
  });
});

describe("resolution.split: what comes after a split (S02-R15)", () => {
  it("deletes the moved row with its source and keeps the new item the user made", async () => {
    setUp([answer([D1, D2])]);
    const { created, moved } = await splitAfterV1();
    const sourceId = db.all("SELECT id FROM sources")[0]?.id as number;
    db.transaction(() => {
      seedLegacyTombstone(db, {
        sourceId,
        version: 1,
        at: T0.toISOString(),
        reason: "source-deleted",
      });
      propagateCanonical(
        db,
        { kind: "source-deleted", sourceId, coversVersion: 1, lastRevision: null },
        T0.toISOString(),
      );
    });
    expect(db.all("SELECT 1 FROM facts WHERE id = ?", [moved])).toEqual([]); // the row is the source's
    expect(db.all("SELECT 1 FROM item_split_moves")).toEqual([]);
    expect(db.all("SELECT user_authored FROM items WHERE id = ?", [created])).toEqual([
      { user_authored: 1 },
    ]); // the item is the user's
  });

  it("reads the original and the new item as one group when the user merges them again", async () => {
    setUp([answer([D1, D2])]);
    const { original, created } = await splitAfterV1();
    const merged = db.transaction(() => userDecisions.entities.merge(db, created, original));
    expect(merged.status).toBe("applied");
    expect(entityGroups.membersOf(db, original)).toEqual([original, created].sort((a, b) => a - b));
    expect(entityGroups.representativeOf(db, created)).toBe(original);
    // the merge cleared the split's distinct mark
    expect(db.all("SELECT 1 FROM item_distinct")).toEqual([]);
  });
});
