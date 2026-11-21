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

/**
 * A model name as the CLIs take it after `--model` / `-m`: one word that cannot be
 * read as an option (V01-T10). R02 records the model it ran; its verdict holds for
 * that model only, so an entry without one is invalid.
 */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,99}$/;

export function isModelName(model: unknown): model is string {
  return typeof model === "string" && MODEL_NAME.test(model);
}

const PROFILE_NAMES = Object.values(CLI_PROFILES).flatMap((p) => [p.standard, p.minimal]);

const EntrySchema = z.strictObject({
  cli: z.enum(CLI_IDS as [string, ...string[]]),
  version: z.string().refine(isExactVersion),
  os: z.enum(["win32", "darwin", "linux"]),
  profile: z.enum(PROFILE_NAMES as [string, ...string[]]),
  model: z.string().refine(isModelName),
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
