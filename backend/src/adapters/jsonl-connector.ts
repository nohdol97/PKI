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
// (`{ records }`); they are in the namespace of their `connector_instance_id` like a file's.
// An instance made for an approved JSONL file location (I02B-R41, configuration `{ path, locationId }`) does
// not read the path as it stands: the file is opened through the path boundary of @pki/connector-sdk, which
// reads it only when the opened handle is the file the approval recorded (a regular file, the same
// identity, outside the data directory). It reads while the location is `active`. A refusal for the place or the
// identity (DPF-R4) leaves the sync failed as before and moves the location to `unavailable`; while it is
// `unavailable` the file is opened with the recorded identity each sync (DPF-R5): a match makes the location
// `active` again, anything else gives an empty page and no failure. Any other state gives nothing.
// This is the one place of the product that reads a JSONL file's path.
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
  nodeBoundaryFs,
  parseJsonl,
  readLocationFile,
  recordToChange,
  resolveExcluded,
  type BoundaryFs,
  type JsonlRejection,
} from "@pki/connector-sdk";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

/** What the composition point hands an instance of an approved JSONL file location (I02B-R4, R41). */
export interface JsonlFilePorts {
  /** The approval of a location: where the file is, the identity recorded then and the state; undefined when none. */
  location(
    locationId: string,
  ): { realPath: string; rootDev: string; rootIno: string; state: string } | undefined;
  /** Moves an `active` location to `unavailable` with a reason; a state the user set meanwhile is left alone. */
  markUnavailable(locationId: string, reason: "root-changed" | "root-missing"): void;
  /** Moves an `unavailable` location back to `active`. */
  markActive(locationId: string): void;
  /** Folders a read never reaches into: the data directory, the shell's user-data folder. */
  excluded(): readonly string[];
  fs?: BoundaryFs;
}

export type JsonlConnectorConfig =
  { path: string; locationId?: string } | { records: readonly ImportRecord[] };

/** A line of the file, as one entry of a read. */
type Entry = { change: Change } | { rejected: Pick<JsonlRejection, "line" | "code"> };

interface Snapshot {
  hash: string;
  entries: Entry[];
}

function readConfig(config: unknown): JsonlConnectorConfig {
  const given = config as Partial<{ path: unknown; records: unknown }> | null;
  const locationId = (config as { locationId?: unknown } | null)?.locationId;
  if (typeof given?.path === "string" && given.path !== "") {
    return typeof locationId === "string" && locationId !== ""
      ? { path: given.path, locationId }
      : { path: given.path };
  }
  if (Array.isArray(given?.records)) return { records: given.records as ImportRecord[] };
  throw new Error("jsonl-import needs { path: string }");
}

/** The refusals that mean the file is not the approved one or is not there: the state reason they leave (DPF-R4). */
const UNAVAILABLE_REASON: Partial<Record<string, "root-changed" | "root-missing">> = {
  redirected: "root-changed",
  symlink: "root-changed",
  "not-regular-file": "root-changed",
  "not-readable": "root-missing",
};

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export function createJsonlConnector(ports?: () => JsonlFilePorts | undefined): Connector {
  let config: JsonlConnectorConfig | undefined;
  // the last parse, kept by the file's hash: a page is a slice of it
  let cached: Snapshot | undefined;

  const configured = () => {
    if (!config) throw new Error("jsonl-import Connector is not initialized");
    return config;
  };

  /** The bytes of an approved location's file, opened through the path boundary; undefined while the location is not read. */
  async function readApproved(locationId: string): Promise<Buffer | undefined> {
    const bound = ports?.();
    if (!bound) {
      throw new ConnectorError("jsonl-import: the ports are not bound", { retryable: true });
    }
    const location = bound.location(locationId);
    if (!location) {
      throw new ConnectorError("jsonl-import: the location is not approved", { retryable: false });
    }
    const wasActive = location.state === "active";
    if (!wasActive && location.state !== "unavailable") return undefined;
    const fs = bound.fs ?? nodeBoundaryFs;
    const read = await readLocationFile({
      fs,
      rootRealPath: location.realPath,
      relativePath: "",
      kind: "file",
      maxFileBytes: MAX_JSONL_BYTES,
      excluded: await resolveExcluded(fs, bound.excluded()),
      expectedId: { dev: location.rootDev, ino: location.rootIno },
    });
    if (!read.ok) {
      if (!wasActive) return undefined;
      const reason = UNAVAILABLE_REASON[read.reason];
      if (reason) bound.markUnavailable(locationId, reason);
      throw new ConnectorError(`jsonl-import: the file cannot be read (${read.reason})`, {
        retryable: false,
      });
    }
    if (!wasActive) bound.markActive(locationId);
    return Buffer.from(read.bytes);
  }

  /** The file as it is now; undefined for a location that is not read. What failed is the file's, never its text: a plain code. */
  async function snapshot(): Promise<Snapshot | undefined> {
    const source = configured();
    if ("records" in source) {
      cached ??= {
        hash: sha256(JSON.stringify(source.records)),
        entries: source.records.map((record) => ({ change: recordToChange(record) })),
      };
      return cached;
    }
    let raw: Buffer | undefined;
    if (source.locationId !== undefined) raw = await readApproved(source.locationId);
    else {
      try {
        if (statSync(source.path).size > MAX_JSONL_BYTES) throw new Error("too large");
        raw = readFileSync(source.path);
      } catch {
        throw new ConnectorError("jsonl-import: the file cannot be read", { retryable: false });
      }
    }
    if (raw === undefined) return undefined;
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
        await snapshot();
        return { state: "ok" };
      } catch {
        return { state: "unavailable", reason: "the file cannot be read" };
      }
    },
    async getChanges(cursor, { limit, signal }): Promise<ChangeSet> {
      signal.throwIfAborted();
      const read = await snapshot();
      // a location that is not read gives nothing and keeps the cursor (a later read compares it with the file)
      if (!read) return { changes: [], nextCursor: cursor ?? "", hasMore: false };
      const { hash, entries } = read;
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
      for (const entry of (await snapshot())?.entries ?? []) {
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
