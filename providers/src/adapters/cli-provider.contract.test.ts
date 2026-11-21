// V01-C4 `provider.contract` for the two CLI Providers (V01-R9, T07 handoff 2·5):
// the same suite as the fake Provider, against the fake CLI on a test PATH. Every
// request carries the execution profile the Broker would add; the model-call count
// is the fake CLI's, and the failing Provider's CLI exits non-zero. The time limit
// is the CLI's own (cli-kill covers it), so the suite's 1 s budget is raised.
import type { LLMRequest } from "@pki/contracts";
import { installFakeCli, providerContract } from "@pki/testkit";
import { afterAll, vi } from "vitest";
import { CLI_PROFILES } from "../cli-profiles.ts";
import { createClaudeCodeProvider, createCodexProvider } from "./cli-provider.ts";

// every fake CLI run is a Node start: slow when the whole suite runs in parallel
vi.setConfig({ testTimeout: 30_000 });

const answering = installFakeCli();
const failing = installFakeCli({ mode: "fail-echo" });
afterAll(() => {
  answering.dispose();
  failing.dispose();
});

for (const [id, cmd, create] of [
  ["claude-code", "claude", createClaudeCodeProvider],
  ["codex", "codex", createCodexProvider],
] as const) {
  providerContract(id, () => create({ env: { PATH: answering.bin } }), {
    modelCalls: () => answering.modelCalls(cmd),
    failing: () => create({ env: { PATH: failing.bin } }),
    prepare: <R extends LLMRequest>(request: R): R => ({
      ...request,
      budget: { timeoutMs: 30_000 }, // a fake CLI is a Node start: slow on a loaded machine
      execution: { profile: CLI_PROFILES[id].standard, isolation: "verified" },
    }),
  });
}
