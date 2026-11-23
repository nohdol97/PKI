// Composition point: the one place that picks adapter implementations for the
// product (V01-R14, R15): the vector index, the embedder, the canonical storage
// driver, the Connector kinds, the egress policy, the Providers, the Broker
// with its execution gate, the job runner with its extract handler, and the
// KnowledgeEngine with the notifications to it and the vector index, and the derivative registry
// with the entries that run it (I04-T04). Entry points (dev.ts, shell.ts through boot.ts,
// site-check.ts) build the backend from these.
import type {
  EmbeddingProvider,
  EmbeddingSpace,
  KnowledgeEngine,
  LLMProvider,
  LocalNormalizerPort,
  LocalPassReport,
  LocalSkipReason,
  SecretSource,
  VectorIndex,
} from "@pki/contracts";
import {
  createForkSpawner,
  createIsolatedNormalizer,
  NORMALIZER_VERSION,
  type HostSpawner,
  type IsolatedErrorCode,
} from "@pki/document-normalize";
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
  publicScopeGrading,
  readDefaultProvider,
  selectProvider,
  denyExternalEmbedding,
  embedWithinPolicy,
  type Broker,
  type EgressControls,
  type ExecutionGate,
  type Logger,
  type ScopeGrading,
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
  candidatesReceiver,
  conflictsReceiver,
  createCanonicalEntries,
  createAnalyticalCheckHandler,
  createDatasetProfileHandler,
  createExtractHandler,
  createProductRegistry,
  createProjections,
  createReflectHandler,
  createReflectionRefineHandler,
  createWikiBuildHandler,
  createInsightInterpretHandler,
  createWikiSummaryHandler,
  insightsReceiver,
  derivativeRegistry,
  ENGINE_KIND,
  knowledgeCandidates,
  VECTOR_KIND,
  createNotifyHandler,
  type CanonicalEntries,
  type PermanentlyAbsent,
  type Projections,
} from "@pki/knowledge-engine";
import { createVisibleEngine, NullKnowledgeEngine } from "@pki/knowledge-engine/adapters";
import {
  createCommitScope,
  closeLocation,
  createLocalFileIndex,
  reopenLocation,
  createUserDecisions,
  ANALYTICAL_CHECK_JOB_KIND,
  DATASET_PROFILE_KIND,
  dataDirectory,
  defaultScopePolicy,
  LOCAL_FILES_INSTANCE_ID,
  ensureDataDirectory,
  onMembershipChanged,
  listLocations,
  readLocation,
  prepareCanonicalDb,
  INSIGHT_INTERPRET_KIND,
  requestInsightInterpretations,
  requestWikiBuild,
  requestWikiSummaries,
  REFLECT_JOB_KIND,
  REFLECTION_REFINE_KIND,
  requestReflectionRefinements,
  WIKI_BUILD_KIND,
  WIKI_SUMMARY_KIND,
  NOTIFY_JOB_KIND,
  type DerivativeRegistry,
  type MembershipListener,
  type ScopePolicy,
  type OpenSqlDriver,
  type SqlDriver,
  type UserDecisions,
} from "@pki/storage";
import { EmptyVectorIndex, openBetterSqlite3, SqliteVectorIndex } from "@pki/storage/adapters";
import { JSONL_IMPORT_KIND } from "@pki/connector-sdk";
import { join } from "node:path";
import {
  EXTRACT_JOB_KIND,
  type ConnectorFactory,
  type ConnectorInstanceConfig,
  type ConnectorManager,
  type SyncOptions,
} from "./connectors.ts";
import { withAskQuestions } from "./ask-questions.ts";
import type { Clock } from "./clock.ts";
import {
  CONNECTOR_SYNC_KIND,
  CONNECTOR_SYNC_SETTINGS,
  createConnectorSyncHandler,
  releaseIfReady,
  replacedKey,
  type SyncManager,
} from "./connector-sync-job.ts";
import { computePolicyFingerprint } from "./held-release.ts";
import { attachDirectoryLedger, readLedgerKey } from "./ledger-boot.ts";
import { createJobRunner, type JobRunner, type RunnerTestBuild } from "./job-runner.ts";
import { createMaintenanceHandler } from "./maintenance.ts";
import { MAINTENANCE_KIND } from "./scheduler.ts";
import { projectionPorts } from "./projection-ports.ts";
import { servedVectorIndex } from "./vector-serving.ts";
import { importContent, type InstanceImporter } from "./imports.ts";
import { importJsonl, type JsonlImporter } from "./jsonl-import.ts";
import {
  projectionHandlers,
  PROJECTION_KIND_SETTINGS,
  requestProjectionRebuild,
  type ProjectionPorts,
} from "./projection-jobs.ts";
import { createFixtureConnector } from "./adapters/fixture-connector.ts";
import { createJsonlConnector, type JsonlFilePorts } from "./adapters/jsonl-connector.ts";
import type { JsonlFileHooks } from "./jsonl-file-instances.ts";
import {
  createLocalFilesConnector,
  isDocumentFileName,
  type LocalFilesPorts,
} from "./adapters/local-files-connector.ts";
import {
  createApprovalTickets,
  createLocalLocations,
  readLocalFilesSettings,
  type ApprovalTickets,
  type LocalLocations,
} from "./local-locations.ts";
import { createLocalRevoke, type LocalRevoke } from "./local-revoke.ts";
import { createSiteConnector } from "./adapters/site-connectors.ts";
import { SITE_CONNECTOR_KINDS } from "./public-kinds.ts";
import type { ServerOptions } from "./server.ts";

/**
 * The product's adapters inside a data directory. The embedder is the local
 * Transformers.js one; its models install under `<dataDir>/models` only when the
 * user prepares one, so binding it creates nothing and downloads nothing. The vector index is the empty
 * one unless `vectorIndexing` (BootOptions, H01C3-R11) binds the real one in `<dataDir>/vectors`.
 */
export function productAdapters(
  dataDir: string,
  options: { vectorIndexing?: boolean } = {},
): Pick<ServerOptions, "vectorIndex" | "embedder"> {
  return {
    vectorIndex: options.vectorIndexing
      ? new SqliteVectorIndex(join(dataDir, VECTORS_DIR, VECTOR_INDEX_FILE), openBetterSqlite3)
      : new EmptyVectorIndex(),
    embedder: createLocalEmbedder(join(dataDir, MODELS_DIR)),
  };
}

export const MODELS_DIR = "models";
/** The real vector index's folder in the data directory: a projection, removed at a start without `vectorIndexing`. */
export const VECTORS_DIR = "vectors";
const VECTOR_INDEX_FILE = "index.sqlite";

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
 * The receivers of a changed membership (S02-R13): a fixed list, in the order they run, that a merge, an
 * unmerge, a group resting or waking and a split announce to in their own transaction. Both users of the
 * list, the user's entry and the derivative kind `entity-merge`, are built from this one constant. A receiver
 * deletes or recomputes what rests on an item and never throws in a deletion's propagation (a throw rolls
 * that propagation back). The conflicts' (S02-T08, the links of the slots of the groups reached) is first, because
 * the rule reads supersession in the same transaction; then the rule's (the Insight, S02-T05), then S03's (erases check lines
 * and queues the check job, S03-T05), then the candidates' (S02-T06, recomputes the candidates of the groups
 * reached).
 */
export const MEMBERSHIP_LISTENERS: readonly MembershipListener[] = Object.freeze([
  conflictsReceiver,
  insightsReceiver,
  onMembershipChanged,
  candidatesReceiver,
]);

/**
 * The derivative registry of the product (I04-R1): the ten canonical kinds and the two projections, the
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
    ...(adapters.vectorIndex instanceof SqliteVectorIndex
      ? { projectionDataPaths: { [VECTOR_KIND]: [VECTORS_DIR] } }
      : {}),
    membershipListeners: MEMBERSHIP_LISTENERS,
  });
}

/**
 * The user's entry to the Semantic registry (S01-R7): the one value that approves, rejects, disputes and
 * undoes. It goes to the API layer alone (boot.ts passes it to startServer); the module-boundary lint
 * keeps extraction, propagation and the job runner from importing it.
 */
export function productUserDecisions(
  registry: Pick<DerivativeRegistry, "combinable">,
): UserDecisions {
  return createUserDecisions({
    combinable: (db, lineage) => registry.combinable(db, lineage),
    listeners: MEMBERSHIP_LISTENERS,
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

function embedderSpace(
  embedder: Pick<EmbeddingProvider, "describe"> | null,
): EmbeddingSpace | null {
  if (!embedder) return null;
  const { modelId, revision, dimension } = embedder.describe();
  return { modelId, revision, dimension };
}

/** The vector index as the server reads it: the bound one with the stale mark and the embedding space laid over its status (H01C3-R8). */
export function productServedVectorIndex(
  adapters: { vectorIndex: VectorIndex; embedder: Pick<EmbeddingProvider, "describe"> | null },
  projections: Pick<Projections, "isStale">,
): VectorIndex {
  return servedVectorIndex(adapters.vectorIndex, {
    isStale: () => projections.isStale(VECTOR_KIND),
    embeddingSpace: () => embedderSpace(adapters.embedder),
  });
}

/**
 * The notifications to the engine and the vector index and their start-up
 * comparison (V02-R13). A vector index rebuild builds in the embedder's model. With `vectorIndexing`
 * the vector write path is bound (H01C3): documents reach the embedder only through the embedding
 * egress policy, and a start that finds the index behind registers a `projection-rebuild` job instead
 * of embedding. Errors are logged by class only.
 */
export function productProjections(
  db: SqlDriver,
  adapters: {
    engine: KnowledgeEngine;
    vectorIndex: VectorIndex;
    embedder: EmbeddingProvider | null;
  },
  options: { vectorIndexing?: boolean } = {},
): Projections {
  const { engine, vectorIndex, embedder } = adapters;
  return createProjections({
    db,
    engine,
    vectorIndex,
    embeddingSpace: () => embedderSpace(embedder),
    ...(options.vectorIndexing && embedder
      ? {
          vectors: {
            embed: (texts, signal) =>
              embedWithinPolicy(embedder, denyExternalEmbedding, texts, "document", signal),
            requestRebuild: (name) => void requestProjectionRebuild(db, name),
          },
        }
      : {}),
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
  /** The mapping scope -> class (I01-R15); a test build's own, else the public repository's. Honoured in a test build only. */
  scopeGrading?: ScopeGrading;
  /** The deployment's mapping, from its registration (I05-R14, S08): used in every build, before the test build's own. */
  siteScopeGrading?: ScopeGrading;
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
    candidates: withAskQuestions(knowledgeCandidates(db, options.registry ?? derivativeRegistry)),
    egress,
    execution,
    recorder: createCallRecorder(db),
    // a claimed scope is compared by the registry's policy, the one every other scope judgment
    // uses; the mapping scope -> class is the registration's, else a test build's own, else the public
    // repository's (I05-R14, S08)
    scope: {
      policy: (options.registry ?? derivativeRegistry).policy,
      grading:
        options.siteScopeGrading ??
        (BUILD_KIND === "test" && options.scopeGrading ? options.scopeGrading : publicScopeGrading),
    },
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
    /** Called after a job closed, with its kind and what the close answered (P02: wakes the notification scan, flushes the OS channel). */
    onJobClosed?: (job: { kind: string }, status: string) => void;
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
  const replaced = new Set<string>();
  const runner: JobRunner = createJobRunner({
    db,
    // a collector job whose sync stopped on a replaced object goes back at once, on the new one (I06-R10)
    onRunEnded: (job) => void replaced.delete(replacedKey(job)), // a mark does not outlive its run
    onClosed: (job, status) => {
      // K01-R5: a job that closed may have left the Wiki's pages behind: queue the one build; the drain claims it
      const built = requestWikiBuild(db).status === "registered";
      // K01-R12: pages whose summary is not of their content get a job; the one that closed may have left some
      const summaries = requestWikiSummaries(db) > 0;
      // P01-R7: Insights whose content changed (or that were never read) get an interpretation job, setting on only
      const interpretations = requestInsightInterpretations(db) > 0;
      // K02-R16: a `weekly` re-review that finished leaves open findings; with the setting on they get an opinion job
      const refinements =
        job.kind === REFLECT_JOB_KIND &&
        job.target === "weekly" &&
        status === "succeeded" &&
        requestReflectionRefinements(db) > 0;
      if (summaries || interpretations || refinements || built) void runner.wake();
      options.onJobClosed?.(job, status);
      const manager = options.connectors?.();
      const stoppedOnReplaced = replaced.delete(replacedKey(job));
      if (
        status === "held" &&
        stoppedOnReplaced &&
        job.kind === CONNECTOR_SYNC_KIND &&
        manager &&
        releaseIfReady(db, manager, job.target)
      ) {
        void runner.wake();
      }
    },
    handlers: {
      [EXTRACT_JOB_KIND]: handler,
      // S03-R6: no Provider is called; the version is the job's fence
      // S03-R12: re-checks the facts that rest on one table source; no Provider is called
      [ANALYTICAL_CHECK_JOB_KIND]: createAnalyticalCheckHandler({
        db,
        ...(clock ? { now: () => new Date(clock.now()) } : {}),
      }),
      [DATASET_PROFILE_KIND]: createDatasetProfileHandler({
        db,
        ...(clock ? { now: () => new Date(clock.now()) } : {}),
      }),
      [MAINTENANCE_KIND]: createMaintenanceHandler({ db, ...(clock ? { clock } : {}) }),
      // K01-R4: no Provider is called; no source, so no fence
      [WIKI_BUILD_KIND]: createWikiBuildHandler({
        db,
        ...(clock ? { now: () => new Date(clock.now()) } : {}),
      }),
      // K02-R2: reads the DB only, no Provider is called; no source, so no fence
      [REFLECT_JOB_KIND]: createReflectHandler({
        db,
        ...(options.registry ? { registry: options.registry } : {}),
        ...(clock ? { now: () => new Date(clock.now()) } : {}),
      }),
      // K02-R16: one Broker call per finding, IDs only; the Broker asks consent and egress, the finding keeps its status
      [REFLECTION_REFINE_KIND]: createReflectionRefineHandler({
        db,
        ...(options.registry ? { registry: options.registry } : {}),
      }),
      // K01-R12: one Broker call per page, IDs only; the Broker asks consent and egress, the page is a projection
      [WIKI_SUMMARY_KIND]: createWikiSummaryHandler({
        db,
        ...(options.registry ? { registry: options.registry } : {}),
      }),
      // P01-R7: one Broker call per Insight, IDs only; the Broker asks consent and egress, the row keeps its code content
      [INSIGHT_INTERPRET_KIND]: createInsightInterpretHandler({
        db,
        ...(options.registry ? { registry: options.registry } : {}),
        ...(clock ? { now: () => new Date(clock.now()) } : {}),
      }),
      // P02-R3: reads the DB only, no Provider is called; no source, so no fence
      [NOTIFY_JOB_KIND]: createNotifyHandler({
        db,
        ...(options.registry ? { registry: options.registry } : {}),
        ...(clock ? { now: () => new Date(clock.now()) } : {}),
      }),
      ...(options.connectors
        ? {
            [CONNECTOR_SYNC_KIND]: createConnectorSyncHandler({
              db,
              manager: options.connectors,
              replaced,
            }),
          }
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
    kinds: { ...PROJECTION_KIND_SETTINGS, [CONNECTOR_SYNC_KIND]: CONNECTOR_SYNC_SETTINGS },
    scope,
    broker,
    ...(clock ? { clock } : {}),
    ...(options.policyFingerprint ? { policyFingerprint: options.policyFingerprint } : {}),
    // folded away from any other build with the runner's own test branch (V01-T15)
    ...(BUILD_KIND === "test" && options.testBuild ? { testBuild: options.testBuild } : {}),
    onError: (error) => log("job-error", { error: errorClass(error) }),
  });
  return runner;
}

export const CANONICAL_DB_FILE = "pki.sqlite";

/** Opens a SQLite file with the product's driver, for code outside this composition point (the restore's journal check, H01-R11). */
export const openSqlFile: OpenSqlDriver = openBetterSqlite3;

/**
 * The product's Connector kinds: the site kinds, listed as not implemented (V01-R18), and `local-files`
 * (I02B-R2). The `local-files` function takes no argument and reads ports no one has bound here, so an
 * instance made from this list alone is unavailable; `boot.ts` binds its own (`withLocalFilesPorts`).
 */
export const connectorKinds = {
  "site-mail": () => createSiteConnector("site-mail"),
  "site-messenger": () => createSiteConnector("site-messenger"),
  "site-wiki": () => createSiteConnector("site-wiki"),
  "local-files": () => createLocalFilesConnector(() => undefined),
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
  options: Pick<SyncOptions, "runner" | "projections" | "clock" | "entries" | "scopes"> & {
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
  options: Pick<SyncOptions, "runner" | "projections" | "clock" | "entries" | "scopes"> & {
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

/** One instance per site kind, listed as not implemented, and the one `local-files` instance (I02B-R2). */
export function connectorInstances(): ConnectorInstanceConfig[] {
  return [
    ...SITE_CONNECTOR_KINDS.map((kind) => ({ id: kind, kind, config: {} })),
    { id: LOCAL_FILES_INSTANCE_ID, kind: "local-files", config: {} },
  ];
}

// --- local files (I02B-R4, R22, R37) ----------------------------------------------------------------

/**
 * Which host spawner runs the normalizer (I02B-R22, D9): a plain Node process forks the host (ⓐ), an
 * Electron utility process asks the shell through its channel (ⓑ). Under Electron without a channel there
 * is none: the normalizer is then unavailable, visibly, and never falls back to forking.
 */
export function chooseNormalizerSpawner(options: {
  underElectron: boolean;
  shell?: HostSpawner;
}): HostSpawner | undefined {
  return options.underElectron ? options.shell : createForkSpawner();
}

/** Whether this process is Electron's utility process: `parentPort` exists there and in no other process. */
export const runsUnderElectron = (): boolean =>
  (process as { parentPort?: unknown }).parentPort !== undefined;

/**
 * Every code the isolated normalizer can fail with is a skip reason: a code added to it without a place in
 * `LOCAL_SKIP_REASONS` stops compiling here, instead of being read as `corrupt` by the connector.
 */
export type IsolatedCodesAreSkipReasons =
  Exclude<IsolatedErrorCode, LocalSkipReason> extends never ? true : never;
const isolatedCodesAreSkipReasons: IsolatedCodesAreSkipReasons = true;
void isolatedCodesAreSkipReasons;

/**
 * The isolated normalizer as the connector's port, assigned without a cast: the real object satisfies
 * the port's shape. Without a spawner it is a port that is unavailable.
 */
export function isolatedNormalizerPort(
  spawner: HostSpawner | undefined,
  limits: { timeoutMs: number; maxHeapMb: number; maxExternalMemoryBytes: number },
): LocalNormalizerPort & { close(): Promise<void> } {
  if (spawner === undefined) {
    return {
      normalize: async () => ({
        ok: false,
        error: { code: "worker-failed" },
        unavailable: true,
      }),
      unavailable: () => true,
      recheck: async () => false,
      close: async () => undefined,
    };
  }
  return createIsolatedNormalizer({ spawner, ...limits });
}

export interface LocalFilesWiring {
  ports: LocalFilesPorts;
  /** What the instances of approved JSONL file locations read through (I02B-R4, R41). */
  jsonlPorts: JsonlFilePorts;
  locations: LocalLocations;
  tickets: ApprovalTickets;
  /** The revocation; the start continues a `revoking` location through it (I02B-R49). */
  revoker: LocalRevoke;
  /** Ends the normalizer host. */
  close(): Promise<void>;
}

/**
 * The `local-files` ports, the location API and the ticket table over `db`. `shellHost` is the spawner
 * the Electron shell's channel gives (shell-main.ts); `normalizer` replaces the isolated one in a test
 * build only.
 */
export function productLocalFiles(
  db: SqlDriver,
  options: {
    dataDir: string;
    /** More folders no location may be or lie in (the shell's user-data folder). */
    excluded?: readonly string[];
    clock: Clock;
    onApproved: () => void;
    shellHost?: HostSpawner;
    underElectron?: boolean;
    normalizer?: LocalNormalizerPort;
    /** Browser development only (dev.ts): approve a typed path as a test build does (I02B-R37). */
    typedPaths?: boolean;
    /** The tombstone entry a revocation deletes sources through (I02B-R10): the product registry's. */
    entries: Pick<CanonicalEntries, "applyTombstone">;
    /** Asks the running sync of an instance to stop, so a revocation gets its lock (I02B-R49). */
    cancelSync: (instanceId: string) => void;
    /** The running instances of JSONL file locations (I02B-R41); the composition's start binds them. */
    jsonlFile?: JsonlFileHooks;
    /** A full sync of the `local-files` instance (I02B-R13). */
    rescan: () => void;
    /** The driver's watch answer and its refresh after a change (I02B-R20, R38). */
    watching?: (locationId: string) => boolean;
    changed?: () => void;
  },
): LocalFilesWiring {
  const index = createLocalFileIndex(db);
  const forbidden = [options.dataDir, ...(options.excluded ?? [])];
  const settings = readLocalFilesSettings(db);
  const isolated = isolatedNormalizerPort(
    chooseNormalizerSpawner({
      underElectron: options.underElectron ?? runsUnderElectron(),
      ...(options.shellHost ? { shell: options.shellHost } : {}),
    }),
    settings.normalize,
  );
  const normalizer: LocalNormalizerPort =
    BUILD_KIND === "test" && options.normalizer ? options.normalizer : isolated;
  let last: LocalPassReport | undefined;
  const tickets = createApprovalTickets();
  const revoker = createLocalRevoke({
    db,
    entries: options.entries,
    limits: () => readLocalFilesSettings(db).revoke,
    cancelSync: options.cancelSync,
    ...(options.jsonlFile ? { onRevoked: options.jsonlFile.revoked } : {}),
  });
  return {
    jsonlPorts: {
      location: (id) => {
        const found = readLocation(db, id);
        return found?.type === "jsonl-file"
          ? {
              realPath: found.realPath,
              rootDev: found.rootDev,
              rootIno: found.rootIno,
              active: found.state === "active",
            }
          : undefined;
      },
      excluded: () => forbidden,
    },
    ports: {
      index,
      locations: () => listLocations(db),
      normalizer,
      normalizerVersion: NORMALIZER_VERSION,
      excluded: () => forbidden,
      limits: () => readLocalFilesSettings(db),
      now: () => options.clock.now(),
      setLocationState: (id, state, reason, expected) =>
        state === "active"
          ? reopenLocation(db, id, reason, expected)
          : closeLocation(db, id, state, reason, expected),
      report: (report) => void (last = report),
    },
    locations: createLocalLocations({
      db,
      index,
      forbidden,
      buildKind: options.typedPaths ? "development" : BUILD_KIND,
      tickets,
      isDocumentFile: isDocumentFileName,
      onApproved: options.onApproved,
      normalizerUnavailable: () => normalizer.unavailable(),
      lastReport: () => last,
      revoker,
      rescan: options.rescan,
      ...(options.jsonlFile ? { jsonlFile: options.jsonlFile } : {}),
      ...(options.watching ? { watching: options.watching } : {}),
      ...(options.changed ? { changed: options.changed } : {}),
      now: () => options.clock.now(),
    }),
    tickets,
    revoker,
    close: () => isolated.close(),
  };
}

/**
 * `kinds` with the import's kind (`jsonl-import`) made over `ports`: the instances of approved JSONL file
 * locations open their file through them (I02B-R41). The import's kind is not in the product's list of kinds
 * (it is the import's own), so it is added here, in the one backend that has the ports; a set that already has
 * one (a test's own) is left as it is.
 */
export function withJsonlFilePorts<K extends Record<string, ConnectorFactory>>(
  kinds: K,
  ports: () => JsonlFilePorts | undefined,
): K & Record<string, ConnectorFactory> {
  return JSONL_IMPORT_KIND in kinds
    ? kinds
    : { ...kinds, [JSONL_IMPORT_KIND]: () => createJsonlConnector(ports) };
}

/** `kinds` with the `local-files` function reading `ports`: one backend's own binding, so two backends in one process never share it. */
export function withLocalFilesPorts<K extends Record<string, ConnectorFactory>>(
  kinds: K,
  ports: () => LocalFilesPorts | undefined,
): K {
  return "local-files" in kinds
    ? { ...kinds, "local-files": () => createLocalFilesConnector(ports) }
    : kinds;
}
