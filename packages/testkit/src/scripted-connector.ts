// Scripted Connector (I01-R26): a test double that replays a set script of
// changes, rejections, errors, rate limits and expired cursors, in order, so the
// management module's sync tests can stage each case. Test builds only.
import {
  CONNECTOR_SDK_VERSION,
  ConnectorError,
  type Change,
  type ChangeSet,
  type Connector,
  type ConnectorCapabilities,
  type ConnectorContext,
  type ConnectorManifest,
  type HealthStatus,
  type RejectCode,
  type SourceRecord,
} from "@pki/contracts";

/** A change, or a position the Connector filtered out itself (`ChangeSet.rejected`). */
export type ScriptEntry = Change | { kind: "rejected"; at: string; code: RejectCode };

/** Intercepts calls: the first matching fault with uses left answers instead of a page. */
export interface ScriptFault {
  /** The cursor it answers (null: the first page); without the key, any cursor. */
  cursor?: string | null;
  /** How many matching calls it answers; 1 by default. */
  times?: number;
  /** Thrown instead of a page (ConnectorError, ConnectorRateLimitError, …). */
  raise?: Error;
  /** Answered with an expired-cursor page instead. */
  expire?: true;
}

export interface ScriptCall {
  cursor: string | null;
  limit: number;
  signal: AbortSignal;
}

/** What `initialize` takes: the script of this origin. */
export interface ConnectorScript {
  entries: readonly ScriptEntry[];
  /** Entries per page at most; a page is min(pageSize, limit). 2 by default. */
  pageSize?: number;
  faults?: readonly ScriptFault[];
  /** Awaited before each answer, after the call is logged; the signal is checked after it. */
  beforeAnswer?: (call: ScriptCall) => void | Promise<void>;
  /**
   * Awaited by `initialize` with its second argument (undefined when none came); what it
   * throws fails the initialization, as a Connector refusing its credentials does (I06-R5).
   */
  onInitialize?: (context: ConnectorContext | undefined) => void | Promise<void>;
}

export interface ScriptedConnectorOptions {
  type?: string;
  schemaVersion?: number;
  capabilities?: Partial<ConnectorCapabilities>;
}

const offsetOf = (cursor: string): number | null => {
  const match = /^offset:(\d+)$/.exec(cursor);
  return match ? Number(match[1]) : null;
};
const key = (namespace: string, externalId: string) => JSON.stringify([namespace, externalId]);

export class ScriptedConnector implements Connector {
  readonly #manifest: ConnectorManifest;
  #script: Required<Pick<ConnectorScript, "entries" | "pageSize">> & ConnectorScript;
  #faults: { fault: ScriptFault; left: number }[] = [];
  #initialized = false;
  /** Every getChanges call, in order. */
  readonly calls: ScriptCall[] = [];

  constructor(options: ScriptedConnectorOptions = {}) {
    this.#manifest = {
      type: options.type ?? "scripted",
      schemaVersion: options.schemaVersion ?? CONNECTOR_SDK_VERSION,
      capabilities: {
        incremental: true,
        deletes: false,
        accessScope: false,
        fullRescan: true,
        deletionsOnRescan: false,
        ...options.capabilities,
      },
    };
    this.#script = { entries: [], pageSize: 2 };
  }

  get manifest(): ConnectorManifest {
    return this.#manifest;
  }

  async initialize(config: unknown, context?: ConnectorContext): Promise<void> {
    const script = config as Partial<ConnectorScript> | null;
    if (!Array.isArray(script?.entries)) {
      throw new ConnectorError("scripted Connector needs { entries }", { retryable: false });
    }
    await script.onInitialize?.(context);
    this.#script = { ...script, entries: script.entries, pageSize: script.pageSize ?? 2 };
    this.#faults = (script.faults ?? []).map((fault) => ({ fault, left: fault.times ?? 1 }));
    this.#initialized = true;
  }

  async healthCheck(): Promise<HealthStatus> {
    return this.#initialized
      ? { state: "ok" }
      : { state: "unavailable", reason: "not initialized" };
  }

  async getChanges(
    cursor: string | null,
    opts: { limit: number; signal: AbortSignal },
  ): Promise<ChangeSet> {
    opts.signal.throwIfAborted();
    const { entries, pageSize, beforeAnswer } = this.#loaded();
    const call = { cursor, limit: opts.limit, signal: opts.signal };
    this.calls.push(call);
    await beforeAnswer?.(call);
    opts.signal.throwIfAborted();

    const expired: ChangeSet = {
      changes: [],
      nextCursor: "",
      hasMore: false,
      cursorExpired: true,
      rejected: [],
    };
    const hit = this.#faults.find(
      ({ fault, left }) => left > 0 && (!("cursor" in fault) || fault.cursor === cursor),
    );
    if (hit) {
      hit.left--;
      if (hit.fault.raise) throw hit.fault.raise;
      if (hit.fault.expire) return expired;
    }

    const start = cursor === null ? 0 : offsetOf(cursor);
    if (start === null || start > entries.length) return expired;
    const end = Math.min(start + Math.min(pageSize, opts.limit), entries.length);
    const changes: Change[] = [];
    const rejected: { at: string; code: RejectCode }[] = [];
    for (const entry of entries.slice(start, end)) {
      if (entry.kind === "rejected") rejected.push({ at: entry.at, code: entry.code });
      else changes.push(entry);
    }
    return { changes, nextCursor: `offset:${end}`, hasMore: end < entries.length, rejected };
  }

  /** The script folded: highest-revision upsert, later scope changes, null after a tombstone. */
  async getDocument(ref: { namespace: string; externalId: string }): Promise<SourceRecord | null> {
    const wanted = key(ref.namespace, ref.externalId);
    let current = null as SourceRecord | null;
    for (const entry of this.#loaded().entries) {
      if (entry.kind === "rejected") continue;
      const identity = entry.kind === "upsert" ? entry.record : entry;
      if (key(identity.namespace, identity.externalId) !== wanted) continue;
      if (entry.kind === "upsert") {
        if (!current || entry.record.revision >= current.revision) current = entry.record;
      } else if (entry.kind === "scope-change") {
        if (current) current = { ...current, accessScope: entry.accessScope };
      } else {
        current = null;
      }
    }
    return current;
  }

  #loaded() {
    if (!this.#initialized)
      throw new ConnectorError("scripted Connector is not initialized", { retryable: false });
    return this.#script;
  }
}
