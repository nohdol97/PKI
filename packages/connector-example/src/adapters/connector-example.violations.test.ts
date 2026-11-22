// I01-R27 / C4 (`connector-example.violations`): each deliberately broken variant
// of the example is reported with its violation code, and that code alone, under
// the scenario the example itself passes.
import { checkConnector } from "@pki/testkit";
import { describe, expect, it } from "vitest";
import { EARLIER, LATER } from "./synthetic-notes.ts";
import {
  createEarlyAnswerConnector,
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
});
