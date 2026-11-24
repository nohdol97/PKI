// S03-T07 `extract.analytical` (S03-R7; X-C2, X-C3, X-C4): the extract handler with schema 5 through the real
// Broker on a real SQLite database. An analytical row of a document is written as a candidate with its
// normalized value; a unit or version not in its quote is dropped; a value naming columns that are not all in
// its quote is a hypothesis; a table source's own extraction writes no analytical result; another source's
// request carries no column name of a table. The answers come from the Provider double. All data is synthetic.
import { createBroker, createUserActionLedger } from "@pki/providers";
import {
  closeJob,
  insertItem,
  isFenceCurrent,
  leaseNextJob,
  migrate,
  readExtractionDrops,
  registerConnectorInstance,
  registerJob,
  saveFact,
  saveSourceRecord,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { FakeProvider, type FakeStep, memoryDbTemplate } from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExtractHandler } from "./extraction.ts";
import { knowledgeCandidates } from "./linking.ts";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);

const T0 = new Date("2026-11-23T00:00:00.000Z");
let db: SqlDriver;
let provider: FakeProvider;
let handler: ReturnType<typeof createExtractHandler>;
let externalIds = 0;

function setUp(script: FakeStep[]) {
  provider = new FakeProvider({
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
  handler = createExtractHandler({ db, now: () => T0 });
  return { call: (raw: unknown) => broker.call(raw) };
}
beforeEach(() => {
  db = freshDb();
  registerConnectorInstance(db, "imported", "jsonl-import");
});
afterEach(() => db.close());

const answer = (o: object): FakeStep => ({
  output: { items: [], facts: [], relations: [], terms: [], definitions: [], ...o },
});
const item = (ref: string, type: string, name: string, existingItemId: string | null = null) => ({
  ref,
  type,
  name,
  existingItemId,
});
const fact = (
  itemRef: string,
  kind: string,
  value: string,
  quote: string,
  epistemic = "explicit",
) => ({
  item: itemRef,
  kind,
  value,
  epistemic,
  quote,
});

/** Stores `body` as a new source (a table source when `blocks` are given) and runs its extract job once. */
async function extract(
  step: FakeStep,
  doc: { title?: string; body: string; blocks?: readonly unknown[] },
): Promise<StoredJob> {
  const broker = setUp([step]);
  const job = db.transaction(() => {
    const saved = saveSourceRecord(db, "imported", {
      externalId: `doc-${externalIds++}`,
      title: doc.title ?? "t",
      body: doc.body,
      ...(doc.blocks ? { blocks: doc.blocks } : {}),
    } as Parameters<typeof saveSourceRecord>[2]);
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
  const leased = leaseNextJob(db, { kinds: ["extract"], now: T0, leaseMs: 60_000 });
  if (
    !leased ||
    !isFenceCurrent(db, {
      sourceId: leased.sourceId as number,
      fenceVersion: leased.fenceVersion as number,
    })
  ) {
    throw new Error("expected a current job");
  }
  const result = await handler(leased, { broker });
  if (result.status !== "succeeded") throw new Error(result.status);
  closeJob(db, leased, result);
  return job;
}

const items = () => db.all("SELECT type, name FROM items ORDER BY id");
const facts = () =>
  db.all(
    `SELECT i.name AS item, f.kind, f.value, f.status, f.epistemic FROM facts f
       JOIN items i ON i.id = f.item_id ORDER BY f.id`,
  );
const relations = () => db.all("SELECT type FROM relations ORDER BY id");
const drops = (job: StoredJob) => readExtractionDrops(db, job.id);

describe("extract.analytical: a document's analytical rows (X-C2)", () => {
  const Q = {
    calc: "월간 매출은 매출액 합계로 센다",
    guess: "월간 이익은 이익금의 평균이다",
    unit: "월간 매출의 단위는 원이다",
    notUnit: "월간 이익의 단위는 달러이다",
    long: `월간 이익의 판은 ${"가".repeat(41)}이다`,
  };
  const BODY = Object.values(Q)
    .map((q) => `${q}.`)
    .join("\n");

  it("writes candidates with the normalized value, lowers a value whose column is not in its quote to hypothesis, and drops a unit outside its quote and a version over 40 code points, counting both", async () => {
    const job = await extract(
      answer({
        items: [item("m", "Metric", "월간 매출"), item("g", "Metric", "월간 이익")],
        facts: [
          // keys in another order and a spaced column: the stored text is the processed form
          fact("m", "metric.calculation", '{"column":" 매출액 ","aggregation":"sum"}', Q.calc),
          // the model says explicit; its column `profit` is not in the quote it gives
          fact("g", "metric.calculation", '{"aggregation":"avg","column":"profit"}', Q.guess),
          fact("m", "metric.unit", "원", Q.unit),
          fact("g", "metric.unit", "천원", Q.notUnit),
          fact("g", "metric.version", "가".repeat(41), Q.long),
        ],
      }),
      { body: BODY },
    );
    expect(facts()).toEqual([
      {
        item: "월간 매출",
        kind: "metric.calculation",
        value: '{"aggregation":"sum","column":"매출액"}',
        status: "candidate",
        epistemic: "explicit",
      },
      {
        item: "월간 이익",
        kind: "metric.calculation",
        value: '{"aggregation":"avg","column":"profit"}',
        status: "candidate",
        epistemic: "hypothesis",
      },
      {
        item: "월간 매출",
        kind: "metric.unit",
        value: "원",
        status: "candidate",
        epistemic: "explicit",
      },
    ]);
    expect(drops(job)).toEqual({ quotes: 1, other: 1 });
  });

  it("P3D-C1: a column name inside another word is no explicit basis (hypothesis), one at a word boundary is, and nothing is dropped", async () => {
    const valid = "valid orders only";
    const orderId = "order_id를 센다";
    const job = await extract(
      answer({
        items: [item("a", "Metric", "유효 주문"), item("b", "Metric", "주문 수")],
        facts: [
          fact("a", "metric.calculation", '{"aggregation":"count","column":"id"}', valid),
          fact("b", "metric.calculation", '{"aggregation":"count","column":"order_id"}', orderId),
        ],
      }),
      { body: `${valid}.\n${orderId}.` },
    );
    expect(facts().map((f) => [f.item, f.status, f.epistemic])).toEqual([
      ["유효 주문", "candidate", "hypothesis"],
      ["주문 수", "candidate", "explicit"],
    ]);
    expect(drops(job)).toEqual({ quotes: 0, other: 0 });
  });

  it("PD3-C3: a kana prolonged sound mark (U+30FC) is no word character: a column name after it is explicit", async () => {
    const quote = "ユーザーid 목록";
    const job = await extract(
      answer({
        items: [item("a", "Metric", "사용자 수")],
        facts: [fact("a", "metric.calculation", '{"aggregation":"count","column":"id"}', quote)],
      }),
      { body: `${quote}.` },
    );
    expect(facts().map((f) => [f.item, f.status, f.epistemic])).toEqual([
      ["사용자 수", "candidate", "explicit"],
    ]);
    expect(drops(job)).toEqual({ quotes: 0, other: 0 });
  });
});

describe("extract.analytical: a table source's own extraction (X-C3)", () => {
  const BODY = "매출액\t지역\n물결 프로젝트 K-0417\n";
  const blocks = [
    { start: 0, end: 3, locator: { format: "csv", record: 1, line: 1, field: 1 } },
    { start: 4, end: 6, locator: { format: "csv", record: 1, line: 1, field: 2 } },
  ];

  it("drops the answer's Dataset and Metric, an existing Dataset, and everything pointing at them, counting each, and writes the other rows", async () => {
    // the profile's Dataset of this table, offered to the call as a candidate (its name is the title)
    const profiled = insertItem(db, {
      type: "Dataset",
      name: "판매표",
      epistemic: "explicit",
      status: "candidate",
      validAt: null,
      observedAt: T0.toISOString(),
    });
    const job = await extract(
      answer({
        items: [
          item("d", "Dataset", "판매표", String(profiled)),
          item("n", "Dataset", "지역표"),
          item("m", "Metric", "월간 매출"),
          item("pr", "Project", "물결 프로젝트"),
        ],
        facts: [
          fact("d", "dataset.grain", '["매출액"]', "매출액"),
          fact("pr", "identifier.key", "K-0417", "물결 프로젝트 K-0417"),
        ],
        relations: [
          { subject: "m", type: "MEASURED_ON", object: "n", quote: "매출액" },
          { subject: "pr", type: "RELATED_TO", object: "d", quote: "물결 프로젝트 K-0417" },
        ],
        definitions: [{ item: "m", quote: "매출액", epistemic: "explicit" }],
      }),
      { title: "판매표", body: BODY, blocks },
    );
    expect(items()).toEqual([
      { type: "Dataset", name: "판매표" },
      { type: "Project", name: "물결 프로젝트" },
    ]);
    expect(facts().map((f) => f.kind)).toEqual(["identifier.key"]);
    expect(relations()).toEqual([]);
    // three analytical items (the existing one too), the grain, both relations and the definition
    expect(drops(job)).toEqual({ quotes: 0, other: 7 });
  });
});

describe("extract.analytical: a refused link on a table source (X-C3)", () => {
  it("writes no Metric when the answer links a Metric to a candidate whose key the link check refuses", async () => {
    await extract(
      answer({
        items: [item("p", "Project", "물결")],
        facts: [{ ...fact("p", "identifier.key", "K-1", "물결 K-1"), context: "sys" }],
      }),
      { body: "물결 K-1 이다." },
    );
    const project = db.all("SELECT id FROM items")[0]?.id as number;
    const job = await extract(
      answer({
        items: [item("x", "Metric", "물결", String(project))],
        facts: [
          { ...fact("x", "identifier.key", "K-2", "물결 K-2"), context: "sys" },
          fact("x", "metric.unit", "원", "물결 K-2 단위 원"),
        ],
      }),
      {
        title: "물결",
        body: "물결\t원\n물결 K-2 단위 원\n",
        blocks: [{ start: 0, end: 2, locator: { format: "csv", record: 1, line: 1, field: 1 } }],
      },
    );
    expect(items()).toEqual([{ type: "Project", name: "물결" }]);
    expect(facts().map((f) => f.kind)).toEqual(["identifier.key"]);
    expect(drops(job)).toEqual({ quotes: 0, other: 3 }); // the Metric, its key and its unit
  });
});

describe("extract.analytical: the egress of a table's columns (X-C4)", () => {
  it("sends the Dataset's name and no column name of the table in the request of another source", async () => {
    const CANARY = "canary_col_qx7";
    const dataset = insertItem(db, {
      type: "Dataset",
      name: "판매표",
      epistemic: "explicit",
      status: "candidate",
      validAt: null,
      observedAt: T0.toISOString(),
    });
    saveFact(db, {
      itemId: dataset,
      kind: "dataset.column",
      value: CANARY,
      epistemic: "explicit",
      status: "candidate",
      validAt: null,
      observedAt: T0.toISOString(),
    });
    await extract(answer({}), { body: "판매표를 월간 매출 보고서에 쓴다." });
    const request = JSON.stringify(provider.requests.at(-1));
    expect(request).toContain("판매표"); // the control: the name does go, so a leak of the column could too
    expect(request.toLowerCase()).not.toContain(CANARY);
  });
});
