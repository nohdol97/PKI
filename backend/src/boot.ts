// Starts the backend on a data directory: the canonical DB, the Connectors and the API
// server with the product's adapters, egress controls and Broker (composition.ts). Shared by
// the two entries that differ only in how they hand over the session: dev.ts (stdout)
// and shell.ts (the Electron shell's parent channel).
import type { SqlDriver } from "@pki/storage";
import { join } from "node:path";
import {
  CANONICAL_DB_FILE,
  connectorInstances,
  connectorKinds,
  openCanonicalDb,
  productAdapters,
  productCalls,
  productEgress,
} from "./composition.ts";
import { createConnectorManager } from "./connectors.ts";
import { startServer, type RunningServer } from "./server.ts";

export interface BootOptions {
  /** Holds the canonical DB. */
  dataDir: string;
  /** Synthetic JSONL for the test Connector; without it there is none. */
  fixtures?: string | undefined;
  /** Fresh per run, handed over in-process by the entry. */
  token: string;
  allowedOrigins: readonly string[];
  /** 0 (default) picks a free port. */
  port?: number;
}

export async function bootBackend(
  options: BootOptions,
): Promise<{ server: RunningServer; db: SqlDriver }> {
  const db = openCanonicalDb(options.dataDir);
  const connectors = await createConnectorManager(
    db,
    connectorInstances(options.fixtures),
    connectorKinds,
  );
  // one egress instance for the consent API and the Broker (T08)
  const egress = productEgress(db);
  const server = await startServer({
    token: options.token,
    allowedOrigins: options.allowedOrigins,
    port: options.port ?? 0,
    ...productAdapters(),
    connectors,
    db,
    dataDirectory: options.dataDir,
    databaseFile: join(options.dataDir, CANONICAL_DB_FILE),
    egress,
    calls: productCalls(db, egress),
  });
  return { server, db };
}
