// K02-C4 (R16, R17): the `reflection-refine` job through the real Broker and a fake Provider. ① With the setting
// on, only a verdict whose quote is found in the stored body of the document it names is kept, in the opinion
// column alone: the finding's status and the rows of `evidence` and `facts` stay. ② Without consent the job
// is held and the Provider was never asked. ③ With the setting off no job is queued.
import { createBroker, createUserActionLedger, type BrokerResult } from "@pki/providers";
import {
  closeJob,
  leaseNextJob,
  listFindings,
  migrate,
  readFinding,
  readJob,
  REFLECTION_REFINE_KIND,
  requestReflectionRefinements,
  setReflectionRefine,
  type SqlDriver,
  type StoredFinding,
  type StoredJob,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { FakeProvider } from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { knowledgeCandidates } from "./linking.ts";
import { loadLintFixture, reflectNow, type LoadedLint } from "./lint.test-support.ts";
import { createReflectionRefineHandler } from "./reflection-refine-job.ts";

const AT = new Date("2026-11-23T00:00:00.000Z");
const QUOTE = "합성 자료 1";

let db: SqlDriver;
let loaded: LoadedLint;
let provider: FakeProvider;
let attempts: { outcome: string }[];

beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  loaded = loadLintFixture(db);
  reflectNow(db);
});
afterEach(() => db.close());

const counts = () =>
  Object.fromEntries(
    ["evidence", "facts", "relations"].map((t) => [
      t,
      db.all(`SELECT count(*) AS n FROM ${t}`)[0]?.n as number,
    ]),
  );
const synonym = (): StoredFinding => {
  const found = listFindings(db).find((f) => f.rule === "synonym");
  if (!found) throw new Error("no synonym finding");
  return found;
};

/** A Broker over a fake Provider that answers `quote` for the first document; `consent: false` refuses egress. */
function setUp(quote: string, consent = true) {
  attempts = [];
  provider = new FakeProvider({
    answer: ((request: { input: { untrustedDocuments: { id: string }[] } }) => ({
      verdict: "related",
      documentId: request.input.untrustedDocuments[0]?.id,
      quote,
    })) as never,
  });
  return createBroker({
    db,
    provider: () => provider,
    userActions: createUserActionLedger().redeemer,
    candidates: knowledgeCandidates(db),
    egress: {
      decide: () =>
        consent
          ? { allowed: true, destination: "fake", policyVersion: "pv" }
          : { allowed: false, reason: "consent-missing" },
    },
    execution: { decide: () => ({ run: true }) },
    recorder: {
      record: (entry: { outcome: string }) => void attempts.push(entry),
      begin: () => () => undefined,
      attemptTimes: () => [],
      interruptStarted: () => 0,
    },
    clock: { now: () => 0, sleep: async () => undefined },
  });
}

/** Asks for the refine jobs, leases the first and runs the handler, closing the job the way the runner does. */
async function run(broker: ReturnType<typeof setUp>) {
  setReflectionRefine(db, true);
  const queued = requestReflectionRefinements(db, AT);
  const job = leaseNextJob(db, {
    kinds: [REFLECTION_REFINE_KIND],
    now: new Date(),
    leaseMs: 60_000,
  }) as StoredJob;
  const result = await createReflectionRefineHandler({ db })(job, { broker });
  if (result.status === "succeeded") closeJob(db, job, result);
  else closeJob(db, job, { status: "held", reason: (result as { reason: string }).reason });
  return { queued, job, result: result as BrokerResult | { status: "succeeded" } };
}

describe("reflection.refine-job: only a located verdict is kept (K02-C4 ①)", () => {
  it("stores the verdict whose quote is in the document, and changes nothing else", async () => {
    const before = counts();
    const finding = synonym();
    await run(setUp(QUOTE));

    const after = synonym();
    expect(JSON.parse(after.opinion as string)).toEqual({
      verdict: "related",
      sourceId: loaded.sources.get("s1"),
      version: 1,
      start: 0,
      end: [...QUOTE].length,
    });
    expect(after.opinionLineageHash).not.toBeNull();
    expect(after.status).toBe(finding.status);
    expect(after.updatedAt).toBe(finding.updatedAt);
    expect(counts()).toEqual(before);
    expect(provider.requests).toHaveLength(1);
  });

  it("drops a verdict whose quote is not in the document: the finding keeps no opinion", async () => {
    const { job } = await run(setUp("원문에 없는 문장"));
    expect(synonym().opinion).toBeNull();
    expect(readJob(db, job.id)?.status).toBe("succeeded");
  });
});

describe("reflection.refine-job: no consent, held, no attempt (K02-C4 ②)", () => {
  it("holds the job and leaves no Provider attempt", async () => {
    const { job, result } = await run(setUp(QUOTE, false));
    expect(result).toMatchObject({ status: "blocked", reason: "consent-missing" });
    expect(readJob(db, job.id)?.status).toBe("held");
    expect(provider.requests).toEqual([]);
    expect(attempts.every((a) => a.outcome === "blocked")).toBe(true);
    expect(synonym().opinion).toBeNull();
    expect(readFinding(db, synonym().id)?.status).toBe("open");
  });
});

describe("reflection.refine-job: the setting is off by default (K02-C4 ③)", () => {
  it("queues no job while off, and one per open synonym or missing-link finding once on, only once", () => {
    expect(requestReflectionRefinements(db, AT)).toBe(0);
    expect(db.all("SELECT 1 FROM jobs WHERE kind = ?", [REFLECTION_REFINE_KIND])).toEqual([]);

    setReflectionRefine(db, true);
    const open = listFindings(db).filter(
      (f) => f.status === "open" && (f.rule === "synonym" || f.rule === "missing-link"),
    );
    expect(open.length).toBeGreaterThan(0);
    expect(requestReflectionRefinements(db, AT)).toBe(open.length);
    expect(requestReflectionRefinements(db, AT)).toBe(0);

    setReflectionRefine(db, false);
    expect(requestReflectionRefinements(db, AT)).toBe(0);
  });
});
