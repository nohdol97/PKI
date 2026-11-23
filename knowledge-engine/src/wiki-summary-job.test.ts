// K01-C4 ① (R12, R13): the `wiki-summary` job through the real Broker and a fake Provider. A sentence is kept
// only when its quote is found in the stored body of the document it names; the summary is written to the page
// row and nowhere else (evidence, facts, relations, the keyword index keep their row counts). A page whose
// lineage the policy will not put together, or that has more versions than one call takes, is not sent at all.
import { createBroker, createUserActionLedger } from "@pki/providers";
import {
  closeJob,
  leaseNextJob,
  migrate,
  readStoredWikiPage,
  registerConnectorInstance,
  requestWikiSummaries,
  setWikiSummary,
  WIKI_SUMMARY_KIND,
  type ScopePolicy,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { FakeProvider } from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProductRegistry } from "./canonical-kinds.ts";
import { knowledgeCandidates } from "./linking.ts";
import { createWikiSummaryHandler } from "./wiki-summary-job.ts";
import { addFact, addItem, addSource, AT, buildWiki, cite } from "./wiki.test-support.ts";

const KEPT = "마감은 12월 5일이다.";
const INVENTED = "예산은 두 배로 늘었다.";
const BODY_A = `가 문서. ${KEPT} 끝.`;

let db: SqlDriver;
let provider: FakeProvider;
let handler: ReturnType<typeof createWikiSummaryHandler>;

/** What the fake Provider answers: one sentence with a quote the first document holds, one with an invented quote. */
const answer = (request: { input: { untrustedDocuments: { id: string }[] } }) => ({
  sentences: [
    { text: "마감은 12월이다.", documentId: request.input.untrustedDocuments[0]?.id, quote: KEPT },
    {
      text: "예산이 늘었다.",
      documentId: request.input.untrustedDocuments[0]?.id,
      quote: INVENTED,
    },
  ],
});

function setUp(registry?: ReturnType<typeof createProductRegistry>) {
  provider = new FakeProvider({ answer: answer as never });
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
  handler = createWikiSummaryHandler({
    db,
    ...(registry ? { registry } : {}),
    now: () => new Date(AT),
  });
  return broker;
}

beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

const counts = () =>
  Object.fromEntries(
    ["evidence", "facts", "relations", "keyword_index"].map((t) => [
      t,
      db.all(`SELECT count(*) AS n FROM ${t}`)[0]?.n as number,
    ]),
  );

/** A project item with one fact per source, each citing its source: the page's lineage is those sources. */
function page(bodies: { body: string; accessScope?: string[] }[]) {
  const item = addItem(db, "Project", "미리내");
  bodies.forEach((b, i) => {
    const s = addSource(db, `s${i}`, b.body, b.accessScope);
    cite(db, { factId: addFact(db, item, "memo", `값 ${i}`) }, s.id);
  });
  buildWiki(db);
  return `projects/${item}`;
}

/** Asks for the summary jobs, leases the one, runs the handler and closes it as the runner does. */
async function run(broker: ReturnType<typeof setUp>) {
  const queued = requestWikiSummaries(db);
  const job = leaseNextJob(db, {
    kinds: [WIKI_SUMMARY_KIND],
    now: new Date(),
    leaseMs: 60_000,
  }) as StoredJob | undefined;
  if (!job) return { queued, status: "no-job" };
  const result = await handler(job, { broker });
  if (result.status !== "succeeded") return { queued, status: result.status };
  return { queued, status: closeJob(db, job, result) };
}

describe("wiki.summary-job: only located sentences are kept (K01-C4 ①)", () => {
  it("keeps the sentence whose quote is in the source, drops the invented one, and touches no other table", async () => {
    const key = page([{ body: BODY_A }, { body: "나 문서. 다른 내용." }]);
    setWikiSummary(db, true, new Date(AT));
    const broker = setUp();
    const before = counts();

    expect((await run(broker)).status).toBe("succeeded");

    const stored = readStoredWikiPage(db, key);
    const start = [...BODY_A.slice(0, BODY_A.indexOf(KEPT))].length;
    expect(JSON.parse(stored?.summary as string)).toEqual([
      {
        sentence: "마감은 12월이다.",
        sourceId: expect.any(Number),
        version: 1,
        start,
        end: start + [...KEPT].length,
      },
    ]);
    expect(stored?.summaryHash).toBe(stored?.contentHash);
    expect(counts()).toEqual(before);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.input.untrustedDocuments).toHaveLength(2);
  });

  it("sends nothing when the policy will not put the lineage together, or when there are nine versions", async () => {
    const apart: ScopePolicy = {
      compare: () => "equal",
      strictest: (scopes) => scopes[0] ?? null,
      combinable: (scopes) => new Set(scopes.map((s) => JSON.stringify(s))).size <= 1,
      allows: () => true,
    };
    page([
      { body: BODY_A, accessScope: ["a"] },
      { body: "나 문서", accessScope: ["b"] },
    ]);
    setWikiSummary(db, true, new Date(AT));
    const refused = await run(setUp(createProductRegistry({ policy: apart })));
    expect(refused.status).toBe("succeeded"); // ended without a call
    expect(provider.requests).toEqual([]);

    db.close();
    db = openBetterSqlite3(":memory:");
    migrate(db);
    registerConnectorInstance(db, "c1", "test-fixtures");
    page(Array.from({ length: 9 }, (_, i) => ({ body: `문서 ${i}` })));
    setWikiSummary(db, true, new Date(AT));
    await run(setUp());
    expect(provider.requests).toEqual([]);
  });
});
