// CLI argument profiles (V01-R9, R10): code constants. The verified list names a
// profile; it never carries arguments. `standard` is what a verified combination
// runs with; `minimal` is the fixed least-privilege profile of the development
// exception. V01-T10 binds the argument arrays to these names; a change to a
// profile's arguments must change its name, so an earlier verification no longer
// matches it.
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
