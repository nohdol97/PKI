// The fake CLI's body (V01-T10): `installFakeCli` (fake-cli.ts) puts a `claude`
// and a `codex` shell wrapper on a test PATH that runs this file with Node as
// `fake-cli-main.ts <state dir> <name> <arguments…>`. It behaves as the CLI Providers
// expect of the real ones, by the mode in `<state dir>/config.json`, and appends
// one line per run to `<state dir>/calls.jsonl` (argument list, cwd, environment
// names, stdin size; never stdin itself). Options are checked against R02's flag
// lists (verification/r02-cli-isolation/profiles.json): a flag that takes a value
// and has none, or a flag it does not know, fails with exit code 2 as a real CLI does.
// Test builds only: it is a test double and never ships.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FakeCliConfig } from "./fake-cli.ts";

const [stateDir = "", name = "", ...args] = process.argv.slice(2);
const config = JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8")) as FakeCliConfig;

if (config.startDelayMs !== undefined) {
  // a slow start: nothing is recorded yet and SIGTERM simply ends the process
  process.once("SIGTERM", () => process.exit(143));
  await new Promise((resolve) => setTimeout(resolve, config.startDelayMs));
  process.removeAllListeners("SIGTERM");
}

const flags = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../../../verification/r02-cli-isolation/profiles.json"),
    "utf8",
  ),
) as {
  value_flags: Record<string, string[]>;
  valueless_flags: string[];
  empty_value_ok: string[];
};
const VALUE_FLAGS = new Set(flags.value_flags[name === "claude" ? "claude" : "codex"]);
const VALUELESS = new Set(flags.valueless_flags);
const EMPTY_OK = new Set(flags.empty_value_ok);

function record(kind: string, extra: Record<string, unknown> = {}) {
  appendFileSync(
    join(stateDir, "calls.jsonl"),
    `${JSON.stringify({
      kind,
      name,
      args,
      cwd: process.cwd(),
      envNames: Object.keys(process.env).sort(),
      env: Object.fromEntries(
        Object.entries(process.env).filter(([k]) => k.startsWith("CLAUDE_CODE_")),
      ),
      pid: process.pid,
      ...extra,
    })}\n`,
  );
}

const hang = () => setInterval(() => undefined, 1_000);

/** A grandchild that ignores SIGTERM; unref'd, so this process can still exit. */
function leaveGrandchild(): number | undefined {
  // the state dir as an argument: the leak check kills only processes that name it
  const grandchild = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);", stateDir],
    { stdio: "ignore" },
  );
  grandchild.unref();
  return grandchild.pid;
}

function stubborn(): void {
  // ignores SIGTERM and leaves a grandchild that ignores it too
  process.on("SIGTERM", () => undefined);
  const grandchild = leaveGrandchild();
  appendFileSync(
    join(stateDir, "pids.jsonl"),
    `${JSON.stringify({ child: process.pid, grandchild })}\n`,
  );
  hang();
}

/** Validates options as the real CLI would; returns the value of each flag seen. */
function parseOptions(rest: readonly string[]): Map<string, string> | undefined {
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] ?? "";
    if (VALUE_FLAGS.has(token)) {
      const value = rest[i + 1];
      // a value that looks like the next option is missing, as a real parser reads it
      const missing =
        value === undefined ||
        (value === "" && !EMPTY_OK.has(token)) ||
        (value.length > 1 && value.startsWith("-"));
      if (missing) return undefined;
      values.set(token, value);
      i++;
    } else if (VALUELESS.has(token)) {
      values.set(token, "");
    } else {
      return undefined; // an unknown flag or a stray argument
    }
  }
  return values;
}

/** A value of the schema's shape: each required property's type. */
function sample(schema: unknown): unknown {
  const s = schema as { required?: string[]; properties?: Record<string, { type?: string }> };
  return Object.fromEntries(
    (s.required ?? []).map((key) => {
      const type = s.properties?.[key]?.type;
      return [key, type === "array" ? [] : type === "object" ? {} : "ok"];
    }),
  );
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function model(): Promise<void> {
  const head = name === "claude" ? "-p" : "exec";
  const options = args[0] === head ? parseOptions(args.slice(1)) : undefined;
  if (!options) {
    record("rejected");
    process.stderr.write("error: invalid arguments\n");
    process.exit(2);
  }
  const stdin = await readStdin();
  record("model", { stdinBytes: Buffer.byteLength(stdin) });
  switch (config.mode) {
    case "hang":
      return void hang();
    case "stubborn":
      return stubborn();
    case "flood": {
      const out = config.floodStream === "stderr" ? process.stderr : process.stdout;
      out.write("x".repeat(2 * 1024 * 1024));
      return stubborn();
    }
    case "fail-echo":
      process.stderr.write(`${config.marker ?? "ECHO"} ${stdin}\n`);
      process.stdout.write(`${config.marker ?? "ECHO"} ${stdin}\n`);
      process.exit(1);
      return;
    case "garbage":
      process.stdout.write("this is not json\n");
      return;
    default:
      break;
  }
  if (config.leaveGrandchild) {
    const grandchild = leaveGrandchild();
    appendFileSync(
      join(stateDir, "pids.jsonl"),
      `${JSON.stringify({ child: process.pid, grandchild })}\n`,
    );
  }
  if (name === "claude") {
    const schema = options.get("--json-schema");
    const out = schema === undefined ? undefined : (config.output ?? sample(JSON.parse(schema)));
    process.stdout.write(
      `${JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "fake reply",
        ...(out === undefined ? {} : { structured_output: out }),
      })}\n`,
    );
    return;
  }
  const schemaFile = options.get("--output-schema");
  const resultFile = options.get("-o") ?? options.get("--output-last-message");
  const out =
    schemaFile === undefined
      ? "fake reply"
      : JSON.stringify(config.output ?? sample(JSON.parse(readFileSync(schemaFile, "utf8"))));
  if (resultFile) writeFileSync(resultFile, out);
  process.stdout.write(`${JSON.stringify({ type: "thread.started" })}\n`);
}

if (args.length === 1 && args[0] === "--version") {
  record("version", { stdinBytes: Buffer.byteLength(await readStdin()) });
  switch (config.versionMode) {
    case "hang":
      stubborn();
      break;
    case "fail":
      process.exit(1);
      break;
    case "print-and-fail":
      process.stdout.write(`${config.version} (Claude Code)\n`);
      process.exitCode = 1;
      break;
    default:
      process.stdout.write(
        `${config.versionOutput ?? (name === "claude" ? `${config.version} (Claude Code)` : `codex-cli ${config.version}`)}\n`,
      );
  }
} else if (name === "codex" && args[0] === "login" && args[1] === "status" && args.length === 2) {
  record("auth", { stdinBytes: Buffer.byteLength(await readStdin()) });
  if (config.auth === "logged-in") process.stdout.write("Logged in using ChatGPT\n");
  else {
    process.stderr.write("Not logged in\n");
    process.exitCode = 1;
  }
} else {
  await model();
}
