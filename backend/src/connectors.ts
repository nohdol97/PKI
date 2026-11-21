// Connector management (ARCHITECTURE 5.5): initializes the configured instances
// once, and syncs one by calling getChanges until it has no more pages. Each page
// and the cursor after it are written in one transaction, so the stored cursor
// never runs ahead of the stored records (ADR 0013 decision 1).
import {
  ChangeSetSchema,
  ConnectorNotImplementedError,
  type Connector,
  type ConnectorSummary,
  type ErrorResponse,
  type SyncResponse,
} from "@pki/contracts";
import {
  readCursor,
  registerConnectorInstance,
  saveSourceRecord,
  writeCursor,
  type SqlDriver,
} from "@pki/storage";

const PAGE_LIMIT = 100;

export interface ConnectorInstanceConfig {
  id: string;
  kind: string;
  config: unknown;
}

export type ConnectorFactory = () => Connector;

export interface ConnectorManager {
  list(): ConnectorSummary[];
  sync(
    id: string,
  ): Promise<
    SyncResponse | { error: Extract<ErrorResponse["error"], "not-found" | "connector-unavailable"> }
  >;
}

export async function syncConnector(
  db: SqlDriver,
  instanceId: string,
  kind: string,
  connector: Connector,
  signal: AbortSignal = new AbortController().signal,
): Promise<{ received: number; created: number }> {
  db.transaction(() => registerConnectorInstance(db, instanceId, kind));
  let cursor = readCursor(db, instanceId);
  let received = 0;
  let created = 0;
  // One full rescan per sync: a second expiry, or a page that promises more without
  // moving, would otherwise loop forever.
  let rescanned = false;
  for (;;) {
    const page = ChangeSetSchema.parse(
      await connector.getChanges(cursor, { limit: PAGE_LIMIT, signal }),
    );
    if (page.cursorExpired) {
      if (rescanned || cursor === null) {
        throw new Error(`${instanceId}: cursor expired on a full rescan`);
      }
      rescanned = true;
      cursor = null;
      continue;
    }
    if (page.hasMore && page.nextCursor === cursor) {
      throw new Error(`${instanceId}: page reports more changes without progress`);
    }
    db.transaction(() => {
      for (const change of page.changes) {
        // Tombstones and content removal arrive with V02 (ARCHITECTURE 6).
        if (change.kind !== "upsert") throw new Error(`${change.kind} changes are not stored yet`);
        if (saveSourceRecord(db, instanceId, change.record) === "created") created++;
      }
      writeCursor(db, instanceId, page.nextCursor);
    });
    received += page.changes.length;
    cursor = page.nextCursor;
    if (!page.hasMore) return { received, created };
  }
}

export async function createConnectorManager(
  db: SqlDriver,
  instances: readonly ConnectorInstanceConfig[],
  kinds: Readonly<Record<string, ConnectorFactory>>,
): Promise<ConnectorManager> {
  const entries = await Promise.all(
    instances.map(async ({ id, kind, config }) => {
      const factory = Object.hasOwn(kinds, kind) ? kinds[kind] : undefined;
      if (!factory) throw new Error(`unknown connector kind: ${kind}`);
      const connector = factory();
      try {
        await connector.initialize(config);
        return { id, kind, state: "ready" as const, connector };
      } catch (error) {
        const state: ConnectorSummary["state"] =
          error instanceof ConnectorNotImplementedError ? "not-implemented" : "unavailable";
        return { id, kind, state, connector };
      }
    }),
  );
  return {
    list: () => entries.map(({ id, kind, state }) => ({ id, kind, state })),
    async sync(id) {
      const entry = entries.find((e) => e.id === id);
      if (!entry) return { error: "not-found" };
      if (entry.state !== "ready") return { error: "connector-unavailable" };
      return { connectorId: id, ...(await syncConnector(db, id, entry.kind, entry.connector)) };
    },
  };
}
