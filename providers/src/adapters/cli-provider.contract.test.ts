import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
// V01-C4 `provider.contract` for the two CLI Providers (V01-R9, T07 handoff 2·5):
// the same suite as the fake Provider, against the fake CLI on a test PATH. Every
// request carries the execution profile the Broker would add; the model-call count
// is the fake CLI's, and the failing Provider's CLI exits non-zero. The time limit
// is the CLI's own (cli-kill covers it), so the suite's 1 s budget is raised.
import type { LLMRequest } from "@pki/contracts";
import { installFakeCli, providerContract } from "@pki/testkit";
import { afterAll, afterEach, expect, vi } from "vitest";
import { CLI_PROFILES } from "../cli-profiles.ts";
import { createClaudeCodeProvider, createCodexProvider } from "./cli-provider.ts";
import type { CliProviderOptions } from "./cli-provider.ts";

/** This file's run root: every run's folder is made here and must be gone after it. */
const runs = mkdtempSync(join(tmpdir(), "pki-cli-runs-test-"));
const claudeProvider = (options: CliProviderOptions) =>
  createClaudeCodeProvider({ runsRoot: runs, ...options });
const codexProvider = (options: CliProviderOptions) =>
  createCodexProvider({ runsRoot: runs, ...options });
afterEach(() => expect(readdirSync(runs)).toEqual([]));
afterAll(() => rmSync(runs, { recursive: true, force: true }));
// every fake CLI run is a Node start: slow when the whole suite runs in parallel
vi.setConfig({ testTimeout: 30_000 });

const answering = installFakeCli();
const failing = installFakeCli({ mode: "fail-echo" });
afterEach(async () => {
  expect(await answering.leftovers()).toEqual([]);
  expect(await failing.leftovers()).toEqual([]);
});
afterAll(() => {
  answering.dispose();
  failing.dispose();
});

for (const [id, cmd, create] of [
  ["claude-code", "claude", claudeProvider],
  ["codex", "codex", codexProvider],
] as const) {
  providerContract(id, () => create({ env: { PATH: answering.bin } }), {
    modelCalls: () => answering.modelCalls(cmd),
    failing: () => create({ env: { PATH: failing.bin } }),
    prepare: <R extends LLMRequest>(request: R): R => ({
      ...request,
      budget: { timeoutMs: 30_000 }, // a fake CLI is a Node start: slow on a loaded machine
      execution: {
        profile: CLI_PROFILES[id].standard,
        isolation: "verified",
        model: "synthetic-model",
      },
    }),
  });
}
