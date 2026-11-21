// Verified CLI combinations (V01-R10, ARCHITECTURE 3.1): a read-only build
// resource, verified-cli-combinations.json, empty in the public repository. A
// deployment fork fills it after running R02 (S07) and builds again. It is
// parsed and frozen once when the module loads; an invalid file stops the
// backend from starting. No setting, environment variable, data-folder file or
// API reads into it.
import { z } from "zod";
import { CLI_IDS, CLI_PROFILES } from "./cli-profiles.ts";
import resource from "./verified-cli-combinations.json" with { type: "json" };

/** One exact version (semver core with optional pre-release and build), never a range. */
const EXACT_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function isExactVersion(version: string | undefined): version is string {
  return typeof version === "string" && EXACT_VERSION.test(version);
}

const PROFILE_NAMES = Object.values(CLI_PROFILES).flatMap((p) => [p.standard, p.minimal]);

const EntrySchema = z.strictObject({
  cli: z.enum(CLI_IDS as [string, ...string[]]),
  version: z.string().refine(isExactVersion),
  os: z.enum(["win32", "darwin", "linux"]),
  profile: z.enum(PROFILE_NAMES as [string, ...string[]]),
  verifiedOn: z.iso.date(),
});
export type VerifiedCombination = Readonly<z.infer<typeof EntrySchema>>;

/** Parses a list into frozen copies; throws on anything that is not a valid entry. */
export function parseVerifiedList(raw: unknown): readonly VerifiedCombination[] {
  return Object.freeze(
    z
      .array(EntrySchema)
      .parse(raw)
      .map((e) => Object.freeze(e)),
  );
}

export const VERIFIED_CLI_COMBINATIONS = parseVerifiedList(resource);
