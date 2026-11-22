// Test Connector (V01-R7, SDK v2): replays a JSONL file of synthetic records, one
// per line, in the instance's one namespace (""). A line's optional `revision`
// is the record's (1 when absent). The cursor is the count of records already
// delivered. A fixture line's "malicious" marker is for the synthetic manifest
// only and is not forwarded.
import {
  CONNECTOR_SDK_VERSION,
  SourceRecordSchema,
  type Connector,
  type SourceRecord,
} from "@pki/contracts";
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
      schemaVersion: CONNECTOR_SDK_VERSION,
      capabilities: {
        incremental: true,
        deletes: false,
        accessScope: false,
        fullRescan: true,
        deletionsOnRescan: false,
      },
    },
    async initialize(config) {
      const file = (config as { file?: unknown } | null)?.file;
      if (typeof file !== "string") throw new Error("test-fixtures needs { file: string }");
      records = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          const { externalId, title, body, revision = 1 } = JSON.parse(line);
          return SourceRecordSchema.parse({
            namespace: "",
            externalId,
            revision,
            schemaVersion: CONNECTOR_SDK_VERSION,
            title,
            body,
          });
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
    async getDocument({ namespace, externalId }) {
      return loaded().find((r) => r.namespace === namespace && r.externalId === externalId) ?? null;
    },
  };
}
