// Composition point: the one place that picks adapter implementations for the
// product (V01-R14, R15): the vector index, the embedder, the canonical storage
// driver, the Connector kinds, the egress policy, the Providers and the Broker
// with its execution gate. Entry points (dev.ts, shell.ts through boot.ts,
// site-check.ts) build the backend from these.
import type { LLMProvider } from "@pki/contracts";
import {
  BUILD_KIND,
  createBroker,
  createCallRecorder,
  createEgressPolicy,
  createExecutionGate,
  createUserActionLedger,
  loopbackHttpAllowed,
  PUBLIC_SITE_RULES,
  type Broker,
  type EgressControls,
  type TestBuildExecution,
  type UserActionIssuer,
} from "@pki/providers";
import { createLocalEmbedder } from "@pki/providers/adapters";
import { dataDirectory, ensureDataDirectory, migrate, type SqlDriver } from "@pki/storage";
import { EmptyVectorIndex, openBetterSqlite3 } from "@pki/storage/adapters";
import { join } from "node:path";
import type { ConnectorFactory, ConnectorInstanceConfig } from "./connectors.ts";
import { createFixtureConnector } from "./adapters/fixture-connector.ts";
import { createSiteConnector, SITE_CONNECTOR_KINDS } from "./adapters/site-connectors.ts";
import type { ServerOptions } from "./server.ts";

/**
 * The product's adapters inside a data directory. The embedder is the local
 * Transformers.js one; its models install under `<dataDir>/models` only when the
 * user prepares one, so binding it creates nothing and downloads nothing.
 */
export function productAdapters(dataDir: string): Pick<ServerOptions, "vectorIndex" | "embedder"> {
  return {
    vectorIndex: new EmptyVectorIndex(),
    embedder: createLocalEmbedder(join(dataDir, MODELS_DIR)),
  };
}

export const MODELS_DIR = "models";

/**
 * The product's consent and egress rules (ADR 0014). The deployment rules are the
 * public repository's (none: nothing leaves without consent); a fork supplies its
 * own here (S08). `http` to a loopback endpoint passes in development and test
 * builds only, by the build kind (V01-R11).
 */
export function productEgress(db: SqlDriver): EgressControls {
  return createEgressPolicy({
    db,
    siteRules: PUBLIC_SITE_RULES,
    allowLoopbackHttp: loopbackHttpAllowed(BUILD_KIND),
  });
}

/** The Provider implementations the product binds: none until V01-T10 (CLI) and T11 (API key). */
export function productProviders(): readonly LLMProvider[] {
  return [];
}

export interface CallsOptions {
  /** Default productProviders(); tests bind doubles here. */
  providers?: readonly LLMProvider[];
  /** The test build's pick and list (execution-gate.ts); ignored by any other build. */
  testBuild?: TestBuildExecution;
}

/**
 * The Broker and the user action issuer (V01-R8, R10). The ledger is made here
 * once: the issuer goes to the API layer only, the redeemer to the Broker only.
 * The Broker gets `egress`, the same instance the API serves consent from (T08).
 * Provisional: with one Provider bound it is the one called; with none or
 * several, none is (the user's default choice is V01-T10's; no silent fallback).
 */
export function productCalls(
  db: SqlDriver,
  egress: EgressControls,
  options: CallsOptions = {},
): { broker: Broker; issuer: UserActionIssuer } {
  const providers = options.providers ?? productProviders();
  const ledger = createUserActionLedger();
  const broker = createBroker({
    db,
    provider: () => (providers.length === 1 ? providers[0] : undefined),
    userActions: ledger.redeemer,
    candidates: { lookup: () => undefined }, // V02 attaches the knowledge store
    egress,
    execution: createExecutionGate(
      options.testBuild === undefined ? { db } : { db, testBuild: options.testBuild },
    ),
    recorder: createCallRecorder(db),
  });
  return { broker, issuer: ledger.issuer };
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
