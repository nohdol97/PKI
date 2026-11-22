// extraction.calls, extraction.request, extraction.quote (stored part) and linking
// (V02-R6, R7, R8, C1): the extract handler through the real Broker, on a real
// SQLite database, with the per-fixture Provider double. Imported sources grade
// "general" (jsonl-import is no synthetic origin, V02 "T04가 넘기는 것" 6), so the
// stub egress decision allows both classes and records what it was asked.
import {
  createBroker,
  createUserActionLedger,
  EXTRACT_FACT_KINDS,
  EXTRACT_RELATION_TYPES,
  EXTRACT_SCHEMA_VERSION,
  TASKS,
  type EgressInput,
} from "@pki/providers";
import {
  closeJob,
  isFenceCurrent,
  leaseNextJob,
  listEvidence,
  migrate,
  readExtractionDrops,
  readItem,
  registerConnectorInstance,
  registerJob,
  saveSourceRecord,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import {
  FakeProvider,
  fixtureExtraction,
  MemoryKnowledgeEngine,
  ProposingKnowledgeEngine,
  type FakeStep,
} from "@pki/testkit";
import type { KnowledgeCandidate } from "@pki/contracts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPLETION_DATE, DEPENDS_ON, TARGET_DATE } from "./dependency-delay.ts";
import {
  createExtractHandler,
  EXTRACT_HOLD_TOO_LARGE,
  MAX_EXTRACT_CODE_POINTS,
  type ExtractHandlerOptions,
} from "./extraction.ts";
import { findCandidates, knowledgeCandidates } from "./linking.ts";

const fixtures = resolve(import.meta.dirname, "../../fixtures");
type Line = { id: string; title: string; content: string };
const lines = (file: string): Line[] =>
  readFileSync(resolve(fixtures, file), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Line);
const [mail] = lines("v02-mail.jsonl") as [Line];
const [wiki] = lines("v02-wiki.jsonl") as [Line];
const [messenger] = lines("v02-messenger.jsonl") as [Line];
const T0 = new Date("2026-11-21T00:00:00.000Z");

let db: SqlDriver;
let provider: FakeProvider;
let egressAsked: EgressInput[];
let deny: string | undefined;
let brokerRequests: unknown[];
let handler: ReturnType<typeof createExtractHandler>;

function setUp(
  script: FakeStep[] = [],
  engine?: ExtractHandlerOptions["engine"],
  isEngineStale?: () => boolean,
) {
  provider = new FakeProvider({ answer: fixtureExtraction(), script });
  const broker = createBroker({
    db,
    provider: () => provider,
    userActions: createUserActionLedger().redeemer,
    candidates: knowledgeCandidates(db),
    egress: {
      decide: (input) => {
        egressAsked.push(input);
        return deny === undefined
          ? { allowed: true, destination: "fake", policyVersion: "pv" }
          : { allowed: false, reason: deny };
      },
    },
    execution: { decide: () => ({ run: true }) },
    recorder: { record: () => undefined },
    clock: { now: () => 0, sleep: async () => undefined },
  });
  handler = createExtractHandler({
    db,
    broker: {
      call: (raw) => {
        brokerRequests.push(structuredClone(raw));
        return broker.call(raw);
      },
    },
    now: () => T0,
    ...(engine ? { engine, onEngineError: (error: unknown) => engineErrors.push(error) } : {}),
    ...(isEngineStale ? { isEngineStale } : {}),
  });
}
let engineErrors: unknown[] = [];

beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "imported", "jsonl-import");
  registerConnectorInstance(db, "fixtures", "test-fixtures");
  egressAsked = [];
  deny = undefined;
  brokerRequests = [];
  engineErrors = [];
  setUp();
});
afterEach(() => db.close());

/** Stores a version and queues its extraction job in one transaction, as a sync does. */
function imported(line: Pick<Line, "id" | "title" | "content">, instance = "imported"): StoredJob {
  return db.transaction(() => {
    const saved = saveSourceRecord(db, instance, {
      externalId: line.id,
      title: line.title,
      body: line.content,
    });
    if (saved.status !== "created") throw new Error("expected a new version");
    const r = registerJob(db, {
      kind: "extract",
      sourceId: saved.sourceId,
      fenceVersion: saved.version,
    });
    if (!r.registered) throw new Error("expected a new job");
    return r.job;
  });
}

/** One runner step: lease, handle, close through the fence. */
async function runNext() {
  const job = leaseNextJob(db, { kinds: ["extract"], now: T0, leaseMs: 60_000 });
  const fence = { sourceId: job?.sourceId as number, fenceVersion: job?.fenceVersion as number };
  if (!job || !isFenceCurrent(db, fence)) throw new Error("expected a current job");
  const result = await handler(job);
  return { job, result, status: closeJob(db, job, result) };
}

const items = () => db.all("SELECT id, type, name, status FROM items ORDER BY id");
const facts = () => db.all("SELECT id, item_id, kind, value, status FROM facts ORDER BY id");
const versionOf = (job: StoredJob) =>
  db.all("SELECT id FROM source_versions WHERE source_id = ? AND version = ?", [
    job.sourceId,
    job.fenceVersion,
  ])[0]?.id as number;
const output = (o: object): FakeStep => ({ output: { items: [], facts: [], relations: [], ...o } });

describe("extraction schema", () => {
  it("names what the rule reads (dependency-delay.ts)", () => {
    expect([...EXTRACT_FACT_KINDS].sort()).toEqual([COMPLETION_DATE, TARGET_DATE].sort());
    expect([...EXTRACT_RELATION_TYPES]).toEqual([DEPENDS_ON]);
    expect(Object.keys(TASKS.extract)).toEqual([String(EXTRACT_SCHEMA_VERSION)]);
  });
});

describe("extraction.calls", () => {
  it("makes exactly one Provider call for one source version", async () => {
    imported(mail);
    const { status, result } = await runNext();
    expect(status).toBe("succeeded");
    expect(result.status).toBe("succeeded");
    expect(provider.requests).toHaveLength(1);
    expect(facts()).toHaveLength(1);
  });

  it("asks again once on a schema mismatch and stops dead-lettered after the second", async () => {
    setUp([{ output: { claims: [] } }, { output: { claims: [] } }, { output: { claims: [] } }]);
    imported(mail);
    const { status, job } = await runNext();
    expect(provider.requests).toHaveLength(2);
    expect(status).toBe("dead_letter");
    expect(db.all("SELECT reason FROM jobs WHERE id = ?", [job.id])).toEqual([
      { reason: "invalid-output" },
    ]);
    expect(facts()).toEqual([]);
  });

  it("uses the second answer when only the first mismatched", async () => {
    setUp([{ output: { claims: [] } }]);
    imported(mail);
    expect((await runNext()).status).toBe("succeeded");
    expect(provider.requests).toHaveLength(2);
    expect(facts()).toHaveLength(1);
  });

  it("does not repeat a call that failed otherwise", async () => {
    setUp([{ error: new Error("boom") }]);
    imported(mail);
    const { status, job } = await runNext();
    expect(status).toBe("dead_letter");
    expect(provider.requests).toHaveLength(1);
    expect(db.all("SELECT reason FROM jobs WHERE id = ?", [job.id])).toEqual([
      { reason: "provider-error" },
    ]);
  });

  it("holds a source too large for one call without calling", async () => {
    imported({ id: "big", title: "t", content: "가".repeat(MAX_EXTRACT_CODE_POINTS) });
    const { status, job } = await runNext();
    expect(status).toBe("held");
    expect(provider.requests).toHaveLength(0);
    expect(brokerRequests).toHaveLength(0);
    expect(db.all("SELECT reason FROM jobs WHERE id = ?", [job.id])).toEqual([
      { reason: EXTRACT_HOLD_TOO_LARGE },
    ]);
  });

  it("counts the size in code points, title included", async () => {
    // just under the limit in code points, far over it in UTF-16 units
    imported({ id: "emoji", title: "t", content: "🙂".repeat(MAX_EXTRACT_CODE_POINTS - 2) });
    expect((await runNext()).status).toBe("succeeded");
    expect(provider.requests).toHaveLength(1);
  });

  it("holds a call the Broker blocked with its reason, with no Provider call", async () => {
    deny = "no-consent";
    imported(mail);
    const { status, job } = await runNext();
    expect(status).toBe("held");
    expect(provider.requests).toHaveLength(0);
    expect(db.all("SELECT reason FROM jobs WHERE id = ?", [job.id])).toEqual([
      { reason: "no-consent" },
    ]);
  });
});

describe("extraction.request", () => {
  it("passes the Broker IDs only: version, candidates, and the job and its lease", async () => {
    imported(mail);
    const second = imported(wiki);
    await runNext();
    await runNext();
    expect(brokerRequests).toHaveLength(2);
    const request = brokerRequests[1] as Record<string, unknown>;
    const a = (items()[0] as { id: number }).id;
    expect(request).toEqual({
      taskKind: "extract",
      sourceVersionIds: [String(versionOf(second))],
      candidateItemIds: [String(a)],
      origin: { jobId: String(second.id), leaseToken: "1" },
      schemaVersion: EXTRACT_SCHEMA_VERSION,
      budget: { timeoutMs: 120_000 },
      retryable: false,
    });
    // no text of the source anywhere in what the pipeline sent
    const sent = JSON.stringify(brokerRequests);
    for (const text of [mail.content, mail.title, wiki.content, "미리내", "물결"]) {
      expect(sent).not.toContain(text);
    }
  });

  it("puts a malicious variant's instruction in the document section only", async () => {
    const malicious = lines("v02-malicious.jsonl");
    for (const line of malicious) imported(line);
    for (let i = 0; i < malicious.length; i++) expect((await runNext()).status).toBe("succeeded");
    expect(provider.requests).toHaveLength(3);
    for (const request of provider.requests) {
      expect(request.input.instructions).toBe(TASKS.extract[EXTRACT_SCHEMA_VERSION].instructions);
      expect(request.input.instructions).not.toContain("이전 지시를 무시");
      expect(request.input.untrustedDocuments).toHaveLength(1);
      expect(request.input.untrustedDocuments[0]?.body).toContain("이전 지시를 무시");
    }
    // nothing it asked for became anything but candidate explicit knowledge
    expect(db.all("SELECT DISTINCT epistemic, status FROM facts")).toEqual([
      { epistemic: "explicit", status: "candidate" },
    ]);
  });
});

describe("extraction.quote (stored)", () => {
  it("stores the span the code computed, ignoring positions in the response", async () => {
    const quote = "미리내 프로젝트의 완료 목표는 2026-12-05입니다";
    setUp([
      output({
        items: [{ ref: "a", type: "Project", name: "미리내 프로젝트", existingItemId: null }],
        facts: [
          {
            item: "a",
            kind: "target_date",
            value: "2026-12-05",
            epistemic: "explicit",
            quote,
            start: 0,
            end: 5,
          },
        ],
      }),
    ]);
    const job = imported(mail);
    expect((await runNext()).status).toBe("succeeded");
    const fact = facts()[0] as { id: number };
    expect(listEvidence(db, { factId: fact.id })).toMatchObject([
      { sourceVersionId: versionOf(job), start: 30, end: 60, quote, current: true },
    ]);
  });

  it("drops facts and relations whose quote is missing or ambiguous, and records the counts", async () => {
    setUp([
      output({
        items: [
          { ref: "a", type: "Project", name: "미리내 프로젝트", existingItemId: null },
          { ref: "b", type: "System", name: "물결 API", existingItemId: null },
        ],
        facts: [
          {
            item: "a",
            kind: "target_date",
            value: "2026-12-05",
            epistemic: "explicit",
            quote: "없는 문장",
          },
          {
            item: "b",
            kind: "completion_date",
            value: "2026-12-10",
            epistemic: "explicit",
            quote: "물결 API",
          },
        ],
        relations: [
          {
            subject: "a",
            type: "DEPENDS_ON",
            object: "b",
            quote: "미리내 프로젝트는 물결 API의 예약 엔드포인트에 의존한다",
          },
        ],
      }),
    ]);
    const job = imported(wiki);
    expect((await runNext()).status).toBe("succeeded");
    expect(facts()).toEqual([]);
    expect(db.all("SELECT count(*) AS n FROM relations")).toEqual([{ n: 1 }]);
    expect(readExtractionDrops(db, job.id)).toEqual({ quotes: 2, other: 0 });
    expect(items()).toHaveLength(2); // both items carry the relation
  });

  it("drops a quote found only in the title: evidence spans the body", async () => {
    const title = "미리내 프로젝트 완료 목표 2026-12-05";
    setUp([
      output({
        items: [{ ref: "a", type: "Project", name: "미리내 프로젝트", existingItemId: null }],
        facts: [
          {
            item: "a",
            kind: "target_date",
            value: "2026-12-05",
            epistemic: "explicit",
            quote: title,
          },
        ],
      }),
    ]);
    const job = imported({ id: "title", title, content: "본문에는 날짜가 없습니다." });
    expect((await runNext()).status).toBe("succeeded");
    expect(facts()).toEqual([]);
    expect(readExtractionDrops(db, job.id)).toEqual({ quotes: 1, other: 0 });
  });

  it("creates no item that nothing kept refers to", async () => {
    setUp([
      output({
        items: [{ ref: "a", type: "Project", name: "미리내 프로젝트", existingItemId: null }],
        facts: [
          {
            item: "a",
            kind: "target_date",
            value: "2026-12-05",
            epistemic: "explicit",
            quote: "없음",
          },
        ],
      }),
    ]);
    imported(mail);
    expect((await runNext()).status).toBe("succeeded");
    expect(items()).toEqual([]);
  });

  it("drops a fact whose date is not a calendar date or whose item is not in the answer", async () => {
    const quote = "미리내 프로젝트의 완료 목표는 2026-12-05입니다";
    setUp([
      output({
        items: [{ ref: "a", type: "Project", name: "미리내 프로젝트", existingItemId: null }],
        facts: [
          { item: "a", kind: "target_date", value: "2026-11-31", epistemic: "explicit", quote },
          { item: "a", kind: "target_date", value: "12월 5일", epistemic: "explicit", quote },
          { item: "zz", kind: "target_date", value: "2026-12-05", epistemic: "explicit", quote },
        ],
      }),
    ]);
    const job = imported(mail);
    expect((await runNext()).status).toBe("succeeded");
    expect(facts()).toEqual([]);
    expect(readExtractionDrops(db, job.id)).toEqual({ quotes: 0, other: 3 });
  });
});

describe("linking", () => {
  it("offers as candidates only items whose name the text holds literally (normalized)", () => {
    setUp();
    db.run(
      `INSERT INTO items (type, name, epistemic, status, observed_at) VALUES
        ('Project', '미리내 프로젝트', 'explicit', 'candidate', 'T'),
        ('System', 'Mulgyeol  API', 'explicit', 'candidate', 'T'),
        ('System', '물결', 'explicit', 'candidate', 'T'),
        ('System', '다른 시스템', 'explicit', 'candidate', 'T')`,
    );
    // case, Unicode normalization (decomposed Hangul) and runs of spaces only
    const decomposed = "미리내 프로젝트".normalize("NFD");
    expect(findCandidates(db, `${decomposed}와 MULGYEOL api, 물결무늬`)).toEqual([1, 2, 3]);
    expect(findCandidates(db, "미리내프로젝트")).toEqual([]);
  });

  it("links A and B across the three sources to one item each", async () => {
    for (const line of [mail, wiki, messenger]) imported(line);
    for (let i = 0; i < 3; i++) expect((await runNext()).status).toBe("succeeded");
    expect(items()).toEqual([
      { id: 1, type: "Project", name: "미리내 프로젝트", status: "candidate" },
      { id: 2, type: "System", name: "물결 API", status: "candidate" },
    ]);
    expect(provider.requests.map((r) => r.input.candidates)).toEqual([
      [],
      [{ id: "1", name: "미리내 프로젝트" }],
      [{ id: "2", name: "물결 API" }],
    ]);
    expect(facts()).toMatchObject([
      { item_id: 1, kind: "target_date", value: "2026-12-05" },
      { item_id: 2, kind: "completion_date", value: "2026-12-10" },
    ]);
    expect(db.all("SELECT subject_id, type, object_id FROM relations")).toEqual([
      { subject_id: 1, type: "DEPENDS_ON", object_id: 2 },
    ]);
    // the rule ran in the write transaction: one inferred Insight, three evidence
    const insight = db.all("SELECT id, x_item_id, y_item_id, epistemic, state FROM insights");
    expect(insight).toEqual([
      { id: 1, x_item_id: 1, y_item_id: 2, epistemic: "inferred", state: "active" },
    ]);
    expect(db.all("SELECT count(*) AS n FROM insight_evidence")).toEqual([{ n: 3 }]);
  });

  it("drops an answer item naming an ID that was not a candidate, with what refers to it", async () => {
    imported(mail);
    await runNext(); // item 1
    const quote = "물결 API 개발 완료가 2026-12-10으로 연기되었습니다";
    setUp([
      output({
        items: [{ ref: "b", type: "System", name: "물결 API", existingItemId: "1" }],
        facts: [
          { item: "b", kind: "completion_date", value: "2026-12-10", epistemic: "explicit", quote },
        ],
      }),
    ]);
    const job = imported(messenger); // names no existing item: no candidates
    expect((await runNext()).status).toBe("succeeded");
    expect(provider.requests[0]?.input.candidates).toEqual([]);
    expect(facts()).toHaveLength(1); // the mail's only
    // the item entry and the fact that named it
    expect(readExtractionDrops(db, job.id)).toEqual({ quotes: 0, other: 2 });
  });

  it("keeps a ref dropped when its first entry named a non-candidate ID and a later entry repeats it", async () => {
    const quote = "물결 API 개발 완료가 2026-12-10으로 연기되었습니다";
    setUp([
      output({
        items: [
          { ref: "b", type: "System", name: "물결 API", existingItemId: "999" },
          { ref: "b", type: "System", name: "물결 API", existingItemId: null },
        ],
        facts: [
          { item: "b", kind: "completion_date", value: "2026-12-10", epistemic: "explicit", quote },
        ],
      }),
    ]);
    const job = imported(messenger);
    expect((await runNext()).status).toBe("succeeded");
    expect(items()).toEqual([]);
    expect(facts()).toEqual([]);
    // the dropped first entry and the fact that named its ref; the repeat is ignored
    expect(readExtractionDrops(db, job.id)).toEqual({ quotes: 0, other: 2 });
  });

  it("searches candidates in the title as well as the body", async () => {
    imported(mail);
    await runNext(); // item 1: 미리내 프로젝트
    imported({ id: "t-only", title: "미리내 프로젝트 회의", content: "다음 회의는 목요일입니다." });
    await runNext();
    expect(brokerRequests.at(-1)).toMatchObject({ candidateItemIds: ["1"] });
  });

  it("adds evidence to the same row for an equal value and keeps a different value apart", async () => {
    const quote = (n: string) => `미리내 프로젝트의 완료 목표는 ${n}입니다`;
    const answer = (n: string): FakeStep => ({
      output: {
        items: [{ ref: "a", type: "Project", name: "미리내 프로젝트", existingItemId: "1" }],
        facts: [
          { item: "a", kind: "target_date", value: n, epistemic: "explicit", quote: quote(n) },
        ],
        relations: [],
      },
    });
    imported(mail);
    await runNext();
    setUp([answer("2026-12-05"), answer("2026-12-07")]);
    imported({ id: "m2", title: "다시", content: `재공유: ${quote("2026-12-05")}` });
    imported({ id: "m3", title: "변경", content: `변경: ${quote("2026-12-07")}` });
    await runNext();
    await runNext();
    expect(facts()).toMatchObject([
      { item_id: 1, value: "2026-12-05" },
      { item_id: 1, value: "2026-12-07" },
    ]);
    const [same, other] = facts() as [{ id: number }, { id: number }];
    expect(listEvidence(db, { factId: same.id })).toHaveLength(2);
    expect(listEvidence(db, { factId: other.id })).toHaveLength(1);
    expect(items()).toHaveLength(1);
  });

  it("grades the call general when a candidate's name came from a general source", async () => {
    // the messenger fixture from the trusted test Connector is synthetic on its own
    imported(messenger, "fixtures");
    await runNext();
    expect(egressAsked.at(-1)?.classification).toBe("synthetic");
    // B's name now also has general evidence (an imported copy under another id)
    imported({ ...messenger, id: "copy" });
    await runNext();
    expect(egressAsked.at(-1)?.classification).toBe("general");
    // the trusted wiki names B, whose evidence includes the general copy
    imported(wiki, "fixtures");
    await runNext();
    expect(provider.requests.at(-1)?.input.candidates.map((c) => c.name)).toEqual(["물결 API"]);
    expect(egressAsked.at(-1)?.classification).toBe("general");
    expect(readItem(db, 1)?.name).toBe("물결 API");
  });
});

describe("engine proposals (V02-R13)", () => {
  const TARGET = "미리내 프로젝트의 완료 목표는 2026-12-05입니다";
  const proposal = (
    ref: KnowledgeCandidate["ref"],
    patch: Partial<Extract<KnowledgeCandidate, { kind: "fact" }>> = {},
  ): KnowledgeCandidate => ({
    kind: "fact",
    ref,
    item: { type: "Project", name: "미리내 프로젝트", existingItemId: null },
    factKind: "target_date",
    value: "2026-12-05",
    epistemic: "explicit",
    quote: TARGET,
    ...patch,
  });
  /** An engine proposing `candidates(ref)` for every version it takes, holding mail's version 1. */
  async function proposing(
    candidates: (ref: KnowledgeCandidate["ref"]) => KnowledgeCandidate[],
    line: Line = mail,
  ) {
    const engine = new ProposingKnowledgeEngine(({ ref }) => candidates(ref));
    const job = imported(line);
    const ref = { sourceId: String(job.sourceId), version: job.fenceVersion as number };
    await engine.upsertSource({ ref, title: line.title, body: line.content }, ref, 1);
    return { engine, ref };
  }

  it("records a proposal whose quote the body holds once, as a candidate with evidence", async () => {
    const { engine, ref } = await proposing((r) => [proposal(r)]);
    const propose = vi.spyOn(engine, "proposeKnowledge");
    setUp([output({})], engine);
    const { status, job } = await runNext();
    expect(status).toBe("succeeded");
    expect(propose).toHaveBeenCalledWith(ref);
    expect(items()).toEqual([
      { id: 1, type: "Project", name: "미리내 프로젝트", status: "candidate" },
    ]);
    expect(facts()).toEqual([
      { id: 1, item_id: 1, kind: "target_date", value: "2026-12-05", status: "candidate" },
    ]);
    const [evidence] = listEvidence(db, { factId: 1 });
    expect(evidence).toMatchObject({ sourceVersionId: versionOf(job), quote: TARGET });
    expect(readExtractionDrops(db, job.id)).toEqual({ quotes: 0, other: 0 });
  });

  it("drops a wrong quote, a version not asked for, an ID not offered and a name outside the schema", async () => {
    const { engine } = await proposing((r) => [
      proposal(r, { quote: "미리내 프로젝트의 완료 목표는 2026-12-06입니다" }),
      proposal({ ...r, version: r.version + 1 }),
      proposal(r, { item: { type: "Project", name: "미리내 프로젝트", existingItemId: "77" } }),
      proposal(r, { factKind: "start_date" }),
    ]);
    setUp([output({})], engine);
    const { job } = await runNext();
    expect(items()).toEqual([]);
    expect(facts()).toEqual([]);
    // the unoffered ID drops its item and the fact naming it (as for an answer)
    expect(readExtractionDrops(db, job.id)).toEqual({ quotes: 1, other: 4 });
  });

  it("keeps the engine's refs apart from the Provider's answer", async () => {
    const { engine } = await proposing((r) => [proposal(r)]);
    // the Provider names a different item under the ref the engine's item gets (e0)
    setUp(
      [
        output({
          items: [{ ref: "e0", type: "System", name: "물결 API", existingItemId: null }],
          facts: [],
        }),
      ],
      engine,
    );
    await runNext();
    expect(facts()).toMatchObject([{ item_id: 1, kind: "target_date" }]);
    expect(items()).toMatchObject([{ name: "미리내 프로젝트" }]);
  });

  it("gives the candidates naming the same item one item, a relation's two ends included", async () => {
    const x = { type: "Project", name: "미리내 프로젝트", existingItemId: null };
    const y = { type: "System", name: "물결 API", existingItemId: null };
    const relation = (ref: KnowledgeCandidate["ref"], quote: string): KnowledgeCandidate => ({
      kind: "relation",
      ref,
      subject: x,
      type: "DEPENDS_ON",
      object: y,
      quote,
    });
    const { engine } = await proposing(
      (r) => [
        { ...relation(r, "미리내 구조"), object: x }, // first: both ends one new item
        relation(r, "미리내 프로젝트는 물결 API의 예약 엔드포인트에 의존한다"),
        relation(r, "물결 API가 준비되기 전에는 연동 테스트를 시작할 수 없다"),
        relation(r, "없는 인용문"),
      ],
      wiki,
    );
    setUp([output({})], engine);
    const { job } = await runNext();
    expect(items()).toMatchObject([{ name: "미리내 프로젝트" }, { name: "물결 API" }]);
    const relations = db.all("SELECT id, subject_id, object_id, status FROM relations");
    expect(relations).toEqual([
      { id: 1, subject_id: 1, object_id: 1, status: "candidate" },
      { id: 2, subject_id: 1, object_id: 2, status: "candidate" },
    ]);
    expect(listEvidence(db, { relationId: 2 })).toHaveLength(2);
    expect(readExtractionDrops(db, job.id)).toEqual({ quotes: 1, other: 0 });
  });

  it("is not asked while the engine is stale: it may still hold purged text (review F5)", async () => {
    const { engine } = await proposing((r) => [proposal(r)]);
    const propose = vi.spyOn(engine, "proposeKnowledge");
    let stale = true;
    setUp([output({}), output({})], engine, () => stale);
    expect((await runNext()).status).toBe("succeeded");
    expect(propose).not.toHaveBeenCalled();
    expect(facts()).toEqual([]);
    // rebuilt: asked again
    stale = false;
    imported({ id: "again", title: mail.title, content: mail.content });
    await runNext();
    expect(propose).toHaveBeenCalledTimes(1);
  });

  it("is not asked without the propose capability", async () => {
    const engine = new MemoryKnowledgeEngine();
    const propose = vi.spyOn(engine, "proposeKnowledge");
    setUp([output({})], engine);
    imported(mail);
    expect((await runNext()).status).toBe("succeeded");
    expect(propose).not.toHaveBeenCalled();
    expect(facts()).toEqual([]);
  });

  it("goes on without proposals when the engine fails", async () => {
    const { engine } = await proposing((r) => [proposal(r)]);
    vi.spyOn(engine, "proposeKnowledge").mockRejectedValue(new Error("engine broke"));
    setUp([output({})], engine);
    expect((await runNext()).status).toBe("succeeded");
    expect(facts()).toEqual([]);
    expect(engineErrors).toHaveLength(1);
  });

  it("writes nothing of a proposal when the Provider call is blocked", async () => {
    const { engine } = await proposing((r) => [proposal(r)]);
    setUp([], engine);
    deny = "no-consent";
    expect((await runNext()).status).toBe("held");
    expect(facts()).toEqual([]);
  });
});
