// V01-R7: the test Connector over the repository's synthetic fixtures passes the
// Connector contract, and never forwards the fixtures' malicious marker.
import { connectorContract } from "@pki/testkit";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createFixtureConnector } from "./fixture-connector.ts";

const file = resolve(import.meta.dirname, "../../../fixtures/test-connector.jsonl");

connectorContract("test-fixtures", createFixtureConnector, { file });

describe("test-fixtures Connector", () => {
  it("emits records without the fixture-only malicious marker", async () => {
    const connector = createFixtureConnector();
    await connector.initialize({ file });
    const { changes } = await connector.getChanges(null, {
      limit: 100,
      signal: new AbortController().signal,
    });
    expect(changes.length).toBeGreaterThan(0);
    for (const change of changes) {
      expect(change.kind === "upsert" && Object.keys(change.record).sort()).toEqual([
        "body",
        "externalId",
        "title",
      ]);
    }
  });

  it("reports an unknown cursor as expired so the caller rescans", async () => {
    const connector = createFixtureConnector();
    await connector.initialize({ file });
    const page = await connector.getChanges("not-a-cursor", {
      limit: 10,
      signal: new AbortController().signal,
    });
    expect(page.cursorExpired).toBe(true);
    expect(page.changes).toEqual([]);
  });

  it("fails to initialize without a fixtures file", async () => {
    await expect(createFixtureConnector().initialize({})).rejects.toThrow();
  });
});
