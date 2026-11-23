// P03-C3a (R11, R12): feedback and its effect survive extraction of a new source version and the
// re-review job, through the real handlers, and a deletion that removes the target row removes the feedback
// line with it. The correction and the preference are recorded through the real feedback module. All data is
// synthetic.
import { createBroker, createUserActionLedger } from "@pki/providers";
import {
  canonicalTransaction,
  closeJob,
  commitDerived,
  isFenceCurrent,
  leaseNextJob,
  preferenceSignals,
  prepareCanonicalDb,
  recordFeedback,
  registerConnectorInstance,
  registerJob,
  saveSourceRecord,
  userDecisions,
  type EntryRef,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { FakeProvider, fixtureExtraction } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExtractHandler } from "./extraction.ts";
import { knowledgeCandidates } from "./linking.ts";
import { propagateNewVersion } from "./propagation.ts";
import { createReflectHandler } from "./reflect-job.ts";
import { applyTombstone } from "./tombstone-entry.ts";

const T0 = new Date("2026-11-23T00:00:00.000Z");
const AT = T0.toISOString();
const NAME = "미리내 프로젝트";
const KEPT = "2026-12-05";
const WRONG = "2026-12-06";
const sentence = (date: string) => `${NAME}의 완료 목표는 ${date}입니다`;
const body = (revision: number) =>
  [`${NAME} 일정 메모`, sentence(KEPT), sentence(WRONG), `개정 ${revision}`].join("\n");

let dir: string;
let db: SqlDriver;
let handler: ReturnType<typeof createExtractHandler>;
let recording: { call(raw: unknown): ReturnType<ReturnType<typeof createBroker>["call"]> };
let revision = 0;

const extraction = (existing: string | null) => ({
  output: {
    items: [{ ref: "a", type: "Project", name: NAME, existingItemId: existing }],
    facts: [KEPT, WRONG].map((value) => ({
      item: "a",
      kind: "target_date",
      value,
      epistemic: "explicit",
      quote: sentence(value),
    })),
    definitions: [],
    terms: [],
    relations: [],
  },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-feedback-"));
  db = openBetterSqlite3(join(dir, "pki.sqlite"));
  prepareCanonicalDb(db);
  registerConnectorInstance(db, "imported", "jsonl-import");
  const provider = new FakeProvider({
    answer: fixtureExtraction(),
    script: [extraction(null), extraction("1")],
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
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const store = (): StoredJob =>
  db.transaction(() => {
    const saved = saveSourceRecord(db, "imported", {
      externalId: "doc",
      title: "t",
      body: body(++revision),
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

async function extract() {
  const job = leaseNextJob(db, { kinds: ["extract"], now: T0, leaseMs: 60_000 });
  const fence = { sourceId: job?.sourceId as number, fenceVersion: job?.fenceVersion as number };
  if (!job || !isFenceCurrent(db, fence)) throw new Error("expected a current job");
  const result = await handler(job, { broker: recording });
  if (result.status === "succeeded" || result.status === "held") closeJob(db, job, result);
  expect(result.status).toBe("succeeded");
}

const factRef = (value: string): EntryRef => ({
  kind: "fact",
  id: db.all("SELECT id FROM facts WHERE value = ?", [value])[0]?.id as number,
});
const feedbackRows = () => db.all("SELECT * FROM feedback ORDER BY id");
const statuses = () => db.all("SELECT value, status FROM facts ORDER BY id");
const signal = () => {
  const item = db.all("SELECT id FROM items")[0]?.id as number;
  return preferenceSignals(db, [{ kind: "item", id: item }]);
};

describe("feedback.lifecycle (P03-C3a)", () => {
  it("keeps the lines, the corrected state and the signal through a new version and a re-review, and drops with the row", async () => {
    store();
    await extract();
    const item = db.all("SELECT id FROM items")[0]?.id as number;
    const wrong = recordFeedback(
      db,
      userDecisions,
      { target: factRef(WRONG), kind: "wrong_info" },
      AT,
    );
    const important = recordFeedback(
      db,
      userDecisions,
      { target: { kind: "item", id: item }, kind: "important" },
      AT,
    );
    expect(wrong).toMatchObject({ status: "applied", touched: factRef(WRONG) });
    expect(important.status).toBe("applied");
    const lines = feedbackRows();
    const states = statuses();
    const signals = signal();
    expect(states).toContainEqual({ value: WRONG, status: "rejected" });
    expect(signals[0]).toMatchObject({ weight: 100, source: "direct" });

    // a new version of the source, extracted again by the real handler after the real propagation
    const next = store();
    propagateNewVersion(db, next.sourceId as number);
    await extract();
    // the re-review job as the runner runs it
    const reflected = await createReflectHandler({ db, now: () => T0 })({ id: 1, target: "daily" });
    db.transaction(() => commitDerived(db, { source: null, items: reflected.items }));

    expect(feedbackRows()).toEqual(lines);
    expect(statuses().find((r) => r.value === WRONG)).toEqual({ value: WRONG, status: "rejected" });
    expect(signal()).toEqual(signals);

    // deleting the source removes the item and the facts, and the feedback goes with them
    canonicalTransaction(db, (tx) =>
      applyTombstone(tx, {
        identity: { connectorInstanceId: "imported", namespace: "", externalId: "doc" },
        reason: "source-deleted",
        lastRevision: null,
        at: AT,
      }),
    );
    expect(db.all("SELECT id FROM items")).toEqual([]);
    expect(feedbackRows()).toEqual([]);
  });
});
