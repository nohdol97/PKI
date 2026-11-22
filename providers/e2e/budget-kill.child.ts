// The process that providers/src/budget-kill.test.ts kills (I03-R14, C3
// `budget.kill-mid-call`): a Broker over a SQLite file whose Provider never answers.
// It makes one call and waits; the test kills it with SIGKILL once the history
// shows the attempt started. Run by node directly. Not a test of its own; it sits
// under e2e/ so the module-boundary rule treats it as test code.
import { migrate } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { FakeProvider } from "@pki/testkit";
import { createBroker } from "../src/broker.ts";
import { createCallRecorder } from "../src/call-recorder.ts";
import { createUserActionLedger } from "../src/user-actions.ts";

const path = process.argv[2];
if (path === undefined) throw new Error("usage: budget-kill.child.ts <database file>");
const db = openBetterSqlite3(path);
migrate(db);
const ledger = createUserActionLedger();
const broker = createBroker({
  db,
  provider: () => new FakeProvider({ script: ["hang"] }),
  userActions: ledger.redeemer,
  candidates: { lookup: () => undefined },
  egress: {
    decide: () => ({ allowed: true, destination: "fake.example", policyVersion: "pv-test" }),
  },
  execution: { decide: () => ({ run: true }) },
  recorder: createCallRecorder(db),
});
await ledger.issuer.during((userActionId) =>
  broker.call({
    taskKind: "connection-test",
    sourceVersionIds: [],
    candidateItemIds: [],
    origin: { userActionId },
    schemaVersion: 1,
    budget: { timeoutMs: 120_000 },
    retryable: false,
  }),
);
