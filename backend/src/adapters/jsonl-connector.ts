// JSONL Connector (I01-R23): reads the one JSONL file of its configuration (`{ path }`)
// through @pki/connector-sdk's parser, the same one the import API reads a request
// with. The cursor is `<sha256 of the file's content>:<entries given>`: an entry is a
// line that became a change or a refusal, in line order. A file edited since the cursor
// was made has another hash, which expires the cursor, so the fixed file read again from
// the start is a full rescan and the store's rules (I01-R10) drop what it holds
// already. Deletions are lines of the file (`delete`), read again by every rescan, so
// `deletionsOnRescan` is false: a line removed from the file is no deletion, so the rescan of an
// edited file raises `deletionsMayBeMissed`. Each line
// is one version, so a file with several versions of a source hands them on in line
// order and the store judges their order (I01-R10): that is more than the Connector
// contract's one upsert per source per read, which the contract scenarios keep to. The
// importer of the V02 screen (jsonl-import.ts) hands lines it parsed itself
// (`{ records }`), in the instance's one namespace "".
import {
  CONNECTOR_SDK_VERSION,
  ConnectorError,
  type Change,
  type ChangeSet,
  type Connector,
  type ImportRecord,
  type SourceRecord,
} from "@pki/contracts";
import {
  JSONL_CAPABILITIES,
  JSONL_IMPORT_KIND,
  MAX_JSONL_BYTES,
  parseJsonl,
  recordToChange,
  type JsonlRejection,
} from "@pki/connector-sdk";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export type JsonlConnectorConfig = { path: string } | { records: readonly ImportRecord[] };

/** A line of the file, as one entry of a read. */
type Entry = { change: Change } | { rejected: Pick<JsonlRejection, "line" | "code"> };

interface Snapshot {
  hash: string;
  entries: Entry[];
}

function readConfig(config: unknown): JsonlConnectorConfig {
  const given = config as Partial<{ path: unknown; records: unknown }> | null;
  if (typeof given?.path === "string" && given.path !== "") return { path: given.path };
  if (Array.isArray(given?.records)) return { records: given.records as ImportRecord[] };
  throw new Error("jsonl-import needs { path: string }");
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export function createJsonlConnector(): Connector {
  let config: JsonlConnectorConfig | undefined;
  // the last parse, kept by the file's hash: a page is a slice of it
  let cached: Snapshot | undefined;

  const configured = () => {
    if (!config) throw new Error("jsonl-import Connector is not initialized");
    return config;
  };

  /** The file as it is now. What failed is the file's, never its text: a plain code. */
  function snapshot(): Snapshot {
    const source = configured();
    if ("records" in source) {
      cached ??= {
        hash: sha256(JSON.stringify(source.records)),
        entries: source.records.map((record) => ({ change: recordToChange(record, () => "") })),
      };
      return cached;
    }
    let raw: Buffer;
    try {
      if (statSync(source.path).size > MAX_JSONL_BYTES) throw new Error("too large");
      raw = readFileSync(source.path);
    } catch {
      throw new ConnectorError("jsonl-import: the file cannot be read", { retryable: false });
    }
    const hash = sha256(raw);
    if (cached?.hash === hash) return cached;
    const { lines, rejected } = parseJsonl(raw.toString("utf8"));
    const entries = [
      ...lines.map((l) => ({ line: l.line, entry: { change: l.change } as Entry })),
      ...rejected.map((r) => ({ line: r.line, entry: { rejected: r } as Entry })),
    ]
      .sort((a, b) => a.line - b.line)
      .map((e) => e.entry);
    return (cached = { hash, entries });
  }

  return {
    manifest: {
      type: JSONL_IMPORT_KIND,
      schemaVersion: CONNECTOR_SDK_VERSION,
      capabilities: JSONL_CAPABILITIES,
    },
    async initialize(given) {
      config = readConfig(given);
      cached = undefined;
    },
    async healthCheck() {
      if (!config) return { state: "unavailable", reason: "not initialized" };
      try {
        snapshot();
        return { state: "ok" };
      } catch {
        return { state: "unavailable", reason: "the file cannot be read" };
      }
    },
    async getChanges(cursor, { limit, signal }): Promise<ChangeSet> {
      signal.throwIfAborted();
      const { hash, entries } = snapshot();
      let start = 0;
      if (cursor !== null) {
        const match = /^([0-9a-f]{64}):(\d+)$/.exec(cursor);
        start = match ? Number(match[2]) : Number.NaN;
        if (!match || match[1] !== hash || !(start <= entries.length)) {
          return { changes: [], nextCursor: "", hasMore: true, cursorExpired: true };
        }
      }
      const changes: Change[] = [];
      const rejected: ChangeSet["rejected"] = [];
      let end = start;
      for (; end < entries.length && changes.length + rejected.length < limit; end++) {
        const entry = entries[end] as Entry;
        if ("rejected" in entry) {
          rejected.push({ at: `line:${entry.rejected.line}`, code: entry.rejected.code });
        } else {
          changes.push(entry.change);
        }
      }
      return { changes, rejected, nextCursor: `${hash}:${end}`, hasMore: end < entries.length };
    },
    async getDocument({ namespace, externalId }): Promise<SourceRecord | null> {
      let latest: Change | undefined;
      for (const entry of snapshot().entries) {
        if (!("change" in entry)) continue;
        const { change } = entry;
        const ns = change.kind === "upsert" ? change.record.namespace : change.namespace;
        const id = change.kind === "upsert" ? change.record.externalId : change.externalId;
        if (ns === namespace && id === externalId) latest = change;
      }
      return latest?.kind === "upsert" ? latest.record : null;
    },
  };
}
