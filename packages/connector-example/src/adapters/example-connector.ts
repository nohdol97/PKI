// Third-party Connector example (I01-R27): what a fork writes under
// site/connectors/, built on the public entries only. Its origin system is made
// up and lives in memory: the config is the data. The origin keeps one row per
// note (its present state), stamps every change with a growing sequence number
// and keeps a deleted note as a mark, so a rescan reports every deletion again
// without this Connector tracking anything itself.
import {
  ChangeSchema,
  CONNECTOR_SDK_VERSION,
  ConnectorError,
  type Change,
  type Connector,
} from "@pki/contracts";

/** A note as the origin holds it now; `seq` is the origin's change counter. */
export type ExampleNote = { id: string; seq: number; revision: number; updatedAt: string } & (
  { title: string; body: string } | { deleted: true }
);
export interface ExampleConfig {
  /** The one namespace of this instance's notes. */
  namespace: string;
  notes: ExampleNote[];
}

interface Origin {
  namespace: string;
  /** One change per note, by `seq`. */
  entries: { seq: number; change: Change }[];
}

const CURSOR = /^seq:(\d{1,15})$/;
const idOf = (change: Change) =>
  change.kind === "upsert" ? change.record.externalId : change.externalId;

/** The config as the origin's change feed; anything malformed throws. */
function originOf(config: unknown): Origin {
  const { namespace, notes } = config as { namespace: unknown; notes: unknown };
  if (typeof namespace !== "string" || !Array.isArray(notes)) {
    throw new TypeError("needs { namespace: string, notes: ExampleNote[] }");
  }
  const entries = notes
    .map((note: Record<string, unknown>) => {
      const { id: externalId, seq, revision, updatedAt, title, body } = note;
      if (!Number.isSafeInteger(seq) || (seq as number) < 1) {
        throw new TypeError("a note's seq is an integer, 1 or more");
      }
      const ref = { namespace, externalId, revision };
      const change = ChangeSchema.parse(
        note.deleted === true
          ? { kind: "delete", ...ref, at: updatedAt }
          : {
              kind: "upsert",
              record: { ...ref, schemaVersion: CONNECTOR_SDK_VERSION, title, body, updatedAt },
            },
      );
      return { seq: seq as number, change };
    })
    .sort((a, b) => a.seq - b.seq);
  const distinct = (values: unknown[]) => new Set(values).size === values.length;
  if (!distinct(entries.map((e) => e.seq)) || !distinct(entries.map((e) => idOf(e.change)))) {
    throw new TypeError("every note has its own id and seq");
  }
  return { namespace, entries };
}

export function createExampleConnector(): Connector {
  let origin: Origin | undefined;
  const loaded = () => {
    if (!origin) throw new ConnectorError("not initialized", { retryable: false });
    return origin;
  };

  return {
    manifest: {
      type: "connector-example",
      schemaVersion: CONNECTOR_SDK_VERSION,
      capabilities: {
        incremental: true,
        deletes: true,
        accessScope: false,
        fullRescan: true,
        deletionsOnRescan: true,
      },
    },
    async initialize(config) {
      try {
        origin = originOf(config);
      } catch {
        throw new ConnectorError("invalid config", { retryable: false });
      }
    },
    async healthCheck() {
      return origin ? { state: "ok" } : { state: "unavailable", reason: "not initialized" };
    },
    async getChanges(cursor, { limit, signal }) {
      signal.throwIfAborted();
      const { entries } = loaded();
      if (!(limit >= 1)) throw new ConnectorError("limit is 1 or more", { retryable: false });
      const after = cursor === null ? 0 : Number(CURSOR.exec(cursor)?.[1] ?? NaN);
      // Not a cursor of this origin, or one from ahead of it (the origin was reset).
      if (!(after <= (entries.at(-1)?.seq ?? 0))) {
        return { changes: [], nextCursor: "seq:0", hasMore: false, cursorExpired: true };
      }
      const rest = entries.filter((e) => e.seq > after);
      const page = rest.slice(0, limit);
      return {
        changes: page.map((e) => e.change),
        nextCursor: `seq:${page.at(-1)?.seq ?? after}`,
        hasMore: page.length < rest.length,
      };
    },
    async getDocument({ namespace, externalId }) {
      const { entries, ...own } = loaded();
      if (namespace !== own.namespace) return null;
      const change = entries.find((e) => idOf(e.change) === externalId)?.change;
      return change?.kind === "upsert" ? change.record : null;
    },
  };
}
