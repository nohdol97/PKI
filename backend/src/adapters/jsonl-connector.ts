// JSONL Connector (V02-R2): one Connector instance replays parsed JSONL lines
// (jsonl-lines.ts) of one `connector_instance_id`. The importer (jsonl-import.ts)
// parses a file once and hands each instance its own lines, one round at a time,
// so a read names each source once. The cursor is the count of changes delivered.
// SDK v2: one product instance per `connector_instance_id` (V02), so its records
// are in the instance's one namespace, "" (I01-R5), until I01-T05's import API.
import {
  CONNECTOR_SDK_VERSION,
  type Change,
  type Connector,
  type ImportRecord,
  type SourceRecord,
} from "@pki/contracts";
import { toChange } from "../jsonl-lines.ts";

export interface JsonlConnectorConfig {
  /** Parsed lines of one instance, each source at most once. */
  records: readonly ImportRecord[];
}

function readConfig(config: unknown): JsonlConnectorConfig {
  const records = (config as Partial<JsonlConnectorConfig> | null)?.records;
  if (!Array.isArray(records)) throw new Error("jsonl-import needs { records: ImportRecord[] }");
  const ids = new Set(records.map((r: ImportRecord) => r.external_id));
  if (ids.size !== records.length) {
    throw new Error("jsonl-import: a read names each source once; split the lines into rounds");
  }
  return { records };
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
      schemaVersion: CONNECTOR_SDK_VERSION,
      // access_scope is not carried yet (V02 spec "T04가 넘기는 것" 6); the v2
      // cursor and capabilities of I01-R23 are I01-T05's
      capabilities: {
        incremental: true,
        deletes: true,
        accessScope: false,
        fullRescan: true,
        deletionsOnRescan: false,
      },
    },
    async initialize(config) {
      changes = readConfig(config).records.map(toChange);
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
    async getDocument({ namespace, externalId }): Promise<SourceRecord | null> {
      for (const change of loaded()) {
        if (
          change.kind === "upsert" &&
          change.record.namespace === namespace &&
          change.record.externalId === externalId
        ) {
          return change.record;
        }
      }
      return null;
    },
  };
}
