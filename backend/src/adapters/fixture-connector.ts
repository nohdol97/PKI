// Test Connector (V01-R7): replays a JSONL file of synthetic records, one per
// line. The cursor is the count of records already delivered. A fixture line's
// "malicious" marker is for the synthetic manifest only and is not forwarded.
import { SourceRecordSchema, type Connector, type SourceRecord } from "@pki/contracts";
import { readFileSync } from "node:fs";

export function createFixtureConnector(): Connector {
  let records: SourceRecord[] | undefined;
  const loaded = () => {
    if (!records) throw new Error("test-fixtures Connector is not initialized");
    return records;
  };

  return {
    manifest: {
      type: "test-fixtures",
      schemaVersion: 1,
      capabilities: { incremental: true, deletes: false, accessScope: false, fullRescan: true },
    },
    async initialize(config) {
      const file = (config as { file?: unknown } | null)?.file;
      if (typeof file !== "string") throw new Error("test-fixtures needs { file: string }");
      records = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          const { externalId, title, body } = JSON.parse(line);
          return SourceRecordSchema.parse({ externalId, title, body });
        });
    },
    async healthCheck() {
      return records ? { state: "ok" } : { state: "unavailable", reason: "not initialized" };
    },
    async getChanges(cursor, { limit, signal }) {
      signal.throwIfAborted();
      const all = loaded();
      const start = cursor === null ? 0 : Number(cursor);
      if ((cursor !== null && !/^\d+$/.test(cursor)) || start > all.length) {
        return { changes: [], nextCursor: "0", hasMore: true, cursorExpired: true };
      }
      const end = Math.min(start + limit, all.length);
      return {
        changes: all.slice(start, end).map((record) => ({ kind: "upsert", record })),
        nextCursor: String(end),
        hasMore: end < all.length,
      };
    },
    async getDocument(externalId) {
      return loaded().find((r) => r.externalId === externalId) ?? null;
    },
  };
}
