// Starts the backend on a data directory: the canonical DB, the Connectors, the
// Providers, the Broker, the job runner and the API server with the product's
// adapters and egress controls (composition.ts). Closing the server stops the
// runner too, after the job it is running closes, then waits for the notices to
// the KnowledgeEngine and VectorIndex already queued; before anything runs, the
// start-up comparison rebuilds a projection that missed a change (V02-R13). Shared by the two entries that differ only in how they
// hand over the session and where secrets come from: dev.ts (stdout, environment)
// and shell.ts (the Electron shell's parent channel for both).
import type {
  EmbeddingProvider,
  KnowledgeEngine,
  LLMProvider,
  SecretSource,
  VectorIndex,
} from "@pki/contracts";
import type { Projections } from "@pki/knowledge-engine";
import { BUILD_KIND, errorClass, log } from "@pki/providers";
import type { DerivativeRegistry, SqlDriver } from "@pki/storage";
import { join } from "node:path";
import {
  CANONICAL_DB_FILE,
  openCanonicalDb,
  productAdapters,
  productCalls,
  productConnectors,
  productEgress,
  productEngine,
  productEntries,
  productImporter,
  productProjectionPorts,
  productProjections,
  productProviders,
  productRegistry,
  productRunner,
  productVisibleEngine,
  sweepCliRuns,
  cliRunsRoot,
  type ConnectorSet,
} from "./composition.ts";
import { systemClock } from "./clock.ts";
import { createConnectorManager, type ConnectorManager } from "./connectors.ts";
import { startCollectorUpkeep } from "./connector-sync-job.ts";
import { releaseOnPolicyChange, startHeldReevaluation } from "./held-release.ts";
import { createJobActions } from "./job-actions.ts";
import type { JobRunner, RunnerTestBuild } from "./job-runner.ts";
import { checkProjectionMarkers, type ProjectionPorts } from "./projection-jobs.ts";
import { createScheduler, type Scheduler } from "./scheduler.ts";
import { startServer, type RunningServer } from "./server.ts";

export interface BootOptions {
  /** Holds the canonical DB. */
  dataDir: string;
  /** Default productConnectors(); source runs add the test Connector (fixtureConnectors). */
  connectors?: ConnectorSet | undefined;
  /** Fresh per run, handed over in-process by the entry. */
  token: string;
  allowedOrigins: readonly string[];
  /** 0 (default) picks a free port. */
  port?: number;
  /** Where Providers read their secrets just before a call; the backend keeps none. */
  secrets: SecretSource;
  /** Replaces the composition point's KnowledgeEngine (tests: engine.restart keeps one across starts). */
  engine?: KnowledgeEngine;
  /** Replaces the composition point's VectorIndex (tests). */
  vectorIndex?: VectorIndex;
  /** The test build's job lease, poll and test kinds (job-runner.ts); ignored by any other build. */
  testBuild?: { jobs?: RunnerTestBuild };
  /**
   * Replace the composition point's Providers and embedder (tests: adapter-swap,
   * V01-R17). The entries never pass them; everything else stays the product's.
   */
  providers?: readonly LLMProvider[];
  embedder?: EmbeddingProvider | null;
  /**
   * Replaces the product's ports for the runner's `projection-remove` and `projection-rebuild`
   * handlers (tests: a projection double). Default the registered kinds over the bound engine and
   * vector index (composition.ts productProjectionPorts).
   */
  projectionPorts?: ProjectionPorts;
  /** Replaces the product's registry (tests: a registry that differs from the default shows which paths receive it). */
  registry?: DerivativeRegistry;
}

export interface BootedBackend {
  server: RunningServer;
  db: SqlDriver;
  /** The Providers the Broker may call (productProviders). */
  providers: readonly LLMProvider[];
  /** The KnowledgeEngine as the backend holds it: wrapped by the registry (I04-R13). */
  engine: KnowledgeEngine;
  /** Tests wait on these: the notices queued, the jobs runnable. */
  projections: Pick<Projections, "drain">;
  runner: Pick<JobRunner, "wake">;
  /** The periods' check, started at boot (I03-R22); I03-T09 adds the default periods through it. */
  scheduler: Scheduler;
}

export async function bootBackend(options: BootOptions): Promise<BootedBackend> {
  const db = openCanonicalDb(options.dataDir);
  await sweepCliRuns(options.dataDir); // what a crashed backend's CLI runs left
  // one egress instance for the consent API, the Broker (T08) and the Providers (T11)
  const egress = productEgress(db);
  const providers =
    options.providers ??
    productProviders(db, options.secrets, egress, cliRunsRoot(options.dataDir));
  const calls = productCalls(db, egress, { providers });
  const bound = options.engine ?? productEngine();
  const adapters = productAdapters(options.dataDir);
  if (options.vectorIndex) adapters.vectorIndex = options.vectorIndex;
  if (options.embedder !== undefined) adapters.embedder = options.embedder;
  // the registry is built once, from the implementations bound; the backend holds the engine only as it wraps it (I04-R13)
  const registry =
    options.registry ?? productRegistry({ engine: bound, vectorIndex: adapters.vectorIndex });
  const entries = productEntries(registry);
  const engine = productVisibleEngine(db, registry, bound);
  const projections = productProjections(db, { engine, ...adapters });
  const projectionPorts =
    options.projectionPorts ??
    productProjectionPorts(
      db,
      registry,
      { engine, vectorIndex: adapters.vectorIndex },
      projections,
    );
  // before anything changes the store: a notice missed by the last run is found here
  await projections.reconcile();
  // one clock for the runner and for the jobs imports and syncs register (I03 "시계")
  const clock = systemClock;
  // the manager wakes the runner and the runner's `connector-sync` handler calls the manager:
  // the handler reads it at each run; a run claimed before it is set (a wake can claim before
  // runner.start) is deferred by the handler, its attempt unspent
  const late: { manager?: ConnectorManager } = {};
  const runner = productRunner(db, calls.broker, {
    clock,
    connectors: () => late.manager,
    policyFingerprint: calls.policyFingerprint,
    engine,
    projections,
    projectionPorts,
    registry,
    // folded away from any other build (V01-T15); the runner honours it in a test build only
    ...(BUILD_KIND === "test" && options.testBuild?.jobs
      ? { testBuild: options.testBuild.jobs }
      : {}),
  });
  const { instances, kinds } = options.connectors ?? productConnectors();
  const connectors = await createConnectorManager(db, instances, kinds, {
    runner,
    projections,
    clock,
    entries,
  });
  late.manager = connectors;
  // a removal the last run left unfinished or gave up on marks its projection: rebuilt now,
  // whatever the applied change sequence says (I03-R7); registered before the server serves a deletion or the runner starts
  checkProjectionMarkers(db, { phase: "start", now: clock.now() });
  // the check at start and every 30 s (started below): due periods, and the run times a clock that
  // went back left in the future (I03-R22), with or without any period stored. Made before the
  // server, whose Activity API changes periods through it (I03-R23).
  const scheduler = createScheduler({
    db,
    clock,
    onRegistered: () => void runner.wake(),
    onError: (error) => log("scheduler-error", { error: errorClass(error) }),
  });
  const server = await startServer({
    token: options.token,
    allowedOrigins: options.allowedOrigins,
    port: options.port ?? 0,
    ...adapters,
    connectors,
    db,
    dataDirectory: options.dataDir,
    databaseFile: join(options.dataDir, CANONICAL_DB_FILE),
    egress,
    secrets: options.secrets,
    calls,
    importer: productImporter(db, { runner, projections, clock, entries }),
    entries,
    registry,
    // the held jobs were put back in the transaction that changed the condition (R16 ①)
    onRunConditionsChanged: () => void runner.wake(),
    jobs: {
      scheduler,
      actions: createJobActions({ db, runner, clock }),
      budgetUsage: calls.broker.budgetUsage,
      projectionNames: Object.keys(projectionPorts),
      wake: () => void runner.wake(),
    },
  });
  releaseOnPolicyChange(db, calls.policyFingerprint(), runner);
  runner.start();
  const reevaluation = startHeldReevaluation({
    db,
    broker: calls.broker,
    runner,
    onError: (error) => log("held-reevaluation-error", { error: errorClass(error) }),
  });
  // the default periods, the held collectors that are ready now, and the hourly recheck (I03-T09)
  const collectors = startCollectorUpkeep({ db, manager: connectors, scheduler, runner });
  scheduler.start();
  return {
    server: {
      ...server,
      close: async () => {
        reevaluation.stop();
        scheduler.stop();
        await collectors.stop();
        await server.close();
        await runner.stop();
        await projections.drain();
      },
    },
    db,
    providers,
    engine,
    projections,
    runner,
    scheduler,
  };
}

/**
 * Backend shutdown (V01-T10): ends every Provider's running calls, CLI process trees
 * included, waiting at most `limitMs` so a stuck Provider cannot hold the exit.
 * A CLI runs in its own process group and would otherwise outlive the backend.
 */
export async function closeProviders(
  providers: readonly LLMProvider[],
  limitMs: number,
): Promise<void> {
  const closing = Promise.all(
    providers.map((p) =>
      Promise.resolve()
        .then(() => p.close?.())
        .catch(() => undefined),
    ),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([closing, new Promise((r) => (timer = setTimeout(r, limitMs)))]);
  clearTimeout(timer);
}
