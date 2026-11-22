// I01-C2 `scope.claimed-grade` (I01-R15), review V1: "never widens" must not depend on a fork's
// `strictest`. With a second class in the closed set (the only way to tell "in the set" from "one of
// the inputs"), a `strictest` that answers a class that was not among its inputs is refused.
import {
  migrate,
  registerConnectorInstance,
  saveSourceRecord,
  setConfiguredScope,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { FakeProvider } from "@pki/testkit";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./scope-grading.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scope-grading.ts")>()),
  SCOPE_CLASSES: ["general", "restricted"],
}));

const { createBroker } = await import("./broker.ts");
const { createUserActionLedger } = await import("./user-actions.ts");

let db: SqlDriver;
let provider: FakeProvider;
let answerOf: (classes: readonly string[]) => string;
let graded: Record<string, string>;

beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  provider = new FakeProvider({ answer: () => ({ items: [], facts: [], relations: [] }) });
  graded = { open: "restricted", team: "restricted" };
  answerOf = (classes) => classes[0] as string;
});

function sourceId(): string {
  registerConnectorInstance(db, "imp", "jsonl-import");
  setConfiguredScope(db, "imp", ["team"]);
  saveSourceRecord(db, "imp", { externalId: "e", title: "t", body: "본문" });
  db.run("UPDATE sources SET scope_claimed = 1, access_scope = ?", [JSON.stringify(["open"])]);
  return String(db.all("SELECT max(id) AS id FROM source_versions")[0]?.id);
}

async function call(ids: string[], inputs: string[][] = []) {
  const ledger = createUserActionLedger();
  const broker = createBroker({
    db,
    provider: () => provider,
    userActions: ledger.redeemer,
    candidates: { lookup: () => undefined },
    egress: { decide: () => ({ allowed: true, destination: "fake", policyVersion: "pv" }) },
    execution: { decide: () => ({ run: true }) },
    recorder: {
      record: () => undefined,
      begin: () => () => undefined,
      attemptTimes: () => [],
      interruptStarted: () => 0,
    },
    clock: { now: () => 0, sleep: async () => undefined },
    scope: {
      policy: {
        compare: () => "looser",
        strictest: () => null,
        combinable: () => true,
        allows: () => true,
      },
      grading: {
        grade: (scope) => graded[scope?.[0] ?? ""] as "general",
        strictest: (classes) => {
          inputs.push([...classes]);
          return answerOf(classes) as "general";
        },
      },
    },
  });
  return ledger.issuer.during((userActionId) =>
    broker.call({
      origin: { userActionId },
      taskKind: "extract",
      sourceVersionIds: ids,
      candidateItemIds: [],
      schemaVersion: 2,
      budget: { timeoutMs: 1000 },
      retryable: false,
    }),
  );
}

describe("scope.claimed-grade: the combined class is one of the two classes asked about", () => {
  it("an answer that is in the set but was not among the inputs is refused", async () => {
    answerOf = () => "general"; // the inputs are both restricted
    expect(await call([sourceId()])).toEqual({ status: "rejected", reason: "scope-unjudged" });
    expect(provider.requests).toEqual([]);
  });

  it("an answer that is one of the inputs passes", async () => {
    const inputs: string[][] = [];
    graded = { open: "general", team: "restricted" };
    answerOf = () => "restricted";
    expect((await call([sourceId()], inputs)).status).toBe("ok");
    expect(inputs).toEqual([["general", "restricted"]]);
  });

  it("with no input (the strictest asked for) any class of the set passes", async () => {
    registerConnectorInstance(db, "imp2", "jsonl-import");
    saveSourceRecord(db, "imp2", { externalId: "e", title: "t", body: "본문" });
    db.run(
      "UPDATE sources SET scope_claimed = 1, access_scope = ? WHERE external_id = 'e' AND connector_instance_id = 'imp2'",
      [JSON.stringify(["open"])],
    );
    answerOf = () => "restricted";
    const id = String(db.all("SELECT max(id) AS id FROM source_versions")[0]?.id);
    expect((await call([id])).status).toBe("ok"); // imp2 has no configured scope: strictest([])
  });
});
