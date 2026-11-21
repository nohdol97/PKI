// Starts the backend on a data directory: the canonical DB, the Connectors, the
// Providers, the Broker, the job runner and the API server with the product's
// adapters and egress controls (composition.ts). Closing the server stops the
// runner too, after the job it is running closes. Shared by the two entries that differ only in how they
// hand over the session and where secrets come from: dev.ts (stdout, environment)
// and shell.ts (the Electron shell's parent channel for both).
import type { LLMProvider, SecretSource } from "@pki/contracts";
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
  productImporter,
  productProviders,
  productRunner,
  releaseHeldJobs,
  releaseOnPolicyChange,
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
  /** The Providers the Broker may call (productProviders). */
  providers: readonly LLMProvider[];
}

export async function bootBackend(options: BootOptions): Promise<BootedBackend> {
  const db = openCanonicalDb(options.dataDir);
  // one egress instance for the consent API, the Broker (T08) and the Providers (T11)
  const egress = productEgress(db);
  const providers = productProviders(db, options.secrets, egress);
  const calls = productCalls(db, egress, { providers });
  const runner = productRunner(db, calls.broker);
  const connectors = await createConnectorManager(
    db,
    connectorInstances(options.fixtures),
    connectorKinds,
    { runner },
  );
  const server = await startServer({
    token: options.token,
    allowedOrigins: options.allowedOrigins,
    port: options.port ?? 0,
    ...productAdapters(options.dataDir),
    connectors,
    db,
    dataDirectory: options.dataDir,
    databaseFile: join(options.dataDir, CANONICAL_DB_FILE),
    egress,
    secrets: options.secrets,
    calls,
    importer: productImporter(db, { runner }),
    onRunConditionsChanged: () => void releaseHeldJobs(db, runner),
  });
  releaseOnPolicyChange(db, egress, runner);
  runner.start();
  return {
    server: {
      ...server,
      close: async () => {
        await server.close();
        await runner.stop();
      },
    },
    db,
    providers,
  };
}
