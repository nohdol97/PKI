// Starts the backend on a data directory: the canonical DB, the Connectors, the
// Providers and the API server with the product's adapters and egress controls
// (composition.ts). Shared by the two entries that differ only in how they hand over
// the session and where secrets come from: dev.ts (stdout, environment) and shell.ts
// (the Electron shell's parent channel for both).
import type { LLMProvider, ProviderId, SecretSource } from "@pki/contracts";
import type { SqlDriver } from "@pki/storage";
import { join } from "node:path";
import {
  CANONICAL_DB_FILE,
  connectorInstances,
  connectorKinds,
  openCanonicalDb,
  productAdapters,
  productEgress,
  productProviders,
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
  /** Where Providers read their secrets just before a call; the backend keeps none. */
  secrets: SecretSource;
}

export interface BootedBackend {
  server: RunningServer;
  db: SqlDriver;
  /** Bound to the Broker by T09. */
  providers: Partial<Record<ProviderId, LLMProvider>>;
}

export async function bootBackend(options: BootOptions): Promise<BootedBackend> {
  const db = openCanonicalDb(options.dataDir);
  const connectors = await createConnectorManager(
    db,
    connectorInstances(options.fixtures),
    connectorKinds,
  );
  const server = await startServer({
    token: options.token,
    allowedOrigins: options.allowedOrigins,
    port: options.port ?? 0,
    ...productAdapters(),
    connectors,
    db,
    dataDirectory: options.dataDir,
    databaseFile: join(options.dataDir, CANONICAL_DB_FILE),
    egress: productEgress(db),
  });
  return { server, db, providers: productProviders(db, options.secrets) };
}
