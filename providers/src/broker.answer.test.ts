// X01-C4b ① (R8, R9): the `answer` task through the real Broker. A user action carries the call; the question
// is the one candidate (graded as text with no source, so the strictest class), the documents are version
// row IDs the Broker reads itself, and an answer is checked against the task's schema before it returns.
import { migrate, registerConnectorInstance, saveSourceRecord } from "@pki/storage";
import type { SqlDriver } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { FakeProvider, memoryDbTemplate } from "@pki/testkit";
import { beforeEach, describe, expect, it } from "vitest";
import { createBroker } from "./broker.ts";
import { ANSWER_SCHEMA_VERSION } from "./tasks.ts";
import { createUserActionLedger } from "./user-actions.ts";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);
const QUESTION = "물결 프로젝트의 배포일은 언제인가";

let db: SqlDriver;
let provider: FakeProvider;
let ledger: ReturnType<typeof createUserActionLedger>;
let broker: ReturnType<typeof createBroker>;
let answer: unknown;

beforeEach(() => {
  db = freshDb();
  registerConnectorInstance(db, "c1", "test-fixtures");
  answer = { sentences: [], insufficient: true };
  provider = new FakeProvider({ answer: () => answer });
  ledger = createUserActionLedger();
  broker = createBroker({
    db,
    provider: () => provider,
    userActions: ledger.redeemer,
    candidates: {
      lookup: (id) =>
        id === "question:t1"
          ? { name: QUESTION, evidenceSourceVersionIds: [], nameUnsourced: true }
          : undefined,
    },
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
});

function store(title: string, body: string): string {
  saveSourceRecord(db, "c1", { externalId: `ext-${title}`, title, body });
  return String(db.all("SELECT max(id) AS id FROM source_versions")[0]?.id);
}

const ask = (ids: string[]) =>
  ledger.issuer.during((userActionId) =>
    broker.call({
      taskKind: "answer",
      sourceVersionIds: ids,
      candidateItemIds: ["question:t1"],
      origin: { userActionId },
      schemaVersion: ANSWER_SCHEMA_VERSION,
      budget: { timeoutMs: 1000 },
      retryable: false,
    }),
  );

describe("broker.answer: the answer task (X01-R8, R9)", () => {
  it("sends the question as the one candidate and the stored documents, strictest class, and returns the checked answer", async () => {
    const id = store("배포 안내", "배포일은 12월 10일이다");
    answer = {
      sentences: [{ text: "12월 10일", documentId: id, quote: "배포일은 12월 10일이다" }],
      insufficient: false,
    };
    const result = await ask([id]);
    expect(result).toMatchObject({ status: "ok", output: answer });
    const sent = provider.requests[0];
    expect(sent?.taskKind).toBe("answer");
    expect(sent?.trigger).toBe("user");
    expect(sent?.dataClassification).toBe("general");
    expect(sent?.input.candidates).toEqual([{ id: "question:t1", name: QUESTION }]);
    expect(sent?.input.untrustedDocuments.map((d) => d.id)).toEqual([id]);
  });

  it("rejects an answer without a quote or without the insufficiency flag as invalid output", async () => {
    const id = store("배포 안내", "배포일은 12월 10일이다");
    answer = { sentences: [{ text: "12월 10일", documentId: id }], insufficient: false };
    expect(await ask([id])).toMatchObject({ status: "failed", error: "invalid-output" });
    answer = { sentences: [] };
    expect(await ask([id])).toMatchObject({ status: "failed", error: "invalid-output" });
  });
});
