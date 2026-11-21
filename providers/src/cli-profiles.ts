// CLI argument profiles (V01-R9, R10): code constants. The verified list names a
// profile; it never carries arguments. `standard` is what a verified combination
// runs with; `minimal` is the fixed least-privilege profile of the development
// exception. A change to a profile's arguments must change its name (the trailing
// number), so an earlier verification no longer matches it.
//
// Each profile records the R02 profile (verification/r02-cli-isolation/profiles.json)
// with the same arguments, and how it differs: a deployment fork runs that R02
// profile and lists this product profile's name with the result (site-setup S07).
// Provisional (V01-T10): all four equal the narrowest R02 draft without R02's
// `--model` pair (the product has no CLI model setting; the CLI's default model
// runs), and `minimal` equals `standard` because that draft is already the least
// privilege. The `cli-argv` test compares them with profiles.json.
export const CLI_PROFILES = Object.freeze({
  "claude-code": Object.freeze({
    standard: "claude-code/standard-1",
    minimal: "claude-code/minimal-1",
  }),
  codex: Object.freeze({ standard: "codex/standard-1", minimal: "codex/minimal-1" }),
});

export type CliId = keyof typeof CLI_PROFILES;

export const CLI_IDS = Object.freeze(Object.keys(CLI_PROFILES) as CliId[]);

export function cliProfiles(id: string): (typeof CLI_PROFILES)[CliId] | undefined {
  return Object.hasOwn(CLI_PROFILES, id) ? CLI_PROFILES[id as CliId] : undefined;
}

/** What the Provider fills in for each run; nothing else in an argument varies. */
export const PLACEHOLDERS = ["{schema_json}", "{schema_file}", "{result_file}", "{cwd}"] as const;

export interface CliArguments {
  readonly cli: CliId;
  /** The arguments after the executable, placeholders unfilled. */
  readonly args: readonly string[];
  /** The flag carrying the output schema; dropped with its value for plain text output. */
  readonly schemaFlag: string;
  /** Variables the child gets on top of the minimal environment (R02 `env_set`). */
  readonly env: Readonly<Record<string, string>>;
  readonly r02: { readonly profile: string; readonly differences: readonly string[] };
}

const NO_MODEL = "R02 `--model {model}` omitted: the CLI's default model runs (no product setting)";

const CLAUDE_ARGS = Object.freeze([
  "-p",
  "--restricted",
  "--safe-mode",
  "--tools",
  "",
  "--disallowedTools",
  "*",
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--disable-slash-commands",
  "--settings",
  '{"disableAllHooks":true}',
  "--permission-mode",
  "dontAsk",
  "--permission-prompts",
  "none",
  "--no-session-persistence",
  "--max-turns",
  "2",
  "--output-format",
  "json",
  "--json-schema",
  "{schema_json}",
]);

const CODEX_ARGS = Object.freeze([
  "exec",
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "--skip-git-repo-check",
  "--sandbox",
  "read-only",
  "-C",
  "{cwd}",
  "-c",
  'web_search="disabled"',
  "-c",
  "features.shell_tool=false",
  "-c",
  "features.hooks=false",
  "-c",
  "features.memories=false",
  "-c",
  "project_doc_max_bytes=0",
  "-c",
  'shell_environment_policy.inherit="none"',
  "-c",
  'history.persistence="none"',
  "--output-schema",
  "{schema_file}",
  "-o",
  "{result_file}",
  "--json",
  "-",
]);

const claude = (): CliArguments =>
  Object.freeze({
    cli: "claude-code",
    args: CLAUDE_ARGS,
    schemaFlag: "--json-schema",
    env: Object.freeze({
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    }),
    r02: Object.freeze({
      profile: "claude-A-restricted-safe",
      differences: Object.freeze([NO_MODEL]),
    }),
  });

const codex = (): CliArguments =>
  Object.freeze({
    cli: "codex",
    args: CODEX_ARGS,
    schemaFlag: "--output-schema",
    env: Object.freeze({}),
    r02: Object.freeze({
      profile: "codex-A-full",
      differences: Object.freeze([NO_MODEL.replace("--model", "-m")]),
    }),
  });

type Values<T> = T[keyof T];
export type CliProfileName = Values<{ [Id in CliId]: Values<(typeof CLI_PROFILES)[Id]> }>;

export const CLI_ARGUMENTS: Readonly<Record<CliProfileName, CliArguments>> = Object.freeze({
  [CLI_PROFILES["claude-code"].standard]: claude(),
  [CLI_PROFILES["claude-code"].minimal]: claude(),
  [CLI_PROFILES.codex.standard]: codex(),
  [CLI_PROFILES.codex.minimal]: codex(),
});

/** The arguments of `profile` for `cli`; undefined for any other name (inherited ones included). */
export function cliArguments(cli: CliId, profile: unknown): CliArguments | undefined {
  if (typeof profile !== "string" || !Object.hasOwn(CLI_ARGUMENTS, profile)) return undefined;
  const found = CLI_ARGUMENTS[profile as CliProfileName];
  return found.cli === cli ? found : undefined;
}

/**
 * The arguments for one run: placeholders filled, and for plain text output the
 * schema flag dropped with its value. Fills whole arguments only.
 */
export function renderArguments(
  profile: CliArguments,
  values: Readonly<Record<(typeof PLACEHOLDERS)[number], string>>,
  output: "structured" | "text",
): string[] {
  const out: string[] = [];
  for (let i = 0; i < profile.args.length; i++) {
    const arg = profile.args[i] ?? "";
    if (output === "text" && arg === profile.schemaFlag) {
      i++;
      continue;
    }
    out.push(Object.hasOwn(values, arg) ? ((values as Record<string, string>)[arg] ?? "") : arg);
  }
  return out;
}
