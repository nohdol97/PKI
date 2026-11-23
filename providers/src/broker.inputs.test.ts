// V01-C4 `broker.payload`, `broker.class`, `broker.origin` (V01-R8): the caller
// names IDs only. The text that goes out, its data classification and the call
// kind are what the Broker reads from the canonical store, the synthetic
// manifest and its own records; a request carrying any of them is rejected
// before the flow, as is a missing or already used record.
import type { BrokerRequest, LLMRequest } from "@pki/contracts";
import {
  closeJob,
  JOB_STATUSES,
  leaseNextJob,
  migrate,
  readJob,
  registerConnectorInstance,
  registerJob,
  saveSourceRecord,
  supersedeOpenJobs,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { FakeProvider } from "@pki/testkit";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createBroker, type CandidateItem, type ExecutionInput } from "./broker.ts";
import { TASKS } from "./tasks.ts";
import { createUserActionLedger } from "./user-actions.ts";

const fixtures = readFileSync(
  resolve(import.meta.dirname, "../../fixtures/test-connector.jsonl"),
  "utf8",
)
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as { title: string; body: string; malicious?: boolean });
const plain = fixtures.filter((f) => !f.malicious);
const malicious = fixtures.find((f) => f.malicious);
const material = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "connection-test-material.json"), "utf8"),
) as { title: string; body: string };
if (plain.length < 2 || !malicious)
  throw new Error("fixtures need two plain and one malicious record");
const [synthA, synthB] = plain as [(typeof plain)[number], (typeof plain)[number]];

let db: SqlDriver;
let provider: FakeProvider;
let ledger: ReturnType<typeof createUserActionLedger>;
let candidates: Map<string, CandidateItem>;
let execution: ExecutionInput[];
let broker: ReturnType<typeof createBroker>;

beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  provider = new FakeProvider({
    answer: (r) =>
      r.taskKind === "extract"
        ? { items: [], facts: [], relations: [], terms: [], definitions: [] }
        : { reply: "ok" },
  });
  ledger = createUserActionLedger();
  candidates = new Map();
  execution = [];
  broker = createBroker({
    db,
    provider: () => provider,
    userActions: ledger.redeemer,
    candidates: { lookup: (id) => candidates.get(id) },
    egress: { decide: () => ({ allowed: true, destination: "fake", policyVersion: "pv" }) },
    execution: {
      decide: (input) => {
        execution.push(input);
        return { run: true };
      },
    },
    recorder: {
      record: () => undefined,
      begin: () => () => undefined,
      attemptTimes: () => [],
      interruptStarted: () => 0,
    },
    clock: { now: () => 0, sleep: async () => undefined },
  });
});

let seq = 0;
/** Stores one source the way a Connector sync would and returns its version ID. */
function store(
  record: { title: string; body: string },
  options: { kind?: string; instance?: string; accessScope?: string } = {},
): string {
  const kind = options.kind ?? "test-fixtures";
  const instance = options.instance ?? kind;
  registerConnectorInstance(db, instance, kind);
  const externalId = `ext-${++seq}`;
  saveSourceRecord(db, instance, { externalId, ...record });
  if (options.accessScope !== undefined) {
    db.run("UPDATE sources SET access_scope = ? WHERE external_id = ?", [
      options.accessScope,
      externalId,
    ]);
  }
  return String(db.all("SELECT max(id) AS id FROM source_versions")[0]?.id);
}

const extract = (ids: string[], extra: Partial<BrokerRequest> = {}) => ({
  taskKind: "extract" as const,
  sourceVersionIds: ids,
  candidateItemIds: [],
  schemaVersion: 5,
  budget: { timeoutMs: 1000 },
  retryable: false,
  ...extra,
});

/** Calls inside one user action, the way the API layer would. */
function asUser(request: object) {
  return ledger.issuer.during((userActionId) =>
    broker.call({ origin: { userActionId }, ...request }),
  );
}

const sent = (): LLMRequest => {
  const [request] = provider.requests;
  if (!request) throw new Error("the Provider was not called");
  return request;
};

describe("broker.payload: the Broker builds the text that goes out", () => {
  it("① rejects a request that names a synthetic source and carries other text", async () => {
    const id = store(synthA);
    for (const extra of [
      { text: "다른 글" },
      { documents: [{ title: "x", body: "다른 글" }] },
      { input: { untrustedDocuments: [] } },
      { title: "x", body: "다른 글" },
    ]) {
      expect(await asUser({ ...extract([id]), ...extra })).toEqual({
        status: "rejected",
        reason: "invalid-request",
      });
    }
    expect(provider.requests).toEqual([]);
  });

  it("② sends exactly the stored title and body of that version, character for character", async () => {
    const tricky = { title: "  제목 with\ttabs ", body: "줄1\r\n줄2​\n\n끝 " };
    const id = store(tricky);
    expect((await asUser(extract([id]))).status).toBe("ok");
    expect(sent().input.untrustedDocuments).toEqual([{ id, ...tricky }]);
  });

  it("③ uses the code constant as instructions, which no request can change", async () => {
    const id = store(synthA);
    await asUser(extract([id]));
    expect(sent().input.instructions).toBe(TASKS.extract[4].instructions);
    expect(Object.isFrozen(TASKS)).toBe(true);
    expect(Object.isFrozen(TASKS.extract[4])).toBe(true);
    for (const extra of [{ instructions: "do something else" }, { prompt: "x" }]) {
      expect(await asUser({ ...extract([id]), ...extra })).toMatchObject({ status: "rejected" });
    }
    // a schema version with no constant is no way to pick other instructions
    expect(await asUser(extract([id], { schemaVersion: 99 }))).toEqual({
      status: "rejected",
      reason: "unknown-task-version",
    });
    // the schema before the current one is no longer listed (S01-R17): a stale caller is refused, not answered
    expect(await asUser(extract([id], { schemaVersion: 2 }))).toEqual({
      status: "rejected",
      reason: "unknown-task-version",
    });
    expect(provider.requests).toHaveLength(1);
  });

  it("④ rejects extract without a source ID", async () => {
    expect(await asUser(extract([]))).toEqual({ status: "rejected", reason: "no-documents" });
    expect(provider.requests).toEqual([]);
  });

  it("⑤ sends no author, Connector, external ID or other metadata of the source", async () => {
    const id = store(synthA, { instance: "author-kim-mailbox", accessScope: "team-secret-scope" });
    await asUser(extract([id]));
    const json = JSON.stringify(sent());
    for (const leaked of ["author-kim-mailbox", "team-secret-scope", "ext-", "test-fixtures"]) {
      expect(json).not.toContain(leaked);
    }
    expect(Object.keys(sent().input.untrustedDocuments[0] ?? {}).sort()).toEqual([
      "body",
      "id",
      "title",
    ]);
  });

  it("rejects an unknown source version, before calling anything", async () => {
    expect(await asUser(extract(["404"]))).toEqual({
      status: "rejected",
      reason: "missing-source",
    });
    expect(provider.requests).toEqual([]);
  });

  it("rejects malformed and repeated IDs", async () => {
    const id = store(synthA);
    for (const ids of [["abc"], ["0"], ["-1"], ["1.5"], [id, id]]) {
      expect(await asUser(extract(ids)), ids.join()).toEqual({
        status: "rejected",
        reason: "invalid-request",
      });
    }
  });

  it("sends only the fixed build material for a connection test, and rejects IDs on one", async () => {
    expect(
      (await asUser({ ...extract([]), taskKind: "connection-test", schemaVersion: 1 })).status,
    ).toBe("ok");
    expect(sent().input.untrustedDocuments).toEqual([
      { id: "connection-test-material", title: material.title, body: material.body },
    ]);
    const id = store(synthA);
    expect(
      await asUser({ ...extract([id]), taskKind: "connection-test", schemaVersion: 1 }),
    ).toEqual({
      status: "rejected",
      reason: "unexpected-ids",
    });
    candidates.set("item-1", { name: "n", evidenceSourceVersionIds: [id] });
    expect(
      await asUser({
        ...extract([]),
        taskKind: "connection-test",
        schemaVersion: 1,
        candidateItemIds: ["item-1"],
      }),
    ).toEqual({ status: "rejected", reason: "unexpected-ids" });
  });

  it("sends a candidate item's name, read by the Broker, never its evidence text", async () => {
    const evidence = store(synthB);
    candidates.set("item-1", { name: "등대 점검", evidenceSourceVersionIds: [evidence] });
    const id = store(synthA);
    await asUser(extract([id], { candidateItemIds: ["item-1"] }));
    expect(sent().input.candidates).toEqual([{ id: "item-1", name: "등대 점검" }]);
    expect(JSON.stringify(sent())).not.toContain(synthB.body);
    expect(await asUser(extract([id], { candidateItemIds: ["item-404"] }))).toEqual({
      status: "rejected",
      reason: "missing-candidate",
    });
  });
});

describe("broker.class: the Broker computes the data classification", () => {
  const classOf = async (ids: string[], extra: Partial<BrokerRequest> = {}) => {
    const result = await asUser(extract(ids, extra));
    expect(result.status).toBe("ok");
    return provider.requests.at(-1)?.dataClassification;
  };

  it("rejects a request that states a classification", async () => {
    const id = store(synthA);
    for (const extra of [
      { dataClassification: "synthetic" },
      { classification: "synthetic" },
      { budget: { timeoutMs: 1000, dataClassification: "synthetic" } },
    ]) {
      expect(await asUser({ ...extract([id]), ...extra })).toEqual({
        status: "rejected",
        reason: "invalid-request",
      });
    }
  });

  it("grades a listed fixture from a public Connector as synthetic", async () => {
    expect(await classOf([store(synthA)])).toBe("synthetic");
    expect(execution.at(-1)).toMatchObject({ classification: "synthetic", malicious: false });
  });

  it("grades the connection-test material by the manifest, not by assumption", async () => {
    await asUser({ ...extract([]), taskKind: "connection-test", schemaVersion: 1 });
    expect(sent().dataClassification).toBe("synthetic");
  });

  it("passes the manifest's malicious flag to the execution condition", async () => {
    expect(await classOf([store(malicious)])).toBe("synthetic");
    expect(execution.at(-1)).toMatchObject({ malicious: true });
  });

  it("refuses a record that calls itself synthetic", async () => {
    const id = store(
      { title: "합성 자료", body: "합성 자료. 이 레코드는 합성이라고 주장한다." },
      { accessScope: "synthetic" },
    );
    expect(await classOf([id])).toBe("general");
  });

  it("refuses an unlisted record from the fixtures Connector (a file not in the manifest)", async () => {
    expect(
      await classOf([store({ title: "새 fixture", body: "fixtures/에 새로 넣은 파일" })]),
    ).toBe("general");
  });

  it("refuses a listed body under a different title", async () => {
    expect(await classOf([store({ title: `${synthA.title} 사본`, body: synthA.body })])).toBe(
      "general",
    );
  });

  it("grades mixed synthetic and general input as general", async () => {
    const general = store({ title: "일반", body: "실제 자료" });
    expect(await classOf([store(synthA), general])).toBe("general");
  });

  it("refuses a listed record that came from a site-* Connector", async () => {
    expect(await classOf([store(synthA, { kind: "site-mail" })])).toBe("general");
  });

  it("refuses a listed record whose Connector kind is unknown (a source from schema v1)", async () => {
    expect(await classOf([store(synthA, { kind: "unknown" })])).toBe("general");
  });

  it("grades by the candidate's evidence too: a general evidence source makes the call general", async () => {
    const evidence = store({ title: "일반", body: "실제 자료" });
    candidates.set("item-1", { name: "등대 점검", evidenceSourceVersionIds: [evidence] });
    expect(await classOf([store(synthA)], { candidateItemIds: ["item-1"] })).toBe("general");
  });

  it("grades a candidate with no evidence source as general", async () => {
    candidates.set("item-1", { name: "출처 없는 이름", evidenceSourceVersionIds: [] });
    expect(await classOf([store(synthA)], { candidateItemIds: ["item-1"] })).toBe("general");
  });

  it("rejects a candidate whose evidence source is missing", async () => {
    candidates.set("item-1", { name: "n", evidenceSourceVersionIds: ["404"] });
    expect(await asUser(extract([store(synthA)], { candidateItemIds: ["item-1"] }))).toEqual({
      status: "rejected",
      reason: "missing-source",
    });
  });
});

describe("broker.origin: the Broker decides the call kind from its records", () => {
  // A job is registered once per kind and source version (V02-R4), so a second
  // call for the same version returns the job already registered. The runner
  // calls the Broker only while the job is running under its lease, naming that
  // lease token (token 1 here, V02-T03, I03-R2).
  function job(kind = "extract", sourceVersionId = store(synthA), status = "running"): string {
    const version = db.all("SELECT source_id, version FROM source_versions WHERE id = ?", [
      Number(sourceVersionId),
    ])[0];
    const r = registerJob(db, {
      kind,
      sourceId: version?.source_id as number,
      fenceVersion: version?.version as number,
    });
    const id = r.registered ? r.job.id : r.existing.id;
    db.run("UPDATE jobs SET status = ?, lease_token = 1 WHERE id = ?", [status, id]);
    return String(id);
  }

  it("treats a call from a job record as background", async () => {
    const id = store(synthA);
    const result = await broker.call({
      ...extract([id]),
      origin: { jobId: job("extract", id), leaseToken: "1" },
    });
    expect(result.status).toBe("ok");
    expect(sent().trigger).toBe("background");
    expect(execution.at(-1)).toMatchObject({ trigger: "background" });
  });

  it("treats a call inside a user action as a user call", async () => {
    await asUser(extract([store(synthA)]));
    expect(sent().trigger).toBe("user");
  });

  it("rejects a request that states the call kind", async () => {
    const id = store(synthA);
    for (const extra of [
      { trigger: "user" },
      { callKind: "user" },
      { origin: { jobId: job(), leaseToken: "1", trigger: "user" } },
      { origin: { jobId: job(), leaseToken: "1", userActionId: "x" } },
    ]) {
      expect(
        await broker.call({
          ...extract([id]),
          origin: { jobId: job(), leaseToken: "1" },
          ...extra,
        }),
      ).toEqual({
        status: "rejected",
        reason: "invalid-request",
      });
    }
    expect(provider.requests).toEqual([]);
  });

  it("rejects a user action record made by job-runner code instead of the API layer", async () => {
    const id = store(synthA);
    // job-runner code has the Broker but not the API layer's issuer; a ledger of its own
    // mints records the Broker never issued
    const runnerLedger = createUserActionLedger();
    const result = await runnerLedger.issuer.during((userActionId) =>
      broker.call({ ...extract([id]), origin: { userActionId } }),
    );
    expect(result).toEqual({ status: "rejected", reason: "unknown-origin" });
    expect(await broker.call({ ...extract([id]), origin: { userActionId: "forged" } })).toEqual({
      status: "rejected",
      reason: "unknown-origin",
    });
    expect(provider.requests).toEqual([]);
  });

  it("rejects a user action record used a second time", async () => {
    const id = store(synthA);
    const [first, second] = await ledger.issuer.during(async (userActionId) => [
      await broker.call({ ...extract([id]), origin: { userActionId } }),
      await broker.call({ ...extract([id]), origin: { userActionId } }),
    ]);
    expect(first?.status).toBe("ok");
    expect(second).toEqual({ status: "rejected", reason: "origin-used" });
    expect(provider.requests).toHaveLength(1);
  });

  it("uses up a user action record even when the call it carried is rejected", async () => {
    const results = await ledger.issuer.during(async (userActionId) => [
      await broker.call({ ...extract(["404"]), origin: { userActionId } }),
      await broker.call({ ...extract([store(synthA)]), origin: { userActionId } }),
    ]);
    expect(results.map((r) => r.status === "rejected" && r.reason)).toEqual([
      "missing-source",
      "origin-used",
    ]);
  });

  it("rejects a user action record after its request ended", async () => {
    let kept = "";
    await ledger.issuer.during(async (userActionId) => {
      kept = userActionId;
    });
    expect(
      await broker.call({ ...extract([store(synthA)]), origin: { userActionId: kept } }),
    ).toEqual({
      status: "rejected",
      reason: "unknown-origin",
    });
  });

  it("ends the record even when the request handler throws", async () => {
    let kept = "";
    await expect(
      ledger.issuer.during(async (userActionId) => {
        kept = userActionId;
        throw new Error("handler failed");
      }),
    ).rejects.toThrow("handler failed");
    expect(ledger.redeemer.redeem(kept)).toBe("unknown");
  });

  it("rejects a missing job record and a job of another task kind", async () => {
    const id = store(synthA);
    expect(
      await broker.call({ ...extract([id]), origin: { jobId: "404", leaseToken: "1" } }),
    ).toEqual({
      status: "rejected",
      reason: "unknown-origin",
    });
    expect(
      await broker.call({
        ...extract([id]),
        origin: { jobId: job("connection-test", id), leaseToken: "1" },
      }),
    ).toEqual({ status: "rejected", reason: "origin-mismatch" });
  });

  it("broker.origin-running: rejects a job record that is not running: queued, waiting or closed", async () => {
    // V01 "T07이 넘기는 것" 6: a used job record is decided with the lease (V02-T03),
    // by the renamed status (I03-R2): every status but running is refused
    for (const status of JOB_STATUSES.filter((s) => s !== "running")) {
      const id = store({ ...synthA, body: `${synthA.body} ${status}` });
      expect(
        await broker.call({
          ...extract([id]),
          origin: { jobId: job("extract", id, status), leaseToken: "1" },
        }),
      ).toEqual({ status: "rejected", reason: "origin-not-leased" });
    }
    expect(provider.requests).toEqual([]);
  });

  it("rejects the call of a holder whose lease ran out and was taken again", async () => {
    // V02-T03 rework: the stale holder can neither call nor close
    const id = store(synthA);
    const version = db.all("SELECT source_id, version FROM source_versions WHERE id = ?", [
      Number(id),
    ])[0];
    registerJob(db, {
      kind: "extract",
      sourceId: version?.source_id as number,
      fenceVersion: version?.version as number,
      at: new Date("2026-11-21T00:00:00.000Z"), // due at the first claim below (I03-T03)
    });
    const claim = (now: Date): StoredJob => {
      const job = leaseNextJob(db, { kinds: ["extract"], now, leaseMs: 1000 });
      if (!job) throw new Error("expected a claim");
      return job;
    };
    const origin = (job: StoredJob) => ({
      jobId: String(job.id),
      leaseToken: String(job.leaseToken),
    });
    const old = claim(new Date("2026-11-21T00:00:00.000Z"));
    const fresh = claim(new Date("2026-11-21T00:00:02.000Z"));

    expect(await broker.call({ ...extract([id]), origin: origin(old) })).toEqual({
      status: "rejected",
      reason: "origin-not-leased",
    });
    expect(await broker.call({ ...extract([id]), origin: { jobId: String(old.id) } })).toEqual({
      status: "rejected",
      reason: "invalid-request",
    });
    expect(provider.requests).toEqual([]);
    expect((await broker.call({ ...extract([id]), origin: origin(fresh) })).status).toBe("ok");

    expect(closeJob(db, fresh, { status: "succeeded", write: () => {} })).toBe("succeeded");
    expect(closeJob(db, old, { status: "held", reason: "cli-background-off" })).toBe("not-leased");
    expect(readJob(db, old.id)).toMatchObject({ status: "succeeded", reason: null });
  });

  it("broker.origin-running: passes a running job's current token, refuses it once the source's jobs close", async () => {
    // I03-R2, R3: a token that no longer matches (a reclaim, a source closing) is a stale runner
    const id = store(synthA);
    const jobId = job("extract", id);
    const call = (leaseToken: string) =>
      broker.call({ ...extract([id]), origin: { jobId, leaseToken } });
    expect(await call("2")).toEqual({ status: "rejected", reason: "origin-not-leased" });
    expect(provider.requests).toEqual([]);
    expect((await call("1")).status).toBe("ok");
    const calls = provider.requests.length;
    supersedeOpenJobs(db, readJob(db, Number(jobId))?.sourceId as number);
    expect(readJob(db, Number(jobId))).toMatchObject({ status: "superseded", leaseToken: 2 });
    for (const token of ["1", "2"]) {
      expect(await call(token)).toEqual({ status: "rejected", reason: "origin-not-leased" });
    }
    expect(provider.requests).toHaveLength(calls);
  });

  it("issues unguessable record IDs and keeps no record on disk", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 3; i++) await ledger.issuer.during(async (id) => void ids.add(id));
    expect(ids.size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const tables = db
      .all("SELECT name FROM sqlite_schema WHERE type = 'table'")
      .map((r) => r.name as string);
    expect(tables.filter((t) => /action/i.test(t))).toEqual([]);
  });
});
