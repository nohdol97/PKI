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
  LocalNormalizerPort,
  SecretSource,
  VectorIndex,
} from "@pki/contracts";
import type { HostSpawner } from "@pki/document-normalize";
import type { Projections } from "@pki/knowledge-engine";
import { JSONL_IMPORT_KIND } from "@pki/connector-sdk";
import { BUILD_KIND, errorClass, log, type ScopeGrading } from "@pki/providers";
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
  productUserDecisions,
  productImporter,
  productInstanceImporter,
  productProjectionPorts,
  productProjections,
  productProviders,
  productRegistry,
  productRunner,
  productLocalFiles,
  productVisibleEngine,
  sweepCliRuns,
  cliRunsRoot,
  withLocalFilesPorts,
  type ConnectorSet,
} from "./composition.ts";
import { readLocalFilesSettings, type ApprovalTickets } from "./local-locations.ts";
import { systemClock } from "./clock.ts";
import { applyConfiguredScopes, bindConnectorScopes } from "./connector-scopes.ts";
import { assertBoundAdaptersRegistered } from "./derivative-coverage.ts";
import {
  createConnectorManager,
  type ConnectorManager,
  type ConnectorRebuild,
  type ConnectorRecheck,
} from "./connectors.ts";
import {
  CONNECTOR_SYNC_KIND,
  releaseOnReady,
  startCollectorUpkeep,
  SYNC_PERIOD,
} from "./connector-sync-job.ts";
import { releaseOnPolicyChange, startHeldReevaluation } from "./held-release.ts";
import {
  LOCAL_FILES_INSTANCE_ID,
  requestInsightInterpretations,
  requestWikiBuild,
  requestWikiSummaries,
} from "@pki/storage";
import { createJobActions } from "./job-actions.ts";
import type { JobRunner, RunnerTestBuild } from "./job-runner.ts";
import { needsRebuild, reapplyAtStart } from "./ledger-boot.ts";
import {
  createLocalFilesDriver,
  nodeTimers,
  nodeWatch,
  type LocalFilesDriver,
} from "./local-files-driver.ts";
import { checkProjectionMarkers, type ProjectionPorts } from "./projection-jobs.ts";
import { createScheduler, type Scheduler } from "./scheduler.ts";
import { productScopePolicy } from "./scope-policy.ts";
import { startServer, type RunningServer } from "./server.ts";
import { publicSite, resolveSiteRegistration, type SiteRegistration } from "./site-registration.ts";

export interface BootOptions {
  /** Holds the canonical DB. */
  dataDir: string;
  /** The base set; default productConnectors(). Source runs add the test Connector (fixtureConnectors). */
  connectors?: ConnectorSet | undefined;
  /**
   * What a deployment fork plugs in (I05-R1, R6): merged onto the base set, its mapping and policy used
   * as well. Default `publicSite`, nothing. A registration that touches a public kind or instance stops
   * the start (`SiteRegistrationInvalidError`) before the canonical DB is opened.
   */
  site?: SiteRegistration | undefined;
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
  /**
   * Replaces the product's registry (tests: a registry that differs from the default shows which
   * paths receive it). Honoured in a test build only, like `testBuild`: a production build always
   * runs the registry the composition point builds, whatever a caller passes.
   */
  registry?: DerivativeRegistry;
  /** The mapping scope -> class for the Broker (I01-R15); honoured in a test build only, like `registry`. */
  scopeGrading?: ScopeGrading;
  /**
   * The scope policy by name (I04-R14, I05-R15, S21), for a source run: none gives the registration's
   * policy (else the public default), `default` the public default, `site` the registration's policy, which
   * stops the start with `배포처 후속` before anything is opened when none is registered. The production
   * build passes no name. The desktop shell passes it as the backend's `--scope-policy` switch (from
   * its own `PKI_SCOPE_POLICY`), the development entry reads `PKI_SCOPE_POLICY` (scope-policy.ts scopePolicyFromEnv).
   */
  scopePolicy?: string | undefined;
  /**
   * The `local-files` connector's outside (I02B-R4, R22, R37). `shellHost` is the spawner the Electron
   * shell's channel gives the normalizer host (shell-main.ts); `underElectron` overrides the process's own
   * answer (tests); `excluded` are more folders no location may be or lie in (the shell's user-data folder);
   * `normalizer` replaces the isolated normalizer, in a test build only.
   */
  localFiles?: {
    shellHost?: HostSpawner;
    underElectron?: boolean;
    excluded?: readonly string[];
    normalizer?: LocalNormalizerPort;
    /** Browser development (dev.ts) only: a typed path is approved as in a test build (I02B-R37). */
    typedPaths?: boolean;
  };
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
  /** The Connector manager (tests read the instances and ask for a rebuild; the API's notice route is T04's). */
  connectors: ConnectorManager & ConnectorRebuild & ConnectorRecheck;
  /** The periods' check, started at boot (I03-R22); I03-T09 adds the default periods through it. */
  scheduler: Scheduler;
  /** The one-time tickets the shell registers a picked path under (I02B-R37). */
  tickets: ApprovalTickets;
}

export async function bootBackend(options: BootOptions): Promise<BootedBackend> {
  const site = options.site ?? publicSite;
  // the policy before any file is opened: a name that is not implemented stops the start (I04-H2 ①)
  const policy = productScopePolicy(options.scopePolicy, site.scopePolicy);
  // the registration is checked and merged before the canonical DB or the ledger is touched: one that
  // reaches for a public kind or instance stops the start here (I05-R9, R12)
  const { instances, kinds } = resolveSiteRegistration(
    site,
    options.connectors ?? productConnectors(),
  );
  const db = openCanonicalDb(options.dataDir);
  // the instances' configured scopes follow the registration's value before anything is graded (I01-R15);
  // one table, handed to every place that copies it (I07-R2). It never stops the start: what is bad is unknown
  const { scopes, state, configured, rejected } = bindConnectorScopes(site.connectorScopes);
  applyConfiguredScopes(db, scopes);
  // exactly one fixed line per state, counts only, so a build that lost the value is told from one that has none (I07-R4)
  log(`connector-scopes-${state}`, { configured });
  if (rejected > 0) log("connector-scopes-rejected", { count: rejected });
  await sweepCliRuns(options.dataDir); // what a crashed backend's CLI runs left
  // one egress instance for the consent API, the Broker (T08) and the Providers (T11)
  const egress = productEgress(db);
  const providers =
    options.providers ??
    productProviders(db, options.secrets, egress, cliRunsRoot(options.dataDir));
  const bound = options.engine ?? productEngine();
  const adapters = productAdapters(options.dataDir);
  if (options.vectorIndex) adapters.vectorIndex = options.vectorIndex;
  if (options.embedder !== undefined) adapters.embedder = options.embedder;
  // the registry is built once, from the implementations bound; the backend holds the engine only as it wraps it (I04-R13).
  // The Broker grades a candidate by its lineage (I04-R16), so it takes the registry too
  const registry =
    BUILD_KIND === "test" && options.registry
      ? options.registry
      : productRegistry({ engine: bound, vectorIndex: adapters.vectorIndex, policy });
  try {
    // an adapter no registered kind covers would escape a deletion (I04-R3): refuse to start
    assertBoundAdaptersRegistered(registry, { engine: bound, vectorIndex: adapters.vectorIndex });
  } catch (error) {
    db.close();
    throw error;
  }
  const calls = productCalls(db, egress, {
    providers,
    registry,
    ...(options.scopeGrading ? { scopeGrading: options.scopeGrading } : {}),
    ...(site.scopeGrading ? { siteScopeGrading: site.scopeGrading } : {}),
  });
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
  // R17: the deletions the database has not seen (a restore, a kill before COMMIT) are applied
  // before the API opens and before anything runs; a line that fails stops the start here
  // an instance a line would register must be of a kind this build knows (a corrupt line cannot bind one to a bogus kind):
  // the merged kinds, a registered one included (I05-R12), and the import's
  const knownKinds = new Set([...Object.keys(kinds), JSONL_IMPORT_KIND]);
  const reapplied = reapplyAtStart(
    db,
    registry,
    systemClock.now(),
    (kind) => knownKinds.has(kind),
    scopes,
  );
  // before anything changes the store: a notice missed by the last run is found here
  await projections.reconcile();
  // one clock for the runner and for the jobs imports and syncs register (I03 "시계")
  const clock = systemClock;
  // the manager wakes the runner and the runner's `connector-sync` handler calls the manager:
  // the handler reads it at each run; a run claimed before it is set (a wake can claim before
  // runner.start) is deferred by the handler, its attempt unspent
  const late: {
    manager?: ConnectorManager;
    scheduler?: Scheduler;
    driver?: LocalFilesDriver;
  } = {};
  // one sync of the `local-files` instance now: what an approval, a start and a watch signal register
  const registerLocalSync = () => {
    const scheduler = late.scheduler;
    if (!scheduler) return;
    const { schedule } = scheduler.ensureSchedule({
      kind: CONNECTOR_SYNC_KIND,
      target: LOCAL_FILES_INSTANCE_ID,
      period: SYNC_PERIOD,
    });
    scheduler.runNow(schedule.id);
    void runner.wake();
  };
  // the location API and the `local-files` ports (I02B-R4): an approval registers one sync now
  const localFiles = productLocalFiles(db, {
    dataDir: options.dataDir,
    clock,
    ...options.localFiles,
    entries,
    watching: (id) => late.driver?.watching(id) ?? false,
    changed: () => late.driver?.refresh(),
    // a revocation needs the instance lock: the running sync is asked to stop (it continues from its cursor)
    cancelSync: () => {
      for (const row of db.all(
        "SELECT id FROM jobs WHERE kind = ? AND target = ? AND status = 'running'",
        [CONNECTOR_SYNC_KIND, LOCAL_FILES_INSTANCE_ID],
      )) {
        actions.cancel(row.id as number);
      }
    },
    // every location is walked from the start by the next sync (I02B-R13)
    rescan: () =>
      void late.manager
        ?.sync(LOCAL_FILES_INSTANCE_ID, { rescan: true })
        .catch((error) => log("local-rescan-failed", { error: errorClass(error) })),
    onApproved: registerLocalSync,
  });
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
  const actions = createJobActions({ db, runner, clock });
  const connectors = await createConnectorManager(
    db,
    instances,
    withLocalFilesPorts(kinds, () => localFiles.ports),
    {
      runner,
      projections,
      clock,
      entries,
      scopes,
      secrets: options.secrets,
      onReady: releaseOnReady(db, runner),
    },
  );
  late.manager = connectors;
  // a removal the last run left unfinished or gave up on marks its projection: rebuilt now,
  // whatever the applied change sequence says (I03-R7); registered before the server serves a deletion or the runner starts
  checkProjectionMarkers(db, { phase: "start", now: clock.now() });
  // K01-R5: pages left behind by a stop (or by a version that had no Wiki) are built from the start
  requestWikiBuild(db);
  requestWikiSummaries(db); // K01-R12: with the setting on, pages without a summary of their content are asked for
  requestInsightInterpretations(db); // P01-R7: with the setting on, Insights not yet read at their content are asked for
  // the check at start and every 30 s (started below): due periods, and the run times a clock that
  // went back left in the future (I03-R22), with or without any period stored. Made before the
  // server, whose Activity API changes periods through it (I03-R23).
  const scheduler = createScheduler({
    db,
    clock,
    onRegistered: () => void runner.wake(),
    onError: (error) => log("scheduler-error", { error: errorClass(error) }),
  });
  late.scheduler = scheduler;
  // I02B-R20: the restore pause, the revocation left half done, the first sync and the watchers, in this order
  const driver = createLocalFilesDriver({
    db,
    registerSync: registerLocalSync,
    revoke: localFiles.revoker,
    watch: nodeWatch,
    timers: nodeTimers,
    now: () => clock.now(),
    limits: () => readLocalFilesSettings(db).watch,
  });
  late.driver = driver;
  driver.start(needsRebuild(reapplied));
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
    importer: productImporter(db, { runner, projections, clock, entries, connectors, scopes }),
    instanceImporter: productInstanceImporter(db, {
      runner,
      projections,
      clock,
      entries,
      connectors,
      scopes,
    }),
    entries,
    registry,
    localLocations: localFiles.locations,
    decisions: productUserDecisions(registry),
    // the held jobs were put back in the transaction that changed the condition (R16 ①)
    onRunConditionsChanged: () => void runner.wake(),
    jobs: {
      scheduler,
      actions,
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
        driver.stop();
        reevaluation.stop();
        scheduler.stop();
        await collectors.stop();
        await server.close();
        await runner.stop();
        await projections.drain();
        await localFiles.close();
      },
    },
    db,
    providers,
    engine,
    projections,
    runner,
    connectors,
    scheduler,
    tickets: localFiles.tickets,
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
