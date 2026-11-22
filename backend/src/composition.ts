// Composition point: the one place that picks adapter implementations for the
// product (V01-R14, R15): the vector index, the embedder, the canonical storage
// driver, the Connector kinds, the egress policy, the Providers, the Broker
// with its execution gate, the job runner with its extract handler, and the
// KnowledgeEngine with the notifications to it and the vector index, and the derivative registry
// with the entries that run it (I04-T04). Entry points (dev.ts, shell.ts through boot.ts,
// site-check.ts) build the backend from these.
import type {
  EmbeddingProvider,
  KnowledgeEngine,
  LLMProvider,
  SecretSource,
  VectorIndex,
} from "@pki/contracts";
import {
  BUILD_KIND,
  createBroker,
  createCallRecorder,
  createEgressPolicy,
  createExecutionGate,
  createUserActionLedger,
  errorClass,
  log,
  loopbackHttpAllowed,
  PUBLIC_SITE_RULES,
  readDefaultProvider,
  selectProvider,
  type Broker,
  type EgressControls,
  type ExecutionGate,
  type Logger,
  type TestBuildExecution,
  type UserActionIssuer,
  VERIFIED_CLI_COMBINATIONS,
} from "@pki/providers";
import {
  createClaudeCodeProvider,
  createCodexProvider,
  createLocalEmbedder,
  OpenAICompatibleProvider,
  sweepStaleCliRuns,
} from "@pki/providers/adapters";
import {
  createCanonicalEntries,
  createExtractHandler,
  createProductRegistry,
  createProjections,
  derivativeRegistry,
  ENGINE_KIND,
  knowledgeCandidates,
  VECTOR_KIND,
  type CanonicalEntries,
  type PermanentlyAbsent,
  type Projections,
} from "@pki/knowledge-engine";
import { createVisibleEngine, NullKnowledgeEngine } from "@pki/knowledge-engine/adapters";
import {
  createCommitScope,
  dataDirectory,
  defaultScopePolicy,
  ensureDataDirectory,
  prepareCanonicalDb,
  type DerivativeRegistry,
  type ScopePolicy,
  type SqlDriver,
} from "@pki/storage";
import { EmptyVectorIndex, openBetterSqlite3 } from "@pki/storage/adapters";
import { join } from "node:path";
import {
  EXTRACT_JOB_KIND,
  type ConnectorFactory,
  type ConnectorInstanceConfig,
  type ConnectorManager,
  type SyncOptions,
} from "./connectors.ts";
import type { Clock } from "./clock.ts";
import {
  CONNECTOR_SYNC_KIND,
  createConnectorSyncHandler,
  type SyncManager,
} from "./connector-sync-job.ts";
import { computePolicyFingerprint } from "./held-release.ts";
import { attachDirectoryLedger, readLedgerKey } from "./ledger-boot.ts";
import { createJobRunner, type JobRunner, type RunnerTestBuild } from "./job-runner.ts";
import { createMaintenanceHandler } from "./maintenance.ts";
import { MAINTENANCE_KIND } from "./scheduler.ts";
import { projectionPorts } from "./projection-ports.ts";
import { importContent, type InstanceImporter } from "./imports.ts";
import { importJsonl, type JsonlImporter } from "./jsonl-import.ts";
import {
  projectionHandlers,
  PROJECTION_KIND_SETTINGS,
  type ProjectionPorts,
} from "./projection-jobs.ts";
import { createFixtureConnector } from "./adapters/fixture-connector.ts";
import { createJsonlConnector } from "./adapters/jsonl-connector.ts";
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
 * The implementations that never hold anything: the ones `productRegistry` marks `permanentlyAbsent`
 * (by `instanceof`) and that derivative-coverage.ts checks no real adapter subclasses.
 */
export const NULL_IMPLEMENTATIONS = {
  [ENGINE_KIND]: NullKnowledgeEngine,
  [VECTOR_KIND]: EmptyVectorIndex,
} as const;

/** The product's KnowledgeEngine: none is plugged in during Phase 1 (ADR 0003). */
export function productEngine(): KnowledgeEngine {
  return new NullKnowledgeEngine();
}

/**
 * The derivative registry of the product (I04-R1): the seven canonical kinds and the two projections, the
 * one place that builds it. `permanentlyAbsent` is the implementations' own, static fact: the null
 * engine and the empty vector index never hold anything, so an unavailable error from them ends a
 * removal as a skip; any other implementation (a sidecar that may be stopped) does not carry it.
 * `policy` is the scope policy the deployment chose (productScopePolicy); the default when none.
 */
export function productRegistry(adapters: {
  engine: KnowledgeEngine;
  vectorIndex: VectorIndex;
  policy?: ScopePolicy;
}): DerivativeRegistry {
  const permanentlyAbsent: PermanentlyAbsent = {
    ...(adapters.engine instanceof NullKnowledgeEngine ? { [ENGINE_KIND]: true as const } : {}),
    ...(adapters.vectorIndex instanceof EmptyVectorIndex ? { [VECTOR_KIND]: true as const } : {}),
  };
  return createProductRegistry({
    policy: adapters.policy ?? defaultScopePolicy,
    permanentlyAbsent,
  });
}

/** The entries that store a change, delete a source or lift a tombstone through `registry`. */
export function productEntries(registry: DerivativeRegistry): CanonicalEntries {
  return createCanonicalEntries(registry);
}

/**
 * The engine as the backend holds it (I04-R13): wrapped by the registry, so `relatedContext` shows
 * only what `visible` allows. Everything that takes the product's engine takes this one.
 */
export function productVisibleEngine(
  db: SqlDriver,
  registry: DerivativeRegistry,
  engine: KnowledgeEngine,
): KnowledgeEngine {
  return createVisibleEngine(engine, { db, registry });
}

/**
 * The registered projection kinds as the ports the runner's `projection-remove` and
 * `projection-rebuild` handlers run (I03-T10, I04-T04): one per kind of `registry`.
 */
export function productProjectionPorts(
  db: SqlDriver,
  registry: DerivativeRegistry,
  adapters: { engine: KnowledgeEngine; vectorIndex: VectorIndex },
  projections: Pick<Projections, "rebuild">,
): ProjectionPorts {
  return projectionPorts({ registry, db, ...adapters, projections });
}

/**
 * The notifications to the engine and the vector index and their start-up
 * comparison (V02-R13). A vector index rebuild resets to the embedder's model.
 * Errors are logged by class only.
 */
export function productProjections(
  db: SqlDriver,
  adapters: {
    engine: KnowledgeEngine;
    vectorIndex: VectorIndex;
    embedder: Pick<EmbeddingProvider, "describe"> | null;
  },
): Projections {
  const { engine, vectorIndex, embedder } = adapters;
  return createProjections({
    db,
    engine,
    vectorIndex,
    embeddingSpace: () => {
      if (!embedder) return null;
      const { modelId, revision, dimension } = embedder.describe();
      return { modelId, revision, dimension };
    },
    onError: (projection, error) =>
      log("projection-error", { projection, error: errorClass(error) }),
  });
}

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

/**
 * The Provider implementations the Broker may call (V01-R9, R11): the two CLI
 * Providers (V01-T10) and the OpenAI-compatible one (V01-T11). The Broker calls
 * only the user's default among them (productCalls). Binding runs nothing: a CLI
 * is looked up and queried only when the user checks Providers or a call is made.
 * The OpenAI-compatible Provider's key comes from `secrets` just before each call,
 * and it asks `egress` (the instance the API and the Broker share) again just before
 * sending. The local-model Provider is not bound: it only answers "not implemented"
 * and reports no structured output, so the Broker could never use it.
 */
export function productProviders(
  db: SqlDriver,
  secrets: SecretSource,
  egress: EgressControls,
  /** The CLI run folders' root, inside the data directory (cliRunsRoot); default per-run temp. */
  cliRuns?: string,
): readonly LLMProvider[] {
  const cli = cliRuns === undefined ? {} : { runsRoot: cliRuns };
  return [
    createClaudeCodeProvider(cli),
    createCodexProvider(cli),
    new OpenAICompatibleProvider({
      db,
      secrets,
      allowLoopbackHttp: loopbackHttpAllowed(BUILD_KIND),
      egress,
    }),
  ];
}

/** At start: removes CLI run folders a crashed or killed backend left (V01-T10). */
export async function sweepCliRuns(dataDir: string): Promise<void> {
  await sweepStaleCliRuns(cliRunsRoot(dataDir));
}

/**
 * Where CLI runs make their temporary folders: inside the data directory the
 * backend owns (V01-T10), not a shared temp folder another user could pre-create.
 */
export function cliRunsRoot(dataDir: string): string {
  return join(dataDir, CLI_RUNS_DIR);
}

export const CLI_RUNS_DIR = "cli-runs";

export interface CallsOptions {
  /** The Providers to bind: productProviders(...) in the product, doubles in tests. */
  providers: readonly LLMProvider[];
  /** The test build's pick and list (execution-gate.ts); ignored by any other build. */
  testBuild?: TestBuildExecution;
  /**
   * The registry that names the sources of a derivative input (a candidate item) for the
   * Broker's grade (I04-R16); default the entries' own (productRegistry in the product).
   */
  registry?: DerivativeRegistry;
}

/**
 * The Broker, the user action issuer, the bound Providers and the execution gate
 * (V01-R8, R9, R10). The ledger is made here once: the issuer goes to the API layer
 * only, the redeemer to the Broker only. The gate is made here once too: the
 * Broker decides every attempt with it, and the API layer asks the same instance
 * for Home's status (V01-T17), so no second copy of the rule exists. The Broker gets `egress`, the same instance the
 * API serves consent from (T08) and the Providers ask again just before sending
 * (T11), and calls the user's default Provider, read for every call; without one
 * it calls none (provider-selection.ts, no fallback).
 */
export function productCalls(
  db: SqlDriver,
  egress: EgressControls,
  options: CallsOptions,
): {
  broker: Broker;
  issuer: UserActionIssuer;
  providers: readonly LLMProvider[];
  execution: ExecutionGate;
  /** What a held job is stamped with and a start compares (I03-R16 ③). */
  policyFingerprint: () => string;
} {
  const { providers } = options;
  const ledger = createUserActionLedger();
  // the pick reaches the gate in a test build only; folded away from any other
  const execution = createExecutionGate(
    BUILD_KIND === "test" && options.testBuild !== undefined
      ? { db, testBuild: options.testBuild }
      : { db },
  );
  const broker = createBroker({
    db,
    provider: () => selectProvider(providers, readDefaultProvider(db)),
    userActions: ledger.redeemer,
    candidates: knowledgeCandidates(db, options.registry ?? derivativeRegistry),
    egress,
    execution,
    recorder: createCallRecorder(db),
  });
  // the verified list the gate decides with: the test build's own, else the build's
  const verified =
    BUILD_KIND === "test" && options.testBuild?.verified !== undefined
      ? options.testBuild.verified
      : VERIFIED_CLI_COMBINATIONS;
  const policyFingerprint = () =>
    computePolicyFingerprint({
      policyVersion: egress.policyVersion(),
      verified,
      defaultProvider: readDefaultProvider(db),
    });
  return { broker, issuer: ledger.issuer, providers, execution, policyFingerprint };
}

/**
 * The job runner with the product's handlers (V02-R4, R6): extraction of each
 * stored version through `broker`, with origin {jobId, leaseToken} built from the
 * running job only, and the proposals of `engine` when it has the capability
 * (V02-R13). Errors are logged by class only.
 */
export function productRunner(
  db: SqlDriver,
  broker: Pick<Broker, "call" | "budgetUsage">,
  options: {
    /** The runner's clock (job-runner.ts); it also dates what an extraction observed. */
    clock?: Clock;
    engine?: KnowledgeEngine;
    /** The engine's notifications; a stale engine is not asked for proposals. */
    projections?: Pick<Projections, "isStale">;
    /** The test build's lease, poll and test kinds (job-runner.ts); ignored by any other build. */
    testBuild?: RunnerTestBuild;
    /** Stamped on a job the Broker held (productCalls). */
    policyFingerprint?: () => string;
    /**
     * The registered projection kinds as ports (productProjectionPorts): given, the runner also runs
     * `projection-remove` and `projection-rebuild` (projection-jobs.ts); none, those jobs wait.
     */
    projectionPorts?: ProjectionPorts;
    /**
     * The Connector manager the `connector-sync` handler calls, read at each run (the manager
     * is made after the runner, as it wakes it; I03-T09). Given, the runner also runs
     * `connector-sync`; none, those jobs wait.
     */
    connectors?: () => SyncManager | undefined;
    /** The registry that names a candidate item's lineage (productRegistry); default `derivativeRegistry` (knowledge-engine canonical-kinds.ts). */
    registry?: DerivativeRegistry;
  } = {},
): JobRunner {
  const { clock, engine, projections } = options;
  // the registry's policy judges the commit too (I04-R11, R14): one policy for the candidates, the rule and the write
  const scope = createCommitScope({
    policy: (options.registry ?? derivativeRegistry).policy,
    ...(clock ? { now: () => new Date(clock.now()).toISOString() } : {}),
  });
  const handler = createExtractHandler({
    db,
    ...(options.registry ? { registry: options.registry } : {}),
    ...(clock ? { now: () => new Date(clock.now()) } : {}),
    ...(engine
      ? {
          engine,
          onEngineError: (error: unknown) => log("engine-error", { error: errorClass(error) }),
          ...(projections ? { isEngineStale: () => projections.isStale("engine") } : {}),
        }
      : {}),
  });
  return createJobRunner({
    db,
    handlers: {
      [EXTRACT_JOB_KIND]: handler,
      [MAINTENANCE_KIND]: createMaintenanceHandler({ db, ...(clock ? { clock } : {}) }),
      ...(options.connectors
        ? { [CONNECTOR_SYNC_KIND]: createConnectorSyncHandler({ db, manager: options.connectors }) }
        : {}),
      ...(options.projectionPorts
        ? projectionHandlers({
            db,
            ports: options.projectionPorts,
            ...(clock ? { now: () => new Date(clock.now()) } : {}),
            onError: (error) => log("projection-job-error", { error: errorClass(error) }),
          })
        : {}),
    },
    kinds: PROJECTION_KIND_SETTINGS,
    scope,
    broker,
    ...(clock ? { clock } : {}),
    ...(options.policyFingerprint ? { policyFingerprint: options.policyFingerprint } : {}),
    // folded away from any other build with the runner's own test branch (V01-T15)
    ...(BUILD_KIND === "test" && options.testBuild ? { testBuild: options.testBuild } : {}),
    onError: (error) => log("job-error", { error: errorClass(error) }),
  });
}

export const CANONICAL_DB_FILE = "pki.sqlite";

/** The product's Connector kinds: the site kinds, listed as not implemented (V01-R18). */
export const connectorKinds = {
  "site-mail": () => createSiteConnector("site-mail"),
  "site-messenger": () => createSiteConnector("site-messenger"),
  "site-wiki": () => createSiteConnector("site-wiki"),
} satisfies Record<string, ConnectorFactory>;

/**
 * Source runs and tests only (dev.ts, shell-options.ts): the product's kinds plus
 * the test Connector. Nothing in the production build calls it, so the bundle
 * leaves the test Connector out (V01-T15, "T04가 넘기는 것" ③). A function, not a
 * constant: an unused object spread is kept by the bundler as a possible side effect.
 */
export function fixtureConnectorKinds() {
  return {
    ...connectorKinds,
    "test-fixtures": createFixtureConnector,
  } satisfies Record<string, ConnectorFactory>;
}

/** The Connector instances a backend starts with and the kinds that build them. */
export interface ConnectorSet {
  instances: ConnectorInstanceConfig[];
  kinds: Record<string, ConnectorFactory>;
}

/** The product's: one instance per site kind. */
export function productConnectors(): ConnectorSet {
  return { instances: connectorInstances(), kinds: connectorKinds };
}

/** A source run's (development and tests): the product's plus the test Connector replaying `file`. */
export function fixtureConnectors(file: string): ConnectorSet {
  return {
    instances: [
      { id: "fixtures", kind: "test-fixtures", config: { file } },
      ...connectorInstances(),
    ],
    kinds: fixtureConnectorKinds(),
  };
}

/**
 * The Sources screen's JSONL import (V02-R2). `projections` (productProjections)
 * are notified after each page commits and `runner` (productRunner) woken after
 * each page that registered extraction jobs. An instance whose sync failed
 * is logged by its error class (default: the backend's filtered log).
 */
export function productImporter(
  db: SqlDriver,
  options: Pick<SyncOptions, "runner" | "projections" | "clock" | "entries"> & {
    logger?: Logger;
    connectors?: Pick<ConnectorManager, "list">;
  } = {},
): JsonlImporter {
  const { logger = log, ...sync } = options;
  return (text) =>
    importJsonl(db, text, {
      ...sync,
      createConnector: createJsonlConnector,
      // the class only: a message can carry the file's text (V01-R13)
      onError: (error) => logger("import-instance-failed", { error: errorClass(error) }),
    });
}

/**
 * The local import API's importer (I01-R24): `productImporter`'s options, one instance and
 * one text per call. Its lock is the one every sync of `db` takes, so it must be the
 * same database object as the Connector manager's.
 */
export function productInstanceImporter(
  db: SqlDriver,
  options: Pick<SyncOptions, "runner" | "projections" | "clock" | "entries"> & {
    logger?: Logger;
    connectors?: Pick<ConnectorManager, "list">;
  } = {},
): InstanceImporter {
  const { logger = log, ...sync } = options;
  return (instanceId, content) =>
    importContent(db, instanceId, content, {
      ...sync,
      // the class only: a message can carry the text's content (V01-R13)
      onError: (error) => logger("import-storage-failed", { error: errorClass(error) }),
    });
}

/** Opens the canonical SQLite inside `dir` (default: the per-user data directory), migrated and prepared
 * (identity key, hashed identities, one clean-up: I04-R6, R7). */
export function openCanonicalDb(dir: string = dataDirectory()): SqlDriver {
  ensureDataDirectory(dir);
  const db = openBetterSqlite3(join(dir, CANONICAL_DB_FILE));
  // a failed clean-up does not stop the start: it stays `pending` in the status API
  // (dataProtection) and is tried again at the next start; the missing-key error
  // propagates and no backend starts (the shell logs its class)
  // an I04-before database takes the ledger's key before the migration's own is used (I04-R17)
  const ledgerKey = readLedgerKey(dir);
  if (prepareCanonicalDb(db, { ledgerKey }).legacyCleanup === "failed") {
    log("legacy-cleanup-failed", {});
  }
  // from here every canonical transaction that queues a deletion writes its line first
  attachDirectoryLedger(db, dir);
  return db;
}

/** One instance per site kind, listed as not implemented. */
export function connectorInstances(): ConnectorInstanceConfig[] {
  return SITE_CONNECTOR_KINDS.map((kind) => ({ id: kind, kind, config: {} }));
}
