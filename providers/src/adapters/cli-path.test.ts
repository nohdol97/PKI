// One executable per attempt (T09 handoff 5 ①, T10 handoff 6): the version query
// and the run use the same absolute path, found once. A PATH that changes between
// the query and the run does not redirect the run; each attempt finds its own path
// and is judged on that executable's version, through the Broker too.
import { ProviderError, type StructuredRequest } from "@pki/contracts";
import { migrate } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { installFakeCli, structuredRequest, type FakeCli } from "@pki/testkit";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createBroker, type ExecutionInput } from "../broker.ts";
import { CLI_PROFILES } from "../cli-profiles.ts";
import { createUserActionLedger } from "../user-actions.ts";
import { createClaudeCodeProvider } from "./cli-provider.ts";

// every fake CLI run is a Node start: slow when the whole suite runs in parallel
vi.setConfig({ testTimeout: 30_000 });

const a: FakeCli = installFakeCli({ version: "2.1.3" });
const b: FakeCli = installFakeCli({ version: "2.1.4" });
afterAll(() => {
  a.dispose();
  b.dispose();
});
beforeEach(() => {
  for (const f of [a, b]) {
    f.reset();
    f.configure({ version: f === a ? "2.1.3" : "2.1.4" });
  }
});

const PROFILE = CLI_PROFILES["claude-code"].standard;
const request = (executable?: string): StructuredRequest => ({
  ...structuredRequest(),
  budget: { timeoutMs: 30_000 },
  execution: {
    profile: PROFILE,
    isolation: "verified",
    ...(executable === undefined ? {} : { executable }),
  },
});
const live = () => new AbortController().signal;

describe("cli path: the Provider", () => {
  it("runs the path its version query found, not what PATH names now", async () => {
    const env: Record<string, string> = { PATH: a.bin };
    const provider = createClaudeCodeProvider({ env });
    const info = await provider.detect();
    expect(info).toMatchObject({ path: a.path("claude"), version: "2.1.3" });
    env.PATH = b.bin; // the CLI moved or PATH changed after the decision
    await provider.generateStructured(request(info.path), live());
    expect([a.modelCalls(), b.modelCalls()]).toEqual([1, 0]);
  });

  it("refuses a relative executable", async () => {
    const provider = createClaudeCodeProvider({ env: { PATH: a.bin } });
    const error = await provider.generateStructured(request("claude"), live()).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(a.runs()).toEqual([]);
  });

  it("finds the path once for a request that brings none", async () => {
    const provider = createClaudeCodeProvider({ env: { PATH: a.bin } });
    await provider.generateStructured(request(), live());
    expect(a.modelCalls()).toBe(1);
  });
});

describe("cli path: through the Broker", () => {
  function broker(provider: ReturnType<typeof createClaudeCodeProvider>) {
    const db = openBetterSqlite3(":memory:");
    migrate(db);
    const ledger = createUserActionLedger();
    const judged: ExecutionInput[] = [];
    const instance = createBroker({
      db,
      provider: () => provider,
      userActions: ledger.redeemer,
      candidates: { lookup: () => undefined },
      egress: {
        decide: () => ({ allowed: true, destination: "vendor:claude-code", policyVersion: "pv" }),
      },
      execution: {
        decide: (input) => {
          judged.push(input);
          return { run: true, cli: { profile: PROFILE, isolation: "verified" } };
        },
      },
      recorder: { record: () => undefined },
      clock: { now: () => 0, sleep: async () => undefined },
    });
    const call = () =>
      ledger.issuer.during((userActionId) =>
        instance.call({
          taskKind: "connection-test",
          sourceVersionIds: [],
          candidateItemIds: [],
          origin: { userActionId },
          schemaVersion: 1,
          budget: { timeoutMs: 20_000 },
          retryable: true,
        }),
      );
    return { call, judged };
  }

  it("runs the executable whose version it judged, though PATH changed in between", async () => {
    const env: Record<string, string> = { PATH: a.bin };
    const provider = createClaudeCodeProvider({ env });
    const detect = provider.detect.bind(provider);
    provider.detect = async () => {
      const info = await detect();
      env.PATH = b.bin; // right after the version query, before the run
      return info;
    };
    const { call, judged } = broker(provider);
    expect(await call()).toMatchObject({ status: "ok", attempts: 1 });
    expect(judged.map((j) => j.version)).toEqual(["2.1.3"]);
    expect([a.modelCalls(), b.modelCalls()]).toEqual([1, 0]);
  });

  it("finds the path again for each attempt and judges that executable", async () => {
    a.configure({ version: "2.1.3", mode: "fail-echo" }); // exits non-zero: retryable
    const env: Record<string, string> = { PATH: a.bin };
    const provider = createClaudeCodeProvider({ env });
    const paths = [a.bin, b.bin];
    const detect = provider.detect.bind(provider);
    provider.detect = async () => {
      env.PATH = paths.shift() ?? b.bin;
      return detect();
    };
    const { call, judged } = broker(provider);
    expect(await call()).toMatchObject({ status: "ok", attempts: 2 });
    expect(judged.map((j) => j.version)).toEqual(["2.1.3", "2.1.4"]);
    expect([a.modelCalls(), b.modelCalls()]).toEqual([1, 1]);
  });
});
