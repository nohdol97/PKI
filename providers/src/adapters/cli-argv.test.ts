import { tmpdir } from "node:os";
// V01-C4 `cli-argv` (V01-R9): the argument arrays are the code's fixed profiles,
// equal to their R02 profile but for the model, and carry the no-session option;
// the CLI runs with exactly them, chosen by `request.execution.profile` alone. The
// two queries that need no decision run fixed arguments with no input. The fake
// CLI rejects an option left without its value, as the real CLIs do.
import { ProviderError, type LLMProvider, type StructuredRequest } from "@pki/contracts";
import { installFakeCli, structuredRequest, type FakeCli } from "@pki/testkit";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { relative, resolve, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLI_ARGUMENTS, CLI_PROFILES } from "../cli-profiles.ts";
import { childEnvironment, createClaudeCodeProvider, createCodexProvider } from "./cli-provider.ts";
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

const R02 = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../../../verification/r02-cli-isolation/profiles.json"),
    "utf8",
  ),
) as { profiles: { name: string; argv: string[] }[] };

/** An R02 argv without the executable; `withModel: false` also drops the model pair. */
function r02Arguments(name: string, withModel: boolean): string[] {
  const argv = R02.profiles.find((p) => p.name === name)?.argv;
  if (!argv) throw new Error(`no R02 profile ${name}`);
  const rest = argv.slice(1);
  if (withModel) return rest;
  const model = rest.findIndex((t) => t === "--model" || t === "-m");
  if (model >= 0) rest.splice(model, 2);
  return rest;
}

const fake: FakeCli = installFakeCli();
afterAll(() => fake.dispose());
// leak check: no run of this file leaves a process behind
afterEach(async () => expect(await fake.leftovers()).toEqual([]));
beforeEach(() => {
  fake.configure({});
  fake.reset();
});

const PROVIDERS = [
  { id: "claude-code", cmd: "claude", create: claudeProvider },
  { id: "codex", cmd: "codex", create: codexProvider },
] as const;

const live = () => new AbortController().signal;
/** A fake CLI is a Node start; the suite's 1 s budget is too short on a loaded machine. */
const slow = (): StructuredRequest => ({ ...structuredRequest(), budget: { timeoutMs: 30_000 } });
const MODEL = "synthetic-model";
/** A standard profile runs the listed model; a minimal one runs none. */
const run = (profile: string, isolation: "verified" | "unverified" = "verified") =>
  ({
    ...slow(),
    execution: { profile, isolation, ...(profile.includes("/standard-") ? { model: MODEL } : {}) },
  }) as StructuredRequest;
const error = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

describe("cli-argv: the fixed profiles", () => {
  it("names exactly the four profiles: standard as its R02 profile, minimal without the model", () => {
    expect(Object.keys(CLI_ARGUMENTS).sort()).toEqual(
      Object.values(CLI_PROFILES)
        .flatMap((p) => [p.standard, p.minimal])
        .sort(),
    );
    for (const [name, profile] of Object.entries(CLI_ARGUMENTS)) {
      const standard = name.includes("/standard-");
      expect(profile.args, name).toEqual(r02Arguments(profile.r02.profile, standard));
      expect(profile.args.includes("{model}"), name).toBe(standard);
      expect(profile.r02.differences.length > 0, name).toBe(!standard);
      expect(Object.isFrozen(profile.args), name).toBe(true);
    }
    expect(CLI_PROFILES["claude-code"].standard).toBe("claude-code/standard-2");
    expect(CLI_PROFILES.codex.standard).toBe("codex/standard-2");
    expect(CLI_ARGUMENTS["claude-code/standard-2"].r02.profile).toBe("claude-A-restricted-safe");
    expect(CLI_ARGUMENTS["codex/standard-2"].r02.profile).toBe("codex-A-full");
  });

  it("keeps no session on disk", () => {
    for (const name of ["claude-code/standard-2", "claude-code/minimal-1"] as const) {
      expect(CLI_ARGUMENTS[name].args).toContain("--no-session-persistence");
    }
    for (const name of ["codex/standard-2", "codex/minimal-1"] as const) {
      expect(CLI_ARGUMENTS[name].args).toContain("--ephemeral");
    }
  });
});

describe.each(PROVIDERS)("cli-argv: $id runs", ({ id, cmd, create }) => {
  const provider = (): LLMProvider => create({ env: { PATH: fake.bin } });
  const profiles = CLI_PROFILES[id];

  it("the named profile's arguments exactly, with the placeholders filled for this run", async () => {
    const request = run(profiles.standard);
    await provider().generateStructured(request, live());
    const model = fake.runs().filter((r) => r.kind === "model");
    expect(model).toHaveLength(1);
    const [ran] = model;
    if (!ran) throw new Error("no model run");
    const schemaJson = JSON.stringify(request.outputSchema);
    const expected = CLI_ARGUMENTS[profiles.standard].args.map((a) =>
      a
        .replace("{schema_json}", schemaJson)
        .replace("{model}", MODEL)
        .replace("{cwd}", ran.cwd)
        .replace("{schema_file}", resolve(ran.cwd, "../schema.json"))
        .replace("{result_file}", resolve(ran.cwd, "../result.json")),
    );
    expect(ran.args).toEqual(expected);
    expect(ran.args.join(" ")).not.toMatch(/\{(schema_json|schema_file|result_file|cwd)\}/);
    expect(ran.stdinBytes).toBeGreaterThan(0);
  });

  it("the listed model with the standard profile, in R02's flag", async () => {
    await provider().generateStructured(run(profiles.standard), live());
    const args = fake.runs().find((r) => r.kind === "model")?.args ?? [];
    const flag = id === "codex" ? "-m" : "--model";
    expect(args[args.indexOf(flag) + 1]).toBe(MODEL);
  });

  it("the minimal profile for an unverified call, with the CLI's default model", async () => {
    await provider().generateStructured(run(profiles.minimal, "unverified"), live());
    const ran = fake.runs().filter((r) => r.kind === "model");
    expect(ran).toHaveLength(1);
    expect(ran[0]?.args).not.toContain("--model");
    expect(ran[0]?.args).not.toContain("-m");
    expect(ran[0]?.args[0]).toBe(CLI_ARGUMENTS[profiles.minimal].args[0]);
  });

  it.each([
    ["no execution", slow()],
    ["no isolation", { ...slow(), execution: { profile: profiles.standard } }],
    ["no profile", { ...slow(), execution: { isolation: "verified" } }],
    ["an unknown profile", run(`${id}/standard-999`)],
    [
      "the other CLI's profile",
      run(id === "codex" ? "claude-code/standard-2" : "codex/standard-2"),
    ],
    ["an inherited name", run("constructor")],
    ["a retired profile", run(`${id}/standard-1`)],
    [
      "a standard profile without its model",
      { ...slow(), execution: { profile: profiles.standard, isolation: "verified" } },
    ],
    [
      "a model read as an option",
      {
        ...slow(),
        execution: { profile: profiles.standard, isolation: "verified", model: "--yolo" },
      },
    ],
  ])("nothing with %s", async (_, request) => {
    const failure = await error(
      provider().generateStructured(request as StructuredRequest, live()),
    );
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).retryable).toBe(false);
    expect(fake.runs()).toEqual([]);
  });

  it("the version query with `--version` only and no input", async () => {
    const info = await provider().detect();
    expect(info).toEqual({ installed: true, path: fake.path(cmd), version: "2.1.3" });
    expect(fake.runs().map((r) => [r.kind, r.args, r.stdinBytes])).toEqual([
      ["version", ["--version"], 0],
    ]);
  });

  it("the login status query with fixed arguments and no input, or nothing at all", async () => {
    fake.configure({ auth: "logged-in" });
    const auth = await provider().checkAuthentication();
    if (id === "codex") {
      expect(auth).toBe("authenticated");
      expect(fake.runs().map((r) => [r.kind, r.args, r.stdinBytes])).toEqual([
        ["auth", ["login", "status"], 0],
      ]);
      fake.configure({ auth: "logged-out" });
      expect(await provider().checkAuthentication()).toBe("unauthenticated");
    } else {
      // Claude Code documents no status command: "unknown", and nothing runs
      expect(auth).toBe("unknown");
      expect(fake.runs()).toEqual([]);
    }
  });
});

describe("cli-argv: the version string", () => {
  it.each([
    ["2.1.3 (Claude Code)", "2.1.3"],
    ["codex-cli 0.155.1", "0.155.1"],
    // R02's pattern takes one suffix: the build part is dropped, as R02 records it
    ["v1.0.0-beta.2+build.5", "1.0.0-beta.2"],
  ])("normalizes %j to %j as R02 does", async (versionOutput, version) => {
    fake.configure({ versionOutput });
    expect((await codexProvider({ env: { PATH: fake.bin } }).detect()).version).toBe(version);
  });

  it("is absent when the output has none or the query fails", async () => {
    fake.configure({ versionOutput: "no version here" });
    expect(await codexProvider({ env: { PATH: fake.bin } }).detect()).toEqual({
      installed: true,
      path: fake.path("codex"),
    });
    fake.configure({ versionMode: "fail" });
    expect(await codexProvider({ env: { PATH: fake.bin } }).detect()).toEqual({
      installed: true,
      path: fake.path("codex"),
    });
  });

  it("reports a CLI that is not on PATH as not installed, running nothing", async () => {
    const provider = claudeProvider({ env: { PATH: resolve(fake.bin, "../state") } });
    expect(await provider.detect()).toEqual({ installed: false });
    expect(await provider.checkHealth()).toEqual({ state: "unavailable", reason: "not-installed" });
  });
});

describe("cli-argv: the child's environment", () => {
  it("holds allowlisted names and the profile's settings, never credentials", async () => {
    const env = {
      PATH: fake.bin,
      HOME: "/home/synthetic",
      ANTHROPIC_API_KEY: "sk-synthetic",
      OPENAI_API_KEY: "sk-synthetic",
      CODEX_API_KEY: "synthetic",
      CLAUDE_CODE_OAUTH_TOKEN: "synthetic",
      SOME_OTHER: "x",
    };
    await claudeProvider({ env }).generateStructured(
      run(CLI_PROFILES["claude-code"].standard),
      live(),
    );
    const ran = fake.runs().find((r) => r.kind === "model");
    expect(ran?.envNames).toContain("HOME");
    for (const name of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "SOME_OTHER",
    ]) {
      expect(ran?.envNames).not.toContain(name);
    }
    expect(ran?.env).toMatchObject({
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    });
  });
});

describe("cli-argv: the fake CLI parses like a real one", () => {
  it.each([
    ["claude", ["-p", "--tools"]],
    ["claude", ["-p", "--max-turns", "--output-format", "json"]],
    ["claude", ["-p", "--json-schema", ""]],
    ["claude", ["-p", "--no-such-flag"]],
    ["codex", ["exec", "-C"]],
    ["codex", ["exec", "--output-schema", "-o", "x"]],
  ])("%s rejects %j", (cmd, args) => {
    const result = spawnSync(fake.path(cmd as "claude" | "codex"), args, { input: "" });
    expect(result.status).toBe(2);
    expect(fake.modelCalls()).toBe(0);
  });

  it('accepts the empty value R02 allows (`--tools ""`)', () => {
    const result = spawnSync(fake.path("claude"), ["-p", "--tools", ""], { input: "" });
    expect(result.status).toBe(0);
  });
});

describe("cli-argv: what counts as found and as a version", () => {
  it("skips a relative PATH entry (a PATH hijack through the working folder)", async () => {
    const empty = resolve(fake.bin, "../state");
    const provider = claudeProvider({
      env: { PATH: [relative(process.cwd(), fake.bin), empty].join(":") },
    });
    expect(await provider.detect()).toEqual({ installed: false });
    expect(fake.runs()).toEqual([]);
  });

  it("takes a version only from a query that exits 0", async () => {
    fake.configure({ versionMode: "print-and-fail" });
    expect(await codexProvider({ env: { PATH: fake.bin } }).detect()).toEqual({
      installed: true,
      path: fake.path("codex"),
    });
  });
});

describe("cli-argv: no credential reaches the child", () => {
  it("drops credential names from the profile's additions too, as R02's runner does", () => {
    expect(
      childEnvironment(
        { PATH: "/bin", ANTHROPIC_API_KEY: "sk", HOME: "/h" },
        { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1", ANTHROPIC_AUTH_TOKEN: "t", OPENAI_X: "y" },
      ),
    ).toEqual({ PATH: "/bin", HOME: "/h", CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" });
  });
});

describe("cli-argv: a failure carries a code, never the CLI's output", () => {
  it("keeps stderr and stdout out of the error and the log", async () => {
    const marker = `ECHO-${Date.now()}`;
    fake.configure({ mode: "fail-echo", marker });
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => {
      lines.push(a.map(String).join(" "));
    });
    try {
      const error = await codexProvider({ env: { PATH: fake.bin } })
        .generateStructured(run(CLI_PROFILES.codex.standard), live())
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).message).toMatch(/^cli-[a-z-]+$/);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join("\n")).not.toContain(marker);
      expect(lines.join("\n")).not.toContain("Reply with one word");
    } finally {
      spy.mockRestore();
    }
  });
});
