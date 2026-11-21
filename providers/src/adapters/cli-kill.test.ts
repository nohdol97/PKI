// V01-C4 `cli-kill` (V01-R9, T07 handoff 5): a fake CLI that ignores SIGTERM and
// leaves a grandchild is ended, the grandchild included, by its signal, by
// cancel(requestId) and by the request's own time limit; a CLI that exits
// leaves no grandchild either, and the run's temporary folder is gone. POSIX
// (the development OS); the Windows path (`taskkill /T /F`) is unverified (A04).
import { ProviderError, type StructuredRequest } from "@pki/contracts";
import { installFakeCli, processAlive, structuredRequest, type FakeCli } from "@pki/testkit";
import { existsSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLI_PROFILES } from "../cli-profiles.ts";
import { createClaudeCodeProvider, createCodexProvider } from "./cli-provider.ts";

// every fake CLI run is a Node start: slow when the whole suite runs in parallel
vi.setConfig({ testTimeout: 30_000 });

const fake: FakeCli = installFakeCli();
afterAll(() => fake.dispose());
beforeEach(() => {
  fake.reset();
  fake.configure({});
});

const PROVIDERS = [
  { id: "claude-code", create: createClaudeCodeProvider },
  { id: "codex", create: createCodexProvider },
] as const;

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Every process the fake left, gone (the reaper may take a moment). */
async function treeGone(): Promise<void> {
  const pids = fake.spawned().flatMap((s) => [s.child, s.grandchild]);
  expect(pids.length).toBeGreaterThanOrEqual(2);
  await until(() => pids.every((pid) => !processAlive(pid)));
}

const failure = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

describe.skipIf(process.platform === "win32").each(PROVIDERS)("cli-kill: $id", ({ id, create }) => {
  const provider = () => create({ env: { PATH: fake.bin }, killGraceMs: 200 });
  const request = (requestId: string, timeoutMs = 60_000): StructuredRequest => ({
    ...structuredRequest(requestId),
    budget: { timeoutMs },
    execution: { profile: CLI_PROFILES[id].standard, isolation: "verified" },
  });

  it("ends the whole tree when the signal aborts, though the CLI ignores SIGTERM", async () => {
    fake.configure({ mode: "stubborn" });
    const controller = new AbortController();
    const call = failure(provider().generateStructured(request("abort:1"), controller.signal));
    await until(() => fake.spawned().length === 1);
    controller.abort();
    expect(await call).toBeInstanceOf(ProviderError);
    await treeGone();
  });

  it("ends the whole tree on cancel(requestId) and waits for it", async () => {
    fake.configure({ mode: "stubborn" });
    const p = provider();
    const call = failure(p.generateStructured(request("cancel:1"), new AbortController().signal));
    await until(() => fake.spawned().length === 1);
    await p.cancel("other:1"); // another request's ID stops nothing
    expect(fake.spawned().every((s) => processAlive(s.child))).toBe(true);
    await p.cancel("cancel:1");
    expect(await call).toBeInstanceOf(ProviderError);
    await treeGone();
  });

  it("ends the whole tree at the request's time limit, as a retryable failure", async () => {
    fake.configure({ mode: "stubborn" });
    const error = await failure(
      provider().generateStructured(request("slow:1", 5_000), new AbortController().signal),
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).retryable).toBe(true);
    await treeGone();
  });

  it("leaves no grandchild of a CLI that answered, and removes the run's folder", async () => {
    fake.configure({ leaveGrandchild: true });
    await provider().generateStructured(request("ok:1"), new AbortController().signal);
    await treeGone();
    const cwd = fake.runs().find((r) => r.kind === "model")?.cwd;
    expect(cwd && existsSync(cwd)).toBe(false);
  });

  it("ends a hung version query itself, reporting no version", async () => {
    fake.configure({ versionMode: "hang" }); // long enough for the fake to start and record itself
    const started = Date.now();
    const info = await create({
      env: { PATH: fake.bin },
      versionTimeoutMs: 1_500,
      killGraceMs: 200,
    }).detect();
    expect(info).toEqual({ installed: true, path: fake.path(id === "codex" ? "codex" : "claude") });
    expect(Date.now() - started).toBeLessThan(4_000);
    await treeGone();
  });

  it("stops a call cancelled before its process started", async () => {
    const p = provider();
    const call = failure(p.generateStructured(request("early:1"), new AbortController().signal));
    await p.cancel("early:1");
    expect(await call).toBeInstanceOf(ProviderError);
    expect(fake.modelCalls()).toBe(0);
  });
});
