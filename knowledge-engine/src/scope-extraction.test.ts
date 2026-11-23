// scope.policy and scope.changed (I04-C1, R11, R14, R15, I04-T09), the extraction's part:
// the candidates offered to the Broker are filtered by the policy before the call; an
// item the policy refuses at the commit is left out alone (the rest is written and the
// job succeeds) and recorded; a scope change queues the source's extraction again and
// that extraction clears the records. The real handler and Broker, a real SQLite schema,
// the closeJob the runner closes with.
import type { BrokerRequest } from "@pki/contracts";
import { createBroker, createUserActionLedger } from "@pki/providers";
import {
  addEvidence,
  closeJob,
  createCommitScope,
  defaultScopePolicy,
  insertItem,
  leaseNextJob,
  migrate,
  readExtractionDrops,
  readJob,
  registerConnectorInstance,
  registerJob,
  saveFact,
  saveRelation,
  saveSourceRecord,
  type KnowledgeAttributes,
  type ScopePolicy,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { FakeProvider } from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProductRegistry, propagateCanonical } from "./canonical-kinds.ts";
import { COMPLETION_DATE, DEPENDS_ON, TARGET_DATE } from "./dependency-delay.ts";
import { createExtractHandler } from "./extraction.ts";
import { knowledgeCandidates } from "./linking.ts";

const T0 = new Date("2026-11-21T00:00:00.000Z");
const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
};

/** Sources can be put together only when they share one scope: a stand-in for a site's rule. */
const sameScopeOnly: ScopePolicy = {
  ...defaultScopePolicy,
  combinable: (scopes) => new Set(scopes.map((s) => JSON.stringify(s))).size <= 1,
};

let db: SqlDriver;
let requests: BrokerRequest[];
let duringCall: (() => void) | undefined;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "imported", "jsonl-import");
  requests = [];
  duringCall = undefined;
});
afterEach(() => db.close());

function source(externalId: string, body: string, scope: readonly string[] | null) {
  const saved = saveSourceRecord(db, "imported", { externalId, title: `제목 ${externalId}`, body });
  if (saved.status !== "created") throw new Error(saved.status);
  setScope(saved.sourceId, scope);
  const row = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
  return { sourceId: saved.sourceId, version: saved.version, row };
}
const setScope = (sourceId: number, scope: readonly string[] | null) =>
  db.run("UPDATE sources SET access_scope = ? WHERE id = ?", [
    scope === null ? null : JSON.stringify(scope),
    sourceId,
  ]);

/** An item whose only fact is quoted by `from`: its lineage is that source version. */
function knownItem(name: string, from: { row: number }) {
  const id = insertItem(db, { type: "Project", name, ...attrs });
  const fact = saveFact(db, { itemId: id, kind: TARGET_DATE, value: "2026-12-01", ...attrs }).id;
  addEvidence(db, {
    target: { factId: fact },
    sourceVersionId: from.row,
    start: 0,
    end: 1,
    quote: db.all("SELECT substr(body, 1, 1) AS q FROM source_versions WHERE id = ?", [from.row])[0]
      ?.q as string,
  });
  return id;
}

interface Answer {
  items: object[];
  facts: object[];
  relations: object[];
  terms?: object[];
  definitions?: object[];
}
const EMPTY: Answer = { items: [], facts: [], relations: [], terms: [], definitions: [] };

function setUp(policy: ScopePolicy, answer: (names: Map<string, string>) => Answer = () => EMPTY) {
  const registry = createProductRegistry({ policy });
  const provider = new FakeProvider({
    answer: (request) => {
      duringCall?.();
      const names = new Map(request.input.candidates.map((c) => [c.name, c.id]));
      // an answer that found no forms or definitions says so (the schema requires both lists)
      return { terms: [], definitions: [], ...answer(names) };
    },
  });
  const broker = createBroker({
    db,
    provider: () => provider,
    userActions: createUserActionLedger().redeemer,
    candidates: knowledgeCandidates(db, registry),
    egress: {
      decide: () => ({
        allowed: true,
        destination: "fake",
        policyVersion: "pv",
      }),
    },
    execution: { decide: () => ({ run: true }) },
    recorder: {
      record: () => undefined,
      begin: () => () => undefined,
      attemptTimes: () => [],
      interruptStarted: () => 0,
    },
    clock: { now: () => 0, sleep: async () => undefined },
  });
  const recording = {
    call: (raw: unknown) => {
      requests.push(structuredClone(raw) as BrokerRequest);
      return broker.call(raw);
    },
  };
  const handler = createExtractHandler({ db, registry, now: () => T0 });
  const scope = createCommitScope({ policy: registry.policy, now: () => T0.toISOString() });
  return { registry, handler, recording, scope };
}

/** Queues (or takes the queued) extraction of `s`'s latest version, leases it and runs the handler. */
async function extract(
  kit: ReturnType<typeof setUp>,
  s: { sourceId: number; version: number },
  target = "",
) {
  registerJob(db, {
    kind: "extract",
    target,
    sourceId: s.sourceId,
    fenceVersion: s.version,
    at: T0,
  });
  const job = leaseNextJob(db, { kinds: ["extract"], now: T0, leaseMs: 60_000 }) as StoredJob;
  const result = await kit.handler(job, { broker: kit.recording });
  if (result.status !== "succeeded") throw new Error(`handler ${result.status}`);
  const status = closeJob(db, job, result, T0, kit.scope);
  return { job, result, status };
}
const count = (table: string) => db.all(`SELECT count(*) AS n FROM ${table}`)[0]?.n as number;
const delays = () =>
  db.all("SELECT count(*) AS n FROM insights WHERE rule = 'dependency_delay'")[0]?.n as number;
const drops = () =>
  db.all("SELECT source_id, version, kind FROM scope_policy_drops ORDER BY id") as {
    source_id: number;
    version: number;
    kind: string;
  }[];

describe("scope.policy: one request never carries a refused combination of candidates (I04-R14)", () => {
  /** Only a and b together are refused; each of them goes with c. */
  const noAandB: ScopePolicy = {
    ...defaultScopePolicy,
    combinable: (scopes) => {
      const names = new Set(scopes.flatMap((s) => s ?? []));
      return !(names.has("a") && names.has("b"));
    },
  };

  it("offers the first of two candidates that cannot be put together, in id order, and counts the other as dropped", async () => {
    const a = source("a", "알", ["a"]);
    const b = source("b", "비", ["b"]);
    const alpha = knownItem("알파", a);
    knownItem("베타", b);
    const c = source("c", "알파와 베타 메모", ["c"]);
    const { job } = await extract(setUp(noAandB), c);
    expect(requests.map((r) => r.candidateItemIds)).toEqual([[String(alpha)]]);
    expect(readExtractionDrops(db, job.id)).toEqual({ quotes: 0, other: 1 });
  });

  it("records a withheld candidate, and a widening extracts the version again and offers it", async () => {
    const a = source("a", "알", ["a"]);
    const b = source("b", "비", ["b"]);
    knownItem("알파", a);
    const beta = knownItem("베타", b);
    const c = source("c", "알파와 베타 메모", ["c"]);
    const kit = setUp(noAandB);
    await extract(kit, c);
    expect(db.all("SELECT source_id, version, kind FROM scope_policy_drops")).toEqual([
      { source_id: c.sourceId, version: 1, kind: "candidate" },
    ]);
    expect(JSON.stringify(db.all("SELECT * FROM scope_policy_drops"))).not.toMatch(/베타|알파/);

    // b's scope widens to something that goes with a: the change queues c's extraction again
    setScope(b.sourceId, ["z"]);
    const { propagation } = db.transaction(() =>
      propagateCanonical(
        db,
        { kind: "scope-changed", sourceId: b.sourceId, from: ["b"], to: ["z"] },
        T0.toISOString(),
        kit.registry,
      ),
    );
    const target = `scope-recompute:${propagation.invalidationId}`;
    await extract(kit, c, target);
    expect(requests.at(-1)?.candidateItemIds).toHaveLength(2);
    expect(requests.at(-1)?.candidateItemIds).toContain(String(beta));
    expect(count("scope_policy_drops")).toBe(0);
  });

  it("offers both when each goes with the source and with the other (control)", async () => {
    const a = source("a", "알", ["a"]);
    const a2 = source("a2", "알2", ["a"]);
    const alpha = knownItem("알파", a);
    const beta = knownItem("베타", a2);
    const c = source("c", "알파와 베타 메모", ["c"]);
    await extract(setUp(noAandB), c);
    expect(requests.map((r) => r.candidateItemIds)).toEqual([[String(alpha), String(beta)]]);
  });
});

describe("scope.policy: candidates the policy would not let be put together are not offered (I04-R14)", () => {
  it("keeps the candidates of the scope of the source and drops the others, whichever place they take", async () => {
    const a = source("a", "알", ["a"]); // lineage of 알파 and 델타
    const c = source("c", "감", ["b"]); // lineage of 감마: the scope of the extracted source
    const alpha = knownItem("알파", a);
    const gamma = knownItem("감마", c);
    const delta = knownItem("델타", a);
    const b = source("b", "알파와 감마와 델타 메모", ["b"]);
    await extract(setUp(sameScopeOnly), b);
    expect(requests.map((r) => r.candidateItemIds)).toEqual([[String(gamma)]]);
    expect([alpha, delta]).toEqual([1, 3]); // the refused ones stood before and after the kept one
  });

  it("offers all of them under the default policy: the V02 flow is unchanged", async () => {
    const a = source("a", "알", ["a"]);
    const c = source("c", "감", ["b"]);
    const alpha = knownItem("알파", a);
    const gamma = knownItem("감마", c);
    const delta = knownItem("델타", a);
    const b = source("b", "알파와 감마와 델타 메모", ["b"]);
    await extract(setUp(defaultScopePolicy), b);
    expect(requests.map((r) => r.candidateItemIds)).toEqual([
      [String(alpha), String(gamma), String(delta)],
    ]);
  });

  it("treats a candidate of unknown scope as one that cannot be put together", async () => {
    const unknown = source("u", "알", null);
    knownItem("알파", unknown);
    const b = source("b", "알파 메모", ["b"]);
    await extract(setUp(sameScopeOnly), b);
    expect(requests.map((r) => r.candidateItemIds)).toEqual([[]]);
  });

  it("offers nothing when the policy cannot judge (a policy error refuses)", async () => {
    const a = source("a", "알", ["a"]);
    knownItem("알파", a);
    const b = source("b", "알파 메모", ["a"]);
    const broken: ScopePolicy = {
      ...defaultScopePolicy,
      combinable: () => {
        throw new Error("cannot judge");
      },
    };
    await extract(setUp(broken), b);
    expect(requests.map((r) => r.candidateItemIds)).toEqual([[]]);
  });
});

const BODY =
  "알파 일정. 알파의 목표일은 2026-12-05입니다. 새것의 완료는 2026-12-10입니다. 알파는 새것에 의존한다.";
const refusedAtCommit = (names: Map<string, string>): Answer => ({
  items: [
    { ref: "X", type: "Project", name: "알파", existingItemId: names.get("알파") ?? null },
    { ref: "N", type: "System", name: "새것", existingItemId: names.get("새것") ?? null },
  ],
  facts: [
    {
      item: "X",
      kind: TARGET_DATE,
      value: "2026-12-05",
      epistemic: "explicit",
      quote: "알파의 목표일은 2026-12-05",
    },
    {
      item: "N",
      kind: COMPLETION_DATE,
      value: "2026-12-10",
      epistemic: "explicit",
      quote: "새것의 완료는 2026-12-10",
    },
  ],
  relations: [{ subject: "X", type: DEPENDS_ON, object: "N", quote: "알파는 새것에 의존한다" }],
});

describe("scope.policy: an item refused at the commit is left out alone (I04-R11)", () => {
  /** a and b share a scope when 알파 is offered; a's narrows while the Provider answers. */
  async function raced() {
    const a = source("a", "알", ["s"]);
    knownItem("알파", a);
    const b = source("b", BODY, ["s"]);
    duringCall = () => setScope(a.sourceId, ["x"]);
    const kit = setUp(sameScopeOnly, refusedAtCommit);
    const run = await extract(kit, b);
    return { a, b, kit, ...run };
  }

  it("writes the rest of the extraction, closes the job succeeded and records each refused item", async () => {
    const { b, job, status } = await raced();
    expect(status).toBe("succeeded");
    expect(readJob(db, job.id)?.status).toBe("succeeded");
    // the new item and its fact are written; the fact on 알파 and the relation from it are not
    expect(db.all("SELECT name FROM items ORDER BY id")).toEqual([
      { name: "알파" },
      { name: "새것" },
    ]);
    expect(db.all("SELECT kind FROM facts ORDER BY id").map((f) => f.kind)).toEqual([
      TARGET_DATE, // 알파's own fact from a's extraction
      COMPLETION_DATE,
    ]);
    expect(count("relations")).toBe(0);
    expect(count("insights")).toBe(0);
    // each refused entry is a record of b's version, with no content
    expect(drops()).toEqual([
      { source_id: b.sourceId, version: 1, kind: "fact" },
      { source_id: b.sourceId, version: 1, kind: "relation" },
      { source_id: b.sourceId, version: 1, kind: "insight" },
    ]);
    expect(JSON.stringify(db.all("SELECT * FROM scope_policy_drops"))).not.toMatch(/알파|새것/);
  });

  it("still records the extraction's own drop counts when the rule's item is the one refused", async () => {
    const { job } = await raced();
    expect(readExtractionDrops(db, job.id)).toEqual({ quotes: 0, other: 0 });
  });
});

describe("scope.changed: the re-extraction a scope change queues clears the records (I04-R15)", () => {
  it("extracts the source again once the scopes allow it, writes what was left out and empties its records", async () => {
    const a = source("a", "알", ["s"]);
    knownItem("알파", a);
    const b = source("b", BODY, ["s"]);
    duringCall = () => {
      setScope(a.sourceId, ["x"]);
      duringCall = undefined; // narrowed once, while the first extraction runs
    };
    const kit = setUp(sameScopeOnly, refusedAtCommit);
    await extract(kit, b);
    expect(drops()).toHaveLength(3);
    expect(count("relations")).toBe(0);

    // a widens back: no new version of b, and a job of b's version with target '' exists already
    setScope(a.sourceId, ["s"]);
    const { propagation } = db.transaction(() =>
      propagateCanonical(
        db,
        { kind: "scope-changed", sourceId: a.sourceId, from: ["x"], to: ["s"] },
        T0.toISOString(),
        kit.registry,
      ),
    );
    const target = `scope-recompute:${propagation.invalidationId}`;
    const queued = db.all(
      "SELECT target, source_id AS s, fence_version AS v, status FROM jobs WHERE target = ?",
      [target],
    );
    expect(queued).toEqual([{ target, s: b.sourceId, v: 1, status: "queued" }]);

    // the job rows may be cleaned up at any time; the records are not job rows
    const again = await extract(kit, b, target);
    expect(again.status).toBe("succeeded");
    expect(count("relations")).toBe(1);
    // 알파's fact on b's date joins the two stored before
    expect(db.all("SELECT kind FROM facts ORDER BY id").map((f) => f.kind)).toEqual([
      TARGET_DATE,
      COMPLETION_DATE,
      TARGET_DATE,
    ]);
    expect(count("scope_policy_drops")).toBe(0);
    // the Insight stands again: its three evidence come from b and a
    // (the two target dates on 알파 are a `conflict` Insight beside it, P01)
    expect(db.all("SELECT state FROM insights WHERE rule = 'dependency_delay'")).toEqual([
      { state: "active" },
    ]);
  });

  it("clears a source's older records when a later extraction of it runs, and only that source's", async () => {
    const a = source("a", "알", ["a"]);
    const b = source("b", "b의 첫 본문", ["b"]);
    db.run(
      `INSERT INTO scope_policy_drops (source_id, version, kind, item_key_hash, reason, at)
       VALUES (?, 1, 'fact', 'h1', 'scope-policy', ?), (?, 1, 'fact', 'h2', 'scope-policy', ?)`,
      [b.sourceId, T0.toISOString(), a.sourceId, T0.toISOString()],
    );
    const b2 = source("b", "b의 둘째 본문", ["b"]);
    expect(b2.version).toBe(2);
    await extract(setUp(defaultScopePolicy), b2);
    expect(drops()).toEqual([{ source_id: a.sourceId, version: 1, kind: "fact" }]);
  });
});

describe("scope.policy: the rule judges an Insight's evidence under the policy as well (I04-R14)", () => {
  it("makes no Insight from evidence of a source the extraction did not draw on, when the policy will not mix it", async () => {
    // T and U are known from a (scope s) and d (scope t): a holds T's target date and the relation
    // T -> U, d holds U's completion date. b (scope s) names T and adds a target date of its own.
    const a = source("a", "알", ["s"]);
    const d = source("d", "덜", ["t"]);
    const t = knownItem("티", a);
    const u = insertItem(db, { type: "System", name: "유", ...attrs });
    const completion = saveFact(db, {
      itemId: u,
      kind: COMPLETION_DATE,
      value: "2026-12-10",
      ...attrs,
    });
    addEvidence(db, {
      target: { factId: completion.id },
      sourceVersionId: d.row,
      start: 0,
      end: 1,
      quote: "덜",
    });
    const relation = saveRelation(db, { subjectId: t, type: DEPENDS_ON, objectId: u, ...attrs });
    addEvidence(db, {
      target: { relationId: relation.id },
      sourceVersionId: a.row,
      start: 0,
      end: 1,
      quote: "알",
    });
    const b = source("b", "티의 목표일은 2026-11-30입니다", ["s"]);
    const answer = (names: Map<string, string>): Answer => ({
      items: [{ ref: "T", type: "Project", name: "티", existingItemId: names.get("티") ?? null }],
      facts: [
        {
          item: "T",
          kind: TARGET_DATE,
          value: "2026-11-30",
          epistemic: "explicit",
          quote: "티의 목표일은 2026-11-30",
        },
      ],
      relations: [],
    });

    const run = await extract(setUp(sameScopeOnly, answer), b);
    expect(run.status).toBe("succeeded");
    // the fact on T is written (a and b share a scope) and the rule ran, but a pair resting on d is no Insight
    expect(count("facts")).toBe(3);
    // (the `conflict` on 티's two target dates rests on a and b, which share a scope: it stands, P01)
    expect(delays()).toBe(0);
    expect(drops()).toEqual([]);

    // the control: under the default policy the same extraction makes the Insight
    db.run("DELETE FROM facts WHERE value = '2026-11-30'");
    const control = await extract(
      setUp(defaultScopePolicy, answer),
      source("b2", "티의 목표일은 2026-11-30입니다", ["s"]),
    );
    expect(control.status).toBe("succeeded");
    expect(delays()).toBe(1);
  });
});

describe("scope.changed: a re-extraction with nothing left to judge makes no call (I04-R15)", () => {
  it("ends succeeded without a Provider request when its source's records are already cleared", async () => {
    const b = source("b", BODY, ["s"]);
    const kit = setUp(sameScopeOnly, refusedAtCommit);
    const run = await extract(kit, b, "scope-recompute:7");
    expect(run.status).toBe("succeeded");
    expect(requests).toEqual([]);
    expect(count("facts")).toBe(0);
  });

  it("still extracts when a record is there", async () => {
    const b = source("b", BODY, ["s"]);
    db.run(
      `INSERT INTO scope_policy_drops (source_id, version, kind, item_key_hash, reason, at)
       VALUES (?, 1, 'fact', 'h', 'scope-policy', ?)`,
      [b.sourceId, T0.toISOString()],
    );
    await extract(setUp(sameScopeOnly, refusedAtCommit), b, "scope-recompute:7");
    expect(requests).toHaveLength(1);
    expect(count("scope_policy_drops")).toBe(0);
  });
});

describe("scope.policy: the job's bookkeeping is not judged (I04-R11)", () => {
  it("clears the old records and records the drop counts although the policy errs on everything", async () => {
    const b = source("b", "메모", ["s"]);
    db.run(
      `INSERT INTO scope_policy_drops (source_id, version, kind, item_key_hash, reason, at)
       VALUES (?, 1, 'fact', 'old', 'scope-policy', ?)`,
      [b.sourceId, T0.toISOString()],
    );
    const throwing: ScopePolicy = {
      ...defaultScopePolicy,
      combinable: () => {
        throw new Error("cannot judge");
      },
    };
    const { job } = await extract(setUp(throwing), b);
    // the old record is gone; the only record left is the rule item this policy refused
    expect(db.all("SELECT kind, item_key_hash FROM scope_policy_drops")).toMatchObject([
      { kind: "insight" },
    ]);
    expect(db.all("SELECT 1 FROM scope_policy_drops WHERE item_key_hash = 'old'")).toEqual([]);
    expect(readExtractionDrops(db, job.id)).toEqual({ quotes: 0, other: 0 });
  });
});
