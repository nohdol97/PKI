// I03-R14, C3 `budget.kill-mid-call`: a Broker process killed (SIGKILL) while a
// Provider call is out. The history keeps a "started" row (the outcome is not
// "unrecognized"); a Broker started afterwards fixes it to "interrupted", still
// counts that attempt in its budget, and the history listing the Activity screen
// reads shows it as interrupted. The Broker runs as a child process of node.
import { listProviderCalls, migrate } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { FakeProvider } from "@pki/testkit";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createBroker, DEFAULT_LIMITS } from "./broker.ts";
import { createCallRecorder } from "./call-recorder.ts";
import { createUserActionLedger } from "./user-actions.ts";

const CHILD = join(import.meta.dirname, "../e2e/budget-kill.child.ts");
let dir: string | undefined;
let child: ChildProcess | undefined;

afterEach(() => {
  child?.kill("SIGKILL");
  child = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function until(what: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

it("a call killed midway leaves a started row, interrupted at the next start and still counted", async () => {
  dir = mkdtempSync(join(tmpdir(), "pki-budget-kill-"));
  const file = join(dir, "canonical.db");
  const db = openBetterSqlite3(file);
  migrate(db);
  const started = () => listProviderCalls(db).map((c) => c.outcome);
  child = spawn(process.execPath, [CHILD, file], { stdio: "inherit" });
  const exited = new Promise<void>((resolve) => child?.once("exit", () => resolve()));
  await until("the started row", () => started().includes("started"));
  child.kill("SIGKILL");
  await exited;

  expect(started()).toEqual(["started"]);

  const ledger = createUserActionLedger();
  const provider = new FakeProvider();
  const broker = createBroker({
    db,
    provider: () => provider,
    userActions: ledger.redeemer,
    candidates: { lookup: () => undefined },
    egress: { decide: () => ({ allowed: true, destination: "d", policyVersion: "p" }) },
    execution: { decide: () => ({ run: true }) },
    recorder: createCallRecorder(db),
  });
  expect(started()).toEqual(["interrupted"]);
  expect(broker.budgetUsage()).toMatchObject({
    used: 1,
    maxCalls: DEFAULT_LIMITS.callBudget.maxCalls,
  });
  db.close();
}, 60_000);
