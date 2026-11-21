// JSONL Connector (V02-R2): one Connector instance replays the lines of a JSONL
// text (jsonl-lines.ts) that carry its `connector_instance_id`; the importer
// (jsonl-import.ts) runs one per instance found in a file. The cursor is the count
// of changes already delivered.
import type { Change, Connector, SourceRecord } from "@pki/contracts";
import { parseJsonl, toChange } from "../jsonl-lines.ts";

export interface JsonlConnectorConfig {
  text: string;
  connectorInstanceId: string;
}

function readConfig(config: unknown): JsonlConnectorConfig {
  const { text, connectorInstanceId } = (config ?? {}) as Partial<JsonlConnectorConfig>;
  if (typeof text !== "string" || typeof connectorInstanceId !== "string") {
    throw new Error("jsonl-import needs { text: string, connectorInstanceId: string }");
  }
  return { text, connectorInstanceId };
}

export function createJsonlConnector(): Connector {
  let changes: Change[] | undefined;
  const loaded = () => {
    if (!changes) throw new Error("jsonl-import Connector is not initialized");
    return changes;
  };

  return {
    manifest: {
      type: "jsonl-import",
      schemaVersion: 1,
      capabilities: { incremental: true, deletes: true, accessScope: true, fullRescan: true },
    },
    async initialize(config) {
      const { text, connectorInstanceId } = readConfig(config);
      changes = parseJsonl(text)
        .lines.filter((l) => l.record.connector_instance_id === connectorInstanceId)
        .map((l) => toChange(l.record));
    },
    async healthCheck() {
      return changes ? { state: "ok" } : { state: "unavailable", reason: "not initialized" };
    },
    async getChanges(cursor, { limit, signal }) {
      signal.throwIfAborted();
      const all = loaded();
      const start = cursor === null ? 0 : Number(cursor);
      if ((cursor !== null && !/^\d+$/.test(cursor)) || start > all.length) {
        return { changes: [], nextCursor: "0", hasMore: true, cursorExpired: true };
      }
      const end = Math.min(start + limit, all.length);
      return { changes: all.slice(start, end), nextCursor: String(end), hasMore: end < all.length };
    },
    async getDocument(externalId): Promise<SourceRecord | null> {
      for (const change of loaded()) {
        if (change.kind === "upsert" && change.record.externalId === externalId) {
          return change.record;
        }
      }
      return null;
    },
  };
}
