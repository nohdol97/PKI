// CLI execution conditions (V01-R10, ARCHITECTURE 3.1): the Broker asks `decide`
// before every attempt, after the egress decision. Four inputs decide, and the
// caller sets none of them: the build kind (build-kind.ts), the verified list (a
// build resource), the call kind and the data class (both the Broker's own, from
// its records and the canonical store). The CLI version comes from the
// Provider's fixed-argument version query, the OS from this process.
//
// | build       | combination listed                          | not listed |
// | production  | user: run. background: only with the setting | block all  |
// | development | as production                                | user, all synthetic, not malicious, acknowledged for this one call: run with the minimal profile, marked unverified; else block |
//
// A test build picks "decide as production" or "as development" and may bring
// its own list (its fake CLI's version); without a pick it decides as
// production. Neither option exists outside a test build: there it is ignored.
// Decision code: lint `pki/gate-inputs` keeps environment variables and
// "is this installed" checks out of this file.
import { readSetting, type SqlDriver } from "@pki/storage";
import { platform } from "node:os";
import type { ExecutionDecision, ExecutionGate, ExecutionInput } from "./broker.ts";
import { BUILD_KIND, type BuildKind } from "./build-kind.ts";
import { cliProfiles } from "./cli-profiles.ts";
import {
  parseVerifiedList,
  VERIFIED_CLI_COMBINATIONS,
  type VerifiedCombination,
} from "./verified-cli.ts";

/** Runtime setting (site-setup.md): "on" lets listed CLI combinations run background calls. */
export const CLI_BACKGROUND_SETTING = "providers.cli.background";

/** Off unless the setting is exactly "on" (V01-C7: default off). */
export function readCliBackground(db: SqlDriver): boolean {
  return readSetting(db, CLI_BACKGROUND_SETTING) === "on";
}

/** Honoured in a test build only. */
export interface TestBuildExecution {
  decideAs?: "production" | "development";
  /** The test build's own list resource; parsed like the build's. */
  verified?: unknown;
}

export interface ExecutionGateOptions {
  db: SqlDriver;
  testBuild?: TestBuildExecution;
}

const block = (reason: string): ExecutionDecision => ({ run: false, reason });

/**
 * How a build decides: a test build as it picked (production without a pick) with
 * its own list if it brought one; any other build as itself with the build's list,
 * whatever test options it was handed.
 */
export function decisionBuild(
  build: BuildKind,
  testBuild: TestBuildExecution | undefined,
): { decideAs: "production" | "development"; verified: readonly VerifiedCombination[] } {
  if (build !== "test") return { decideAs: build, verified: VERIFIED_CLI_COMBINATIONS };
  return {
    decideAs: testBuild?.decideAs ?? "production",
    verified:
      testBuild?.verified === undefined
        ? VERIFIED_CLI_COMBINATIONS
        : parseVerifiedList(testBuild.verified),
  };
}

export function createExecutionGate(options: ExecutionGateOptions): ExecutionGate {
  const { decideAs, verified } = decisionBuild(BUILD_KIND, options.testBuild);
  const os = platform();

  return {
    decide(input: ExecutionInput): ExecutionDecision {
      if (input.transport !== "cli") return { run: true };
      const profiles = cliProfiles(input.providerId);
      if (!profiles) return block("cli-unknown");
      // entries hold exact versions only (verified-cli.ts), so an unreadable or
      // unparsable version never equals one: it is not listed
      const listed = verified.some(
        (e) =>
          e.cli === input.providerId &&
          e.version === input.version &&
          e.os === os &&
          e.profile === profiles.standard,
      );
      if (listed) {
        if (input.trigger === "background" && !readCliBackground(options.db)) {
          return block("cli-background-off");
        }
        return { run: true, cli: { profile: profiles.standard, isolation: "verified" } };
      }
      if (decideAs !== "development") return block("cli-not-verified");
      if (input.trigger !== "user") return block("unverified-background");
      if (input.classification !== "synthetic") return block("unverified-not-synthetic");
      if (input.malicious) return block("unverified-malicious");
      if (input.unverifiedAcknowledged !== true) return block("unverified-ack-required");
      return { run: true, cli: { profile: profiles.minimal, isolation: "unverified" } };
    },
  };
}
