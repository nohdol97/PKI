// I03-T07 `held.precheck`, the Broker half (I03-R16 ②): one judgement for a
// (reason, Provider) instead of one per held job. It makes the real call's
// decisions (Provider, capabilities, egress, execution) but never calls the Provider's
// model and writes no history; the call is background, of the strictest grade, and
// the CLI's version query is remembered for an hour per Provider.
import { migrate } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { FakeProvider } from "@pki/testkit";
import { describe, expect, it } from "vitest";
import {
  createBroker,
  PRECHECK_VERSION_MEMORY_MS,
  type CallRecord,
  type EgressInput,
  type EgressPolicy,
  type ExecutionInput,
} from "./broker.ts";
import { createUserActionLedger } from "./user-actions.ts";

function setup(
  options: {
    provider?: FakeProvider | undefined;
    egress?: EgressPolicy["decide"];
    run?: (input: ExecutionInput) => { run: true } | { run: false; reason: string };
  } = {},
) {
  const db = openBetterSqlite3(":memory:");
  migrate(db);
  const records: CallRecord[] = [];
  const egressInputs: EgressInput[] = [];
  const executionInputs: ExecutionInput[] = [];
  let now = 0;
  const provider =
    "provider" in options
      ? options.provider
      : new FakeProvider({ id: "claude-code", transport: "cli" });
  const broker = createBroker({
    db,
    provider: () => provider,
    userActions: createUserActionLedger().redeemer,
    candidates: { lookup: () => undefined },
    egress: {
      decide: (input) => {
        egressInputs.push(input);
        return (
          options.egress?.(input) ?? { allowed: true, destination: "fake", policyVersion: "pv" }
        );
      },
    },
    execution: {
      decide: (input) => {
        executionInputs.push(input);
        return options.run?.(input) ?? { run: true };
      },
    },
    recorder: { record: (entry) => void records.push(entry) },
    clock: { now: () => now, sleep: async () => undefined },
  });
  return {
    db,
    broker,
    records,
    egressInputs,
    executionInputs,
    tick: (ms: number) => void (now += ms),
  };
}

describe("broker.precheck (I03-R16 ②)", () => {
  it("passes when the real call's decisions pass, as a background call of the strictest grade, writing no history", async () => {
    const provider = new FakeProvider({ id: "claude-code", transport: "cli" });
    const { broker, records, egressInputs, executionInputs } = setup({ provider });
    expect(await broker.precheck({ providerId: "claude-code", taskKind: "extract" })).toEqual({
      allowed: true,
    });
    expect(egressInputs).toEqual([
      { providerId: "claude-code", taskKind: "extract", classification: "general" },
    ]);
    expect(executionInputs).toEqual([
      {
        providerId: "claude-code",
        transport: "cli",
        taskKind: "extract",
        trigger: "background",
        classification: "general",
        malicious: true,
        version: "fake-1",
        unverifiedAcknowledged: false,
      },
    ]);
    expect(records).toEqual([]);
    expect(provider.requests).toEqual([]);
  });

  it("answers the egress denial's reason, before any version query", async () => {
    let queries = 0;
    const provider = new FakeProvider({
      id: "claude-code",
      transport: "cli",
      detect: async () => (queries++, { installed: true, version: "1" }),
    });
    const { broker } = setup({
      provider,
      egress: () => ({ allowed: false, reason: "no-consent" }),
    });
    expect(await broker.precheck({ providerId: "claude-code", taskKind: "extract" })).toEqual({
      allowed: false,
      reason: "no-consent",
    });
    expect(queries).toBe(0);
  });

  it("answers the execution gate's reason", async () => {
    const { broker } = setup({ run: () => ({ run: false, reason: "cli-not-verified" }) });
    expect(await broker.precheck({ providerId: "claude-code", taskKind: "extract" })).toEqual({
      allowed: false,
      reason: "cli-not-verified",
    });
  });

  it("blocks with no-provider when none is selected or the selected one is not the one asked about", async () => {
    expect(
      await setup({ provider: undefined }).broker.precheck({
        providerId: "claude-code",
        taskKind: "extract",
      }),
    ).toEqual({ allowed: false, reason: "no-provider" });
    expect(await setup().broker.precheck({ providerId: "codex", taskKind: "extract" })).toEqual({
      allowed: false,
      reason: "no-provider",
    });
  });

  it("blocks a Provider with no structured output or unreadable capabilities", async () => {
    const none = new FakeProvider({
      id: "claude-code",
      transport: "cli",
      capabilities: { structuredOutput: false },
    });
    expect(
      await setup({ provider: none }).broker.precheck({
        providerId: "claude-code",
        taskKind: "extract",
      }),
    ).toEqual({ allowed: false, reason: "structured-output-unsupported" });
  });

  it("remembers a CLI's version for an hour: 200 judgements, one query", async () => {
    let queries = 0;
    const provider = new FakeProvider({
      id: "claude-code",
      transport: "cli",
      detect: async () => (queries++, { installed: true, version: "2.1.3" }),
    });
    const { broker, tick } = setup({ provider });
    for (let i = 0; i < 200; i++) {
      await broker.precheck({ providerId: "claude-code", taskKind: "extract" });
    }
    expect(queries).toBe(1);
    tick(PRECHECK_VERSION_MEMORY_MS + 1);
    await broker.precheck({ providerId: "claude-code", taskKind: "extract" });
    expect(queries).toBe(2);
  });

  it("does not query an HTTP Provider's version", async () => {
    let queries = 0;
    const provider = new FakeProvider({
      id: "openai-compatible",
      transport: "http",
      detect: async () => (queries++, { installed: true, version: "x" }),
    });
    const { broker, executionInputs } = setup({ provider });
    await broker.precheck({ providerId: "openai-compatible", taskKind: "extract" });
    expect(queries).toBe(0);
    expect(executionInputs[0]?.version).toBeUndefined();
  });
});
