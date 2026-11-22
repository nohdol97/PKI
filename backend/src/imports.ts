// The local import API's work (I01-R24): one JSONL text for one instance. The text is
// read by @pki/connector-sdk's parser, the file collector's own, and its changes go to
// the management module's page store (`storePage`), the sync's own, so a line means the
// same on both paths and the same rules judge it (I01-R10 to R15). The request is one
// page: one transaction, no cursor. The instance's lock is taken here, for the whole
// request; the page store does not take it (`syncConnector` does, for a sync), so the
// API and a sync of the same instance never run together (I01-R21). The text is
// untrusted: what is refused is named by line number and code, never by its text.
import { JSONL_CAPABILITIES, JSONL_IMPORT_KIND, parseJsonl } from "@pki/connector-sdk";
import type { ErrorResponse, SyncResponse } from "@pki/contracts";
import { readConnectorKind, registerConnectorInstance, type SqlDriver } from "@pki/storage";
import { applyConfiguredScope } from "./connector-scopes.ts";
import { tryLockInstance, type ConnectorManager } from "./connectors.ts";
import { addPage, emptyResult, storePage, type PageOptions } from "./page-store.ts";

export type ImportOptions = Pick<
  PageOptions,
  "runner" | "projections" | "clock" | "entries" | "onError"
> & {
  /** The configured Connector instances: an id of one of another kind is not this path's to bind. */
  connectors?: Pick<ConnectorManager, "list">;
};

/** What the route answers: the sync-shaped result, or the error code and nothing else. */
export type ImportOutcome =
  | SyncResponse
  | { error: Extract<ErrorResponse["error"], "bad-request" | "instance-busy" | "storage-failed"> };

export type InstanceImporter = (instanceId: string, content: string) => Promise<ImportOutcome>;

export async function importContent(
  db: SqlDriver,
  instanceId: string,
  content: string,
  options: ImportOptions = {},
): Promise<ImportOutcome> {
  // an instance bound to another kind is not this path's (V01's registerConnectorInstance rule);
  // nothing awaits between this check and the lock, so no sync can bind it meanwhile
  const kind = readConnectorKind(db, instanceId);
  if (kind !== undefined && kind !== JSONL_IMPORT_KIND) return { error: "bad-request" };
  // a configured Connector that never synced is not bound yet: its id is still its own
  const { connectors, ...pageOptions } = options;
  if (connectors?.list().some((c) => c.id === instanceId && c.kind !== JSONL_IMPORT_KIND)) {
    return { error: "bad-request" };
  }
  const release = tryLockInstance(db, instanceId);
  if (!release) return { error: "instance-busy" };
  try {
    const { lines, rejected } = parseJsonl(content);
    db.transaction(() => {
      registerConnectorInstance(db, instanceId, JSONL_IMPORT_KIND);
      applyConfiguredScope(db, instanceId); // the grade of its sources compares claims with it (I01-R15)
    });
    const stored = storePage(
      {
        db,
        instanceId,
        kind: JSONL_IMPORT_KIND,
        capabilities: JSONL_CAPABILITIES,
        options: pageOptions,
      },
      {
        changes: lines.map((l) => l.change),
        rejected: [],
        nextCursor: null,
        endsRescan: false,
      },
    );
    if ("stopped" in stored) return { error: stored.stopped };
    // the refusals as the file collector lists a page: the lines the parser refused, then the store's
    const all = [
      ...rejected.map((r) => ({ at: `line:${r.line}`, code: r.code })),
      ...stored.rejected,
    ];
    const result = emptyResult();
    addPage(result, { ...stored, rejected: all });
    return { connectorId: instanceId, ...result };
  } finally {
    release();
  }
}
