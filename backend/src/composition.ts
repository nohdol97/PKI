// Composition point: the one place that picks adapter implementations for the
// product (V01-R14, R15): the vector index, the embedder, the canonical storage
// driver, the Connector kinds, the egress policy and the Providers. Entry points
// (dev.ts, shell.ts, site-check.ts) build the backend from these.
import type { LLMProvider, ProviderId, SecretSource } from "@pki/contracts";
import { createEgressPolicy, PUBLIC_SITE_RULES, type EgressControls } from "@pki/providers";
import {
  createLocalEmbedder,
  LocalModelProvider,
  OpenAICompatibleProvider,
} from "@pki/providers/adapters";
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
 * `http` to a loopback endpoint stays refused until the build kind (T09) tells
 * development and test builds apart. The egress policy and the HTTP Provider read
 * the same flag, so the Provider never sends where the policy would refuse.
 */
const ALLOW_LOOPBACK_HTTP = false;

/**
 * The product's consent and egress rules (ADR 0014). The deployment rules are the
 * public repository's (none: nothing leaves without consent); a fork supplies its
 * own here (S08).
 */
export function productEgress(db: SqlDriver): EgressControls {
  return createEgressPolicy({
    db,
    siteRules: PUBLIC_SITE_RULES,
    allowLoopbackHttp: ALLOW_LOOPBACK_HTTP,
  });
}

/**
 * The Providers the product binds so far (V01-R11): the OpenAI-compatible one, whose
 * key `secrets` gives just before each call and which asks `egress` (the instance
 * the API and the Broker share) again just before sending, and the unimplemented
 * local model. The
 * CLI Providers (T10) join here; the Broker that calls them is bound by T09.
 */
export function productProviders(
  db: SqlDriver,
  secrets: SecretSource,
  egress: EgressControls,
): Partial<Record<ProviderId, LLMProvider>> {
  return {
    "openai-compatible": new OpenAICompatibleProvider({
      db,
      secrets,
      allowLoopbackHttp: ALLOW_LOOPBACK_HTTP,
      egress,
    }),
    "local-model": new LocalModelProvider(),
  };
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
