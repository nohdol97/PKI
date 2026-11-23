// V01-C4 `cli-kill` (V01-R9, T07 handoff 5): a fake CLI that ignores SIGTERM and
// leaves a grandchild is ended, the grandchild included, by its signal, by
// cancel(requestId) and by the request's own time limit; a CLI that exits
// leaves no grandchild either, and the run's temporary folder is gone. POSIX
// (the development OS); the Windows path (`taskkill /T /F`) is unverified (A04).
import { ProviderError, type StructuredRequest } from "@pki/contracts";
import { installFakeCli, processAlive, structuredRequest, type FakeCli } from "@pki/testkit";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLI_PROFILES } from "../cli-profiles.ts";
import {
  checkRunsRoot,
  createClaudeCodeProvider,
  createCodexProvider,
  sweepStaleCliRuns,
} from "./cli-provider.ts";

// every fake CLI run is a Node start: slow when the whole suite runs in parallel
vi.setConfig({ testTimeout: 30_000 });

const fake: FakeCli = installFakeCli();
/** This file's run root: every run's folder is made here and must be gone after it. */
const runs = mkdtempSync(join(tmpdir(), "pki-cli-runs-kill-"));
afterAll(() => {
  fake.dispose();
  rmSync(runs, { recursive: true, force: true });
});
// leak check: every test ends its trees and folders; whatever one leaves fails it
afterEach(async () => {
  expect(await fake.leftovers()).toEqual([]);
  expect(readdirSync(runs)).toEqual([]);
});
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

/** A version query's limits, tried in turn (the first is the usual one); the sum stays inside the test limit. */
const VERSION_LADDER_MS = [1_500, 5_000, 15_000];
/** What the query may take beyond its limit: the kill grace and the reaper. */
const VERSION_SLACK_MS = 2_500;

/**
 * A hung version query ends itself within its limit and takes the fake's whole tree with it. The fake can start
 * so late that the limit is up before it recorded its PID: that attempt proves nothing either way (the CLI was
 * not there to end), so it is not a failure and the next, longer limit is tried. Only an attempt with a record is
 * judged. Returns the limit it was judged on; fails, loudly, when no attempt ever recorded.
 */
async function versionQueryEndsItself(
  id: (typeof PROVIDERS)[number]["id"],
  create: (typeof PROVIDERS)[number]["create"],
  ladder: readonly number[] = VERSION_LADDER_MS,
): Promise<number> {
  for (const limit of ladder) {
    fake.reset();
    const started = Date.now();
    const info = await create({
      env: { PATH: fake.bin },
      versionTimeoutMs: limit,
      killGraceMs: 200,
    }).detect();
    expect(info).toEqual({ installed: true, path: fake.path(id === "codex" ? "codex" : "claude") });
    const elapsed = Date.now() - started;
    if (fake.spawned().length === 0) continue; // undecided: the fake never got to record itself
    expect(elapsed).toBeLessThan(limit + VERSION_SLACK_MS);
    await treeGone();
    return limit;
  }
  throw new Error(`the fake CLI never recorded itself within any limit of ${ladder.join(", ")} ms`);
}

describe.skipIf(process.platform === "win32").each(PROVIDERS)("cli-kill: $id", ({ id, create }) => {
  const provider = () => create({ env: { PATH: fake.bin }, killGraceMs: 200, runsRoot: runs });
  const request = (requestId: string, timeoutMs = 60_000): StructuredRequest => ({
    ...structuredRequest(requestId),
    budget: { timeoutMs },
    execution: {
      profile: CLI_PROFILES[id].standard,
      isolation: "verified",
      model: "synthetic-model",
    },
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
    await versionQueryEndsItself(id, create);
  });

  it.each(["stdout", "stderr"] as const)(
    "ends the tree of a CLI that floods %s past 1 MiB, as a failure not to retry",
    async (stream) => {
      fake.configure({ mode: "flood", floodStream: stream });
      const error = await failure(
        provider().generateStructured(
          request(`flood-${stream}:1`, 20_000),
          new AbortController().signal,
        ),
      );
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).message).toBe("cli-output-too-large");
      expect((error as ProviderError).retryable).toBe(false);
      await treeGone();
    },
  );

  it("ends every running tree on close (backend shutdown) and refuses new calls", async () => {
    fake.configure({ mode: "stubborn" });
    const p = provider();
    const calls = [
      failure(p.generateStructured(request("close:1"), new AbortController().signal)),
      failure(p.generateStructured(request("close:2"), new AbortController().signal)),
    ];
    await until(() => fake.spawned().length === 2);
    await p.close?.();
    for (const error of await Promise.all(calls)) expect(error).toBeInstanceOf(ProviderError);
    await treeGone();
    expect(fake.spawned().flatMap((s) => [s.child, s.grandchild])).toHaveLength(4);
    const late = await failure(
      p.generateStructured(request("close:3"), new AbortController().signal),
    );
    expect(late).toBeInstanceOf(ProviderError);
    expect(fake.modelCalls()).toBe(2);
  });

  it("refuses a second call under a request ID still running, leaving the first", async () => {
    fake.configure({ mode: "stubborn" });
    const p = provider();
    const first = failure(p.generateStructured(request("dup:1"), new AbortController().signal));
    await until(() => fake.spawned().length === 1);
    const second = await failure(
      p.generateStructured(request("dup:1"), new AbortController().signal),
    );
    expect((second as ProviderError).message).toBe("cli-duplicate-request");
    expect(fake.spawned().every((s) => processAlive(s.child))).toBe(true);
    await p.cancel("dup:1");
    expect(await first).toBeInstanceOf(ProviderError);
    await treeGone();
  });

  it("ends a version query still running on close, and refuses queries after it", async () => {
    fake.configure({ versionMode: "hang" });
    const p = create({ env: { PATH: fake.bin }, killGraceMs: 200, runsRoot: runs });
    const query = p.detect().catch((e: unknown) => e);
    await until(() => fake.spawned().length === 1);
    await p.close?.();
    await treeGone();
    expect(await query).toMatchObject({ installed: true }); // killed: no version read
    expect(((await query) as { version?: string }).version).toBeUndefined();
    for (const after of [p.detect(), p.checkAuthentication()]) {
      const error = await after.catch((e: unknown) => e);
      expect((error as ProviderError).message).toBe("cli-closed");
    }
    // refused before it looks anything up, so also where no CLI is found
    const empty = create({ env: { PATH: runs }, runsRoot: runs });
    await empty.close?.();
    expect(((await empty.detect().catch((e: unknown) => e)) as ProviderError).message).toBe(
      "cli-closed",
    );
  });

  it("starts no query whose folder was still being made when close came", async () => {
    const p = create({ env: { PATH: fake.bin }, killGraceMs: 200, runsRoot: runs });
    const query = p.detect().catch((e: unknown) => e); // now awaiting its run folder
    await p.close?.();
    expect(((await query) as ProviderError).message).toBe("cli-closed");
    expect(fake.runs()).toEqual([]);
  });

  it("stops a call cancelled before its process started", async () => {
    const p = provider();
    const call = failure(p.generateStructured(request("early:1"), new AbortController().signal));
    await p.cancel("early:1");
    expect(await call).toBeInstanceOf(ProviderError);
    expect(fake.modelCalls()).toBe(0);
  });
});

describe("cli-kill: the version query's judging", () => {
  it("I06F-C10 judges the version query's limit on an attempt the slow-starting fake recorded in, not on one it had not", async () => {
    fake.configure({ versionMode: "hang", startDelayMs: 2_000 }); // later than the first rung of the ladder
    const judged = await versionQueryEndsItself("claude-code", createClaudeCodeProvider);
    expect(judged).toBeGreaterThan(VERSION_LADDER_MS[0] ?? 0); // the first attempt was undecided
  }, 60_000);

  it("I06F-C10 fails by name, not silently, when no attempt of the ladder recorded the fake", async () => {
    fake.configure({ versionMode: "hang", startDelayMs: 5_000 }); // later than every rung below
    const short = [300, 600]; // 0.9 s in all
    await expect(
      versionQueryEndsItself("claude-code", createClaudeCodeProvider, short),
    ).rejects.toThrow("never recorded itself");
  });
});

describe("cli-kill: the run root and the start-up sweep", () => {
  const request = (_cli: "codex", requestId: string): StructuredRequest => ({
    ...structuredRequest(requestId),
    budget: { timeoutMs: 20_000 },
    execution: {
      profile: CLI_PROFILES.codex.standard,
      isolation: "verified",
      model: "synthetic-model",
    },
  });
  const roots: string[] = [];
  const newRoot = () => {
    const root = mkdtempSync(join(tmpdir(), "pki-cli-sweep-")); // 0700, ours
    roots.push(root);
    return root;
  };
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it("sweeps dead backends' run folders only: live ones, other names, files and links stay", async () => {
    const root = newRoot();
    const outside = newRoot();
    writeFileSync(join(outside, "keep.txt"), "x");
    mkdirSync(join(root, "99999999.abc")); // a PID beyond pid_max: never alive
    mkdirSync(join(root, `${process.pid}.xyz`));
    mkdirSync(join(root, "not-a-run"));
    writeFileSync(join(root, "99999998.file"), "a regular file named like a run");
    symlinkSync(outside, join(root, "99999997.link"));
    expect(await sweepStaleCliRuns(root)).toBe(1);
    expect(readdirSync(root).sort()).toEqual(
      [`${process.pid}.xyz`, "not-a-run", "99999998.file", "99999997.link"].sort(),
    );
    expect(readdirSync(outside)).toEqual(["keep.txt"]);
  });

  it("refuses a root that is a symbolic link: sweeps nothing through it, runs nothing in it", async () => {
    const victim = newRoot();
    mkdirSync(join(victim, "99999999.user-folder"));
    writeFileSync(join(victim, "2024.report.docx"), "the user's file");
    const link = join(newRoot(), "cli-runs");
    symlinkSync(victim, link);
    expect(await sweepStaleCliRuns(link)).toBe("refused");
    expect(readdirSync(victim).sort()).toEqual(["2024.report.docx", "99999999.user-folder"]);
    const error = await createCodexProvider({ env: { PATH: fake.bin }, runsRoot: link })
      .generateStructured(request("codex", "root:1"), new AbortController().signal)
      .catch((e: unknown) => e);
    expect((error as ProviderError).message).toBe("cli-runs-root-refused");
    expect(fake.runs()).toEqual([]);
  });

  it("refuses a root open to others or owned by another user", async () => {
    const loose = newRoot();
    chmodSync(loose, 0o755);
    mkdirSync(join(loose, "99999999.abc"));
    expect(await sweepStaleCliRuns(loose)).toBe("refused");
    expect(readdirSync(loose)).toEqual(["99999999.abc"]);
    expect(await checkRunsRoot(loose)).toBe(false);
    const foreign = newRoot();
    mkdirSync(join(foreign, "99999999.abc"));
    expect(await sweepStaleCliRuns(foreign, { uid: (process.getuid?.() ?? 0) + 1 })).toBe(
      "refused",
    );
    expect(readdirSync(foreign)).toEqual(["99999999.abc"]);
  });

  it("refuses a root that is not a directory, though it is ours and private", async () => {
    const file = join(newRoot(), "cli-runs");
    writeFileSync(file, "", { mode: 0o600 });
    expect(await checkRunsRoot(file)).toBe(false);
    expect(await sweepStaleCliRuns(file)).toBe("refused");
  });

  it("makes a missing root 0700 and names each run folder by this process", async () => {
    const root = join(newRoot(), "cli-runs");
    expect(await checkRunsRoot(root, { create: true })).toBe(true);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    await createClaudeCodeProvider({ env: { PATH: fake.bin }, runsRoot: root }).detect();
    expect(readdirSync(root)).toEqual([]); // the query's folder was made there and removed
  });
});
