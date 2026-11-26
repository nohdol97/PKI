// I01-R27 / C4 (`connector-example.violations`): each deliberately broken variant
// of the example is reported with its violation code, and that code alone, under
// the scenario the example itself passes.
import { checkConnector, type ConnectorScenario } from "@pki/testkit";
import { describe, expect, it } from "vitest";
import { SESSION_SLOT } from "./rotating-session-connector.ts";
import {
  CREDENTIALED_EARLIER,
  CREDENTIALED_LATER,
  EARLIER,
  LATER,
  rotatingSession,
  SYNTHETIC_TOKEN,
  SYNTHETIC_WRONG_TOKEN,
} from "./synthetic-notes.ts";
import {
  createEarlyAnswerConnector,
  createErrorLeakingConnector,
  createHealthLeakingConnector,
  createLogLeakingConnector,
  createRotatedLeakingConnector,
  createUnwrittenSessionConnector,
  createRecordLeakingConnector,
  createUnsignalledRejectionConnector,
  createStuckCursorConnector,
  createUndeclaredDeletesConnector,
} from "./violating-connectors.ts";

describe("connector-example.violations", () => {
  it.each([
    ["no-progress", createStuckCursorConnector],
    ["capability-deletes", createUndeclaredDeletesConnector],
    ["responds-before-init", createEarlyAnswerConnector],
  ] as const)("checkConnector reports %s for its variant", async (code, create) => {
    expect(await checkConnector(create, { config: EARLIER, later: LATER })).toEqual([code]);
  });

  it.each([
    ["credential-in-record", createRecordLeakingConnector],
    ["credential-in-health", createHealthLeakingConnector],
    ["credential-in-error", createErrorLeakingConnector],
    ["credential-in-log", createLogLeakingConnector],
    ["credential-rejection-unsignalled", createUnsignalledRejectionConnector],
  ] as const)(
    "checkConnector reports %s for its variant, under the credential scenarios",
    async (code, create) => {
      expect(
        await checkConnector(create, {
          config: CREDENTIALED_EARLIER,
          later: CREDENTIALED_LATER,
          credentials: { token: SYNTHETIC_TOKEN },
          rejected: { config: CREDENTIALED_EARLIER, credentials: { token: SYNTHETIC_WRONG_TOKEN } },
        }),
      ).toEqual([code]);
    },
  );

  it.each([
    ["session-not-persisted", createUnwrittenSessionConnector],
    ["rotated-credential-leaked", createRotatedLeakingConnector],
  ] as const)(
    "checkConnector reports %s for its variant, under the login scenario (I06S-C5)",
    async (code, create) => {
      // a new origin per check: the sign-in state is the origin's own
      const { earlier, later, first, wrong } = rotatingSession();
      const scenario: ConnectorScenario = {
        config: earlier,
        later,
        credentials: { [SESSION_SLOT]: first },
        login: SESSION_SLOT,
        rejected: { config: earlier, credentials: { [SESSION_SLOT]: wrong } },
      };
      expect(await checkConnector(create, scenario)).toEqual([code]);
    },
  );

  it("the responds-before-init variant answers getChanges, and only that, before initialize", async () => {
    const variant = createEarlyAnswerConnector();
    const page = await variant.getChanges(null, { limit: 1, signal: new AbortController().signal });
    expect(page).toEqual({ changes: [], nextCursor: "seq:0", hasMore: false });
    await expect(variant.getDocument({ namespace: "", externalId: "note-1" })).rejects.toThrow();
  });
});
