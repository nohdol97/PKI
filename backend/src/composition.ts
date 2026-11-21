// Composition point: the one place that picks adapter implementations for the
// product (V01-R15): the vector index, the canonical storage driver and the
// Connector kinds. Entry points (dev.ts, site-check.ts) build the backend from these.
import {
  dataDirectory,
  EmptyVectorIndex,
  ensureDataDirectory,
  migrate,
  openBetterSqlite3,
  type SqlDriver,
} from "@pki/storage";
import { join } from "node:path";
import type { ConnectorFactory, ConnectorInstanceConfig } from "./connectors.ts";
import { createFixtureConnector } from "./connectors/fixture-connector.ts";
import { createSiteConnector, SITE_CONNECTOR_KINDS } from "./connectors/site-connectors.ts";
import type { ServerOptions } from "./server.ts";

export function productAdapters(): Pick<ServerOptions, "vectorIndex"> {
  return { vectorIndex: new EmptyVectorIndex() };
}

export const CANONICAL_DB_FILE = "pki.sqlite";

export const connectorKinds = {
  "test-fixtures": createFixtureConnector,
  "site-mail": () => createSiteConnector("site-mail"),
  "site-messenger": () => createSiteConnector("site-messenger"),
  "site-wiki": () => createSiteConnector("site-wiki"),
} satisfies Record<string, ConnectorFactory>;

/** Opens the canonical SQLite inside `dir` (default: the per-user data directory), migrated. */
export function openCanonicalDb(dir: string = dataDirectory()): SqlDriver {
  ensureDataDirectory(dir);
  const db = openBetterSqlite3(join(dir, CANONICAL_DB_FILE));
  migrate(db);
  return db;
}

/**
 * One instance per site kind (listed as not implemented), plus the test
 * Connector when a synthetic fixtures file is given (development and tests).
 */
export function connectorInstances(fixturesFile?: string): ConnectorInstanceConfig[] {
  return [
    ...(fixturesFile
      ? [{ id: "fixtures", kind: "test-fixtures", config: { file: fixturesFile } }]
      : []),
    ...SITE_CONNECTOR_KINDS.map((kind) => ({ id: kind, kind, config: {} })),
  ];
}
