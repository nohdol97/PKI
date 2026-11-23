// S02-T06 `resolution.link-guard` (S02-R8, R16): before an extraction writes a link the answer made to an
// existing item X, the code checks the identifier the answer gave against the ones X's group has. A key under
// the same tag with another value makes a new item, a `link-check` mark between it and X, and a count in
// `links_refused`; the same key, or no identifier, attaches to X as before. The type half of R8 (a differing
// type makes a new item) is not implemented (S02 spec decision 29). One end-to-end case through extraction
// leaves a candidate (R10). All data is synthetic.
import { createBroker, createUserActionLedger, type Broker } from "@pki/providers";
import {
  addEvidence,
  closeJob,
  insertItem,
  isFenceCurrent,
  leaseNextJob,
  migrate,
  registerConnectorInstance,
  registerJob,
  saveFact,
  saveSourceRecord,
  type KnowledgeAttributes,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { FakeProvider, type FakeStep } from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countLinksRefused } from "./entity-resolution.ts";
import { createExtractHandler } from "./extraction.ts";
import { knowledgeCandidates } from "./linking.ts";

const T0 = new Date("2026-11-23T00:00:00.000Z");
const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
};
let db: SqlDriver;
let handler: ReturnType<typeof createExtractHandler>;
let broker: Broker;
let documents = 0;

function setUp(script: FakeStep[] = []) {
  const provider = new FakeProvider({
    answer: () => ({ items: [], facts: [], relations: [], terms: [], definitions: [] }),
    script,
  });
  broker = createBroker({
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
}
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "fixtures", "test-fixtures");
  setUp();
  documents = 0;
});
afterEach(() => db.close());

const BODY = "한서윤의 사번은 K-0002입니다. 한서윤은 미리내 팀에 속합니다.";
const Q_KEY = "사번은 K-0002";
const Q_ORG = "한서윤은 미리내 팀에 속합니다";

async function extract(body: string, step: FakeStep): Promise<StoredJob> {
  setUp([step]);
  const job = db.transaction(() => {
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
  const leased = leaseNextJob(db, { kinds: ["extract"], now: T0, leaseMs: 60_000 });
  if (
    !leased ||
    !isFenceCurrent(db, {
      sourceId: job.sourceId as number,
      fenceVersion: job.fenceVersion as number,
    })
  ) {
    throw new Error("expected a current job");
  }
  const result = await handler(leased, { broker: { call: (raw) => broker.call(raw) } });
  if (result.status !== "succeeded") throw new Error(result.status);
  closeJob(db, leased, result);
  return leased;
}
const answer = (o: object): FakeStep => ({
  output: { items: [], facts: [], relations: [], terms: [], definitions: [], ...o },
});
const key = (item: string, value: string, quote: string) => ({
  item,
  kind: "identifier.key",
  value,
  context: "인사",
  epistemic: "explicit",
  quote,
});

/** An item an earlier source built, with the key its facts hold (current evidence from that source). */
function stored(name: string, keyValue: string | null, type = "Person") {
  const prior = saveSourceRecord(db, "fixtures", {
    externalId: `prior-${documents++}`,
    title: "prior",
    body: "prior body",
  });
  if (prior.status !== "created") throw new Error(prior.status);
  const versionId = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
  const item = insertItem(db, { type, name, ...attrs });
  const fact = saveFact(db, {
    itemId: item,
    kind: keyValue === null ? "role" : "identifier.key",
    value: keyValue ?? "engineer",
    context: keyValue === null ? null : "인사",
    ...attrs,
  }).id;
  addEvidence(db, {
    target: { factId: fact },
    sourceVersionId: versionId,
    start: 0,
    end: 5,
    quote: "prior",
  });
  return item;
}
const itemsNamed = () =>
  db.all("SELECT id FROM items WHERE name = '한서윤' ORDER BY id").map((r) => r.id as number);
const factsOf = (item: number) =>
  db.all("SELECT kind, value FROM facts WHERE item_id = ? ORDER BY id", [item]);
const marks = () => db.all("SELECT item_a, item_b, by FROM item_distinct ORDER BY item_a, item_b");
const answering = (existing: number, value: string) =>
  answer({
    items: [{ ref: "x", type: "Person", name: "한서윤", existingItemId: String(existing) }],
    facts: [key("x", value, Q_KEY)],
  });

describe("resolution.link-guard (S02-R8)", () => {
  it("a different key under the same tag makes a new item: X's rows unchanged, a link-check mark, links refused 1, no candidate", async () => {
    const x = stored("한서윤", "K-0001");
    await extract(BODY, answering(x, "K-0002"));
    const [first, second] = itemsNamed();
    expect(first).toBe(x);
    expect(factsOf(x)).toEqual([{ kind: "identifier.key", value: "K-0001" }]);
    expect(factsOf(second as number)).toEqual([{ kind: "identifier.key", value: "K-0002" }]);
    expect(marks()).toEqual([{ item_a: x, item_b: second, by: "link-check" }]);
    expect(countLinksRefused(db)).toBe(1);
    expect(db.all("SELECT 1 FROM merge_candidates")).toEqual([]);
  });

  it("the same key, or no identifier, attaches to X as before", async () => {
    const x = stored("한서윤", "K-0002");
    await extract(BODY, answering(x, "K-0002"));
    expect(itemsNamed()).toEqual([x]);
    expect(countLinksRefused(db)).toBe(0);
    const y = stored("한서윤", "K-0001");
    await extract(
      "한서윤은 미리내 팀에 속합니다.",
      answer({
        items: [
          { ref: "x", type: "Person", name: "한서윤", existingItemId: String(y) },
          { ref: "o", type: "Organization", name: "미리내 팀", existingItemId: null },
        ],
        relations: [{ subject: "x", type: "BELONGS_TO", object: "o", quote: Q_ORG }],
      }),
    );
    expect(db.all("SELECT subject_id FROM relations").map((r) => r.subject_id)).toContain(y);
    expect(countLinksRefused(db)).toBe(0);
  });

  it("reads the group: a differing key on a member refuses the link to the representative", async () => {
    const rep = stored("한서윤", null);
    const member = stored("서윤", "K-0001");
    db.run(
      "INSERT INTO item_merges (member_id, representative_id, active, at) VALUES (?, ?, 1, ?)",
      [member, rep, T0.toISOString()],
    );
    await extract(BODY, answering(rep, "K-0002"));
    expect(factsOf(rep)).toEqual([{ kind: "role", value: "engineer" }]);
    expect(countLinksRefused(db)).toBe(1);
  });
});

describe("resolution.candidates through extraction (S02-R10)", () => {
  it("two extractions that name the same person in the same organization leave one candidate row", async () => {
    const orgBody = "한서윤은 미리내 팀에 속합니다.";
    const person = { ref: "p", type: "Person", name: "한서윤", existingItemId: null };
    const org = (existing: number | null) => ({
      ref: "o",
      type: "Organization",
      name: "미리내 팀",
      existingItemId: existing === null ? null : String(existing),
    });
    const belongs = { subject: "p", type: "BELONGS_TO", object: "o", quote: Q_ORG };
    await extract(orgBody, answer({ items: [person, org(null)], relations: [belongs] }));
    expect(db.all("SELECT 1 FROM merge_candidates")).toEqual([]);
    const orgId = db.all("SELECT id FROM items WHERE type = 'Organization'")[0]?.id as number;
    await extract(orgBody, answer({ items: [person, org(orgId)], relations: [belongs] }));
    const [a, b] = itemsNamed();
    expect(db.all("SELECT item_a, item_b, signals FROM merge_candidates")).toEqual([
      {
        item_a: a,
        item_b: b,
        signals: JSON.stringify(["same-type", "name-match", "organization-match"]),
      },
    ]);
  });
});
