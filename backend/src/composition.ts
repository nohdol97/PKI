// Composition point: the one place that picks adapter implementations for the
// product (V01-R14, R15): the vector index, the embedder, the canonical storage
// driver, the Connector kinds, the egress policy, the Providers, the Broker
// with its execution gate, the job runner with its extract handler, and the
// KnowledgeEngine with the notifications to it and the vector index. Entry points (dev.ts, shell.ts through boot.ts,
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
  type Logger,
  type TestBuildExecution,
  type UserActionIssuer,
} from "@pki/providers";
import {
  createClaudeCodeProvider,
  createCodexProvider,
  createLocalEmbedder,
  OpenAICompatibleProvider,
  sweepStaleCliRuns,
} from "@pki/providers/adapters";
import {
  createExtractHandler,
  createProjections,
  EXTRACT_HOLD_TOO_LARGE,
  knowledgeCandidates,
  type Projections,
} from "@pki/knowledge-engine";
import { NullKnowledgeEngine } from "@pki/knowledge-engine/adapters";
import {
  dataDirectory,
  ensureDataDirectory,
  migrate,
  readSetting,
  requeueHeldJobs,
  writeSetting,
  type SqlDriver,
} from "@pki/storage";
import { EmptyVectorIndex, openBetterSqlite3 } from "@pki/storage/adapters";
import { join } from "node:path";
import {
  EXTRACT_JOB_KIND,
  type ConnectorFactory,
  type ConnectorInstanceConfig,
  type SyncOptions,
} from "./connectors.ts";
import { createJobRunner, type JobRunner, type RunnerTestBuild } from "./job-runner.ts";
import { importJsonl, type JsonlImporter } from "./jsonl-import.ts";
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

/** The product's KnowledgeEngine: none is plugged in during Phase 1 (ADR 0003). */
export function productEngine(): KnowledgeEngine {
  return new NullKnowledgeEngine();
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
}

/**
 * The Broker, the user action issuer and the bound Providers (V01-R8, R9, R10).
 * The ledger is made here once: the issuer goes to the API layer only, the
 * redeemer to the Broker only. The Broker gets `egress`, the same instance the
 * API serves consent from (T08) and the Providers ask again just before sending
 * (T11), and calls the user's default Provider, read for every call; without one
 * it calls none (provider-selection.ts, no fallback).
 */
export function productCalls(
  db: SqlDriver,
  egress: EgressControls,
  options: CallsOptions,
): { broker: Broker; issuer: UserActionIssuer; providers: readonly LLMProvider[] } {
  const { providers } = options;
  const ledger = createUserActionLedger();
  const broker = createBroker({
    db,
    provider: () => selectProvider(providers, readDefaultProvider(db)),
    userActions: ledger.redeemer,
    candidates: knowledgeCandidates(db),
    egress,
    // the pick reaches the gate in a test build only; folded away from any other
    execution: createExecutionGate(
      BUILD_KIND === "test" && options.testBuild !== undefined
        ? { db, testBuild: options.testBuild }
        : { db },
    ),
    recorder: createCallRecorder(db),
  });
  return { broker, issuer: ledger.issuer, providers };
}

/**
 * The job runner with the product's handlers (V02-R4, R6): extraction of each
 * stored version through `broker`, with origin {jobId, leaseToken} built from the
 * running job only, and the proposals of `engine` when it has the capability
 * (V02-R13). Errors are logged by class only.
 */
export function productRunner(
  db: SqlDriver,
  broker: Pick<Broker, "call">,
  options: {
    now?: () => Date;
    engine?: KnowledgeEngine;
    /** The engine's notifications; a stale engine is not asked for proposals. */
    projections?: Pick<Projections, "isStale">;
    /** The test build's lease, poll and test kinds (job-runner.ts); ignored by any other build. */
    testBuild?: RunnerTestBuild;
  } = {},
): JobRunner {
  const { now, engine, projections } = options;
  const handler = createExtractHandler({
    db,
    broker,
    ...(now ? { now } : {}),
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
    handlers: { [EXTRACT_JOB_KIND]: handler },
    ...(now ? { now } : {}),
    // folded away from any other build with the runner's own test branch (V01-T15)
    ...(BUILD_KIND === "test" && options.testBuild ? { testBuild: options.testBuild } : {}),
    onError: (error) => log("job-error", { error: errorClass(error) }),
  });
}

/** Hold reasons no setting, consent or rule change can lift. */
export const HELD_KEPT_REASONS: readonly string[] = [EXTRACT_HOLD_TOO_LARGE];

/**
 * Provisional (V02 미해결 질문 7): a condition that blocked held jobs may have
 * changed (the background setting, a consent, the endpoint, the default Provider), so they are queued
 * again in their own rows and the runner woken; the Broker judges them anew.
 */
export function releaseHeldJobs(db: SqlDriver, runner: Pick<JobRunner, "wake">): number {
  const released = requeueHeldJobs(db, { keep: HELD_KEPT_REASONS });
  if (released > 0) void runner.wake();
  return released;
}

/** The policy version held jobs were last judged under (a setting row, not user-editable through the API). */
export const HELD_POLICY_SETTING = "jobs.held-policy-version";

/**
 * At start: the deployment's egress rules are build values, so they change only
 * across a restart. When the policy version differs from the one recorded, held
 * jobs are released once and the new version recorded.
 */
export function releaseOnPolicyChange(
  db: SqlDriver,
  egress: Pick<EgressControls, "policyVersion">,
  runner: Pick<JobRunner, "wake">,
): number {
  const version = egress.policyVersion();
  if (readSetting(db, HELD_POLICY_SETTING) === version) return 0;
  const released = releaseHeldJobs(db, runner);
  writeSetting(db, HELD_POLICY_SETTING, version);
  return released;
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
  options: Pick<SyncOptions, "runner" | "projections"> & { logger?: Logger } = {},
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

/** Opens the canonical SQLite inside `dir` (default: the per-user data directory), migrated. */
export function openCanonicalDb(dir: string = dataDirectory()): SqlDriver {
  ensureDataDirectory(dir);
  const db = openBetterSqlite3(join(dir, CANONICAL_DB_FILE));
  migrate(db);
  return db;
}

/** One instance per site kind, listed as not implemented. */
export function connectorInstances(): ConnectorInstanceConfig[] {
  return SITE_CONNECTOR_KINDS.map((kind) => ({ id: kind, kind, config: {} }));
}
