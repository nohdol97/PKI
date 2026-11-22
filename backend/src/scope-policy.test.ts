// scope.policy, scope.changed (I04-C1) and site-paths.refuse ① (I04-H2) through the product's
// pieces: the policy the composition point chooses reaches the registry, the runner's commit and
// the status API. On a real SQLite file with the product's Broker and runner and a Provider double.
import { routes } from "@pki/contracts";
import { NullKnowledgeEngine } from "@pki/knowledge-engine/adapters";
import { DEFAULT_PROVIDER_SETTING, type EgressControls } from "@pki/providers";
import {
  addEvidence,
  defaultScopePolicy,
  insertItem,
  registerJob,
  saveFact,
  saveSourceRecord,
  writeSetting,
  type ScopePolicy,
  type SqlDriver,
} from "@pki/storage";
import { EmptyVectorIndex } from "@pki/storage/adapters";
import { FakeProvider, send } from "@pki/testkit";
import { fork } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootBackend } from "./boot.ts";
import {
  openCanonicalDb,
  productCalls,
  productEgress,
  productRegistry,
  productRunner,
} from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import type { JobRunner } from "./job-runner.ts";
import {
  productScopePolicy,
  ScopePolicyNotImplementedError,
  UnknownScopePolicyError,
} from "./scope-policy.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";
import { startServer } from "./server.ts";
import { EXTRACT_JOB_KIND } from "./connectors.ts";
import { EXTRACT_JOB_KIND as STORAGE_EXTRACT_JOB_KIND } from "@pki/storage";

const TOKEN = "s".repeat(43);
const SHELL = fileURLToPath(new URL("./shell.ts", import.meta.url));
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };

let dir: string;
let db: SqlDriver;
let runner: JobRunner | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-scope-"));
});
afterEach(async () => {
  await runner?.stop();
  runner = undefined;
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("site-paths.refuse ①: scopePolicy site stops the start (I04-H2, R14)", () => {
  it("names the policies: default and absent give the default, site and anything else stop", () => {
    expect(productScopePolicy()).toBe(defaultScopePolicy);
    expect(productScopePolicy("default")).toBe(defaultScopePolicy);
    expect(() => productScopePolicy("site")).toThrow(ScopePolicyNotImplementedError);
    expect(() => productScopePolicy("siet")).toThrow(UnknownScopePolicyError);
    expect(() => productScopePolicy("")).toThrow(UnknownScopePolicyError);
    expect(() => productScopePolicy("  ")).toThrow(/is empty/);
    expect(() => productScopePolicy("siet")).toThrow(/must be one of/);
  });

  it("refuses bootBackend before any file is opened, with the notice that begins 배포처 후속", async () => {
    const data = join(dir, "never-made");
    const boot = bootBackend({
      dataDir: data,
      token: TOKEN,
      allowedOrigins: [],
      secrets: NO_SECRET_STORE,
      providers: [],
      scopePolicy: "site",
    });
    await expect(boot).rejects.toThrow(ScopePolicyNotImplementedError);
    await expect(boot).rejects.toThrow(/^배포처 후속/);
    expect(existsSync(data)).toBe(false);
  });

  it("refuses a policy name it does not know rather than starting on the default", async () => {
    await expect(
      bootBackend({
        dataDir: join(dir, "never-made"),
        token: TOKEN,
        allowedOrigins: [],
        secrets: NO_SECRET_STORE,
        providers: [],
        scopePolicy: "strict",
      }),
    ).rejects.toThrow(UnknownScopePolicyError);
  });

  it("makes the real shell entry print the notice to stderr and exit 1 when the switch --scope-policy is site", async () => {
    const proc = fork(SHELL, ["--data-dir", join(dir, "data"), "--scope-policy", "site"], {
      env: { PATH: process.env.PATH ?? "", HOME: dir },
      execArgv: [],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const messages: unknown[] = [];
    proc.on("message", (m) => messages.push(m));
    const exited = new Promise<number | null>((resolve) => proc.once("exit", resolve));
    proc.send({ type: "start", token: "k".repeat(43) });
    const code = await exited;
    expect(stderr.startsWith("배포처 후속")).toBe(true);
    expect(stderr.trim().split("\n")).toHaveLength(1); // one notice
    expect(messages).toEqual([{ type: "failed", reason: "scope-policy-not-implemented" }]);
    expect(code).toBe(1);
  }, 30_000);
});

describe("the extract job kind has one name", () => {
  it("is the same in the backend and in the scope-drop kind's re-extraction (I04-R15)", () => {
    expect(EXTRACT_JOB_KIND).toBe(STORAGE_EXTRACT_JOB_KIND);
  });
});

/** Sources can be put together only when they share one scope: a stand-in for a site's rule. */
const sameScopeOnly: ScopePolicy = {
  ...defaultScopePolicy,
  combinable: (scopes) => new Set(scopes.map((s) => JSON.stringify(s))).size <= 1,
};

const attrs = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
} as const;
const BODY =
  "알파 일정. 알파의 목표일은 2026-12-05입니다. 새것의 완료는 2026-12-10입니다. 알파는 새것에 의존한다.";

function consent(egress: EgressControls) {
  const shown = egress.overview().providers.find((p) => p.providerId === "local-model");
  const granted = egress.grant("local-model", ["general"], {
    destination: shown?.destination ?? "",
    policyVersion: egress.policyVersion(),
  });
  if ("error" in granted) throw new Error(granted.error);
}
const setScope = (sourceId: number, scope: readonly string[]) =>
  db.run("UPDATE sources SET access_scope = ? WHERE id = ?", [JSON.stringify(scope), sourceId]);
const count = (table: string) => db.all(`SELECT count(*) AS n FROM ${table}`)[0]?.n as number;

async function status() {
  const server = await startServer({
    token: TOKEN,
    allowedOrigins: [],
    vectorIndex: new EmptyVectorIndex(),
    embedder: null,
    connectors,
    db,
    dataDirectory: dir,
    egress: productEgress(db),
  });
  try {
    const res = await send(server.port, routes.status.path, {
      host: `127.0.0.1:${server.port}`,
      authorization: `Bearer ${TOKEN}`,
    });
    return routes.status.response.parse(res.body).invalidations;
  } finally {
    await server.close();
  }
}

/**
 * The product's Broker and runner under `policy`: the registry from productRegistry, which the Broker
 * (candidate lineage), the extract handler (candidates, rule) and the runner (the commit) all take.
 */
function pipeline(policy: ScopePolicy, during: () => void) {
  db = openCanonicalDb(dir);
  const provider = new FakeProvider({
    id: "local-model",
    transport: "http",
    answer: (request) => {
      during();
      const pick = (name: string) => request.input.candidates.find((c) => c.name === name)?.id;
      return {
        items: [
          { ref: "X", type: "Project", name: "알파", existingItemId: pick("알파") ?? null },
          { ref: "N", type: "System", name: "새것", existingItemId: pick("새것") ?? null },
        ],
        facts: [
          {
            item: "X",
            kind: "target_date",
            value: "2026-12-05",
            epistemic: "explicit",
            quote: "알파의 목표일은 2026-12-05",
          },
          {
            item: "N",
            kind: "completion_date",
            value: "2026-12-10",
            epistemic: "explicit",
            quote: "새것의 완료는 2026-12-10",
          },
        ],
        relations: [
          { subject: "X", type: "DEPENDS_ON", object: "N", quote: "알파는 새것에 의존한다" },
        ],
      };
    },
  });
  writeSetting(db, DEFAULT_PROVIDER_SETTING, provider.id);
  const egress = productEgress(db);
  const registry = productRegistry({
    engine: new NullKnowledgeEngine(),
    vectorIndex: new EmptyVectorIndex(),
    policy,
  });
  const { broker } = productCalls(db, egress, { providers: [provider], registry });
  runner = productRunner(db, broker, { registry });
  consent(egress);
  return { provider, registry, runner };
}

/** 알파 is known from source a (scope s); b (scope s) names it; a narrows while the Provider answers. */
function world() {
  const a = saveSourceRecord(db, "c", { externalId: "a", title: "a", body: "알" });
  const b = saveSourceRecord(db, "c", { externalId: "b", title: "b", body: BODY });
  if (a.status !== "created" || b.status !== "created") throw new Error("expected new versions");
  setScope(a.sourceId, ["s"]);
  setScope(b.sourceId, ["s"]);
  const x = insertItem(db, { type: "Project", name: "알파", ...attrs });
  const fact = saveFact(db, { itemId: x, kind: "target_date", value: "2026-12-01", ...attrs }).id;
  const aRow = db.all("SELECT id FROM source_versions WHERE source_id = ?", [a.sourceId])[0]
    ?.id as number;
  addEvidence(db, {
    target: { factId: fact },
    sourceVersionId: aRow,
    start: 0,
    end: 1,
    quote: "알",
  });
  return { a: a.sourceId, b: b.sourceId };
}

describe("scope.policy and scope.changed through the product's runner", () => {
  it("leaves out only what the policy refuses, closes the job succeeded, and counts the records in the status API", async () => {
    let narrow: () => void = () => undefined;
    const kit = pipeline(sameScopeOnly, () => narrow());
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('c', 'test-fixtures')");
    expect(await status()).toEqual({ recent: [], scopePolicyDrops: 0 });
    const { a, b } = world();
    narrow = () => setScope(a, ["x"]); // the policy meets a changed scope at the commit
    registerJob(db, { kind: "extract", sourceId: b, fenceVersion: 1 });
    await kit.runner.wake();

    expect(db.all("SELECT status, reason FROM jobs")).toEqual([
      { status: "succeeded", reason: null },
    ]);
    // 새것 and its completion date are written; the date on 알파 and the relation from it are not
    expect(db.all("SELECT name FROM items ORDER BY id")).toEqual([
      { name: "알파" },
      { name: "새것" },
    ]);
    expect(count("relations")).toBe(0);
    expect(count("insights")).toBe(0);
    expect(db.all("SELECT kind FROM facts WHERE item_id = 2")).toEqual([
      { kind: "completion_date" },
    ]);
    expect(count("scope_policy_drops")).toBe(3);
    expect(await status()).toEqual({ recent: [], scopePolicyDrops: 3 });

    // the retention clean-up deletes the finished job rows; the records are not job rows
    db.run("DELETE FROM jobs");
    expect(count("scope_policy_drops")).toBe(3);

    // a widens again: the change queues b's extraction (not a new version), which writes what was left out
    narrow = () => undefined;
    setScope(a, ["s"]);
    const propagation = db.transaction(() =>
      kit.registry.propagate(db, { kind: "scope-changed", sourceId: a, from: ["x"], to: ["s"] }),
    );
    expect(propagation.recomputedByKind["scope-drop"]).toBe(1);
    // the records stay until the re-extraction has run
    expect(count("scope_policy_drops")).toBe(3);
    await kit.runner.wake();
    expect(db.all("SELECT status FROM jobs ORDER BY id").map((j) => j.status)).toEqual([
      "succeeded",
    ]);
    expect(count("relations")).toBe(1);
    expect(count("insights")).toBe(1);
    expect(count("scope_policy_drops")).toBe(0);
    expect((await status()).scopePolicyDrops).toBe(0);
  });

  it("changes nothing under the default policy: the same answer writes everything", async () => {
    let narrow: () => void = () => undefined;
    const kit = pipeline(defaultScopePolicy, () => narrow());
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('c', 'test-fixtures')");
    const { a, b } = world();
    narrow = () => setScope(a, ["x"]);
    registerJob(db, { kind: "extract", sourceId: b, fenceVersion: 1 });
    await kit.runner.wake();
    expect(count("relations")).toBe(1);
    expect(count("insights")).toBe(1);
    expect(count("scope_policy_drops")).toBe(0);
  });
});

describe("the shell's switch and the failure report (I04-H2 ①)", () => {
  it("takes the policy name from --scope-policy in the source run and in the production build, and not from the environment", async () => {
    const { shellOptions: source } = await import("./shell-options.ts");
    const { shellOptions: production } = await import("./shell-options.production.ts");
    expect(source(["--origin", "app://pki", "--scope-policy", "site"]).scopePolicy).toBe("site");
    expect(production(["--origin", "app://pki", "--scope-policy", "site"])).toEqual({
      origins: ["app://pki"],
      scopePolicy: "site",
    });
    expect(production(["--origin", "app://pki"])).toEqual({ origins: ["app://pki"] });
  });

  it("reports a fixed class for each refused policy, and prints its notice", async () => {
    const { startFailureLine, startFailureReport } = await import("./start-failure.ts");
    expect(startFailureReport(new ScopePolicyNotImplementedError())).toEqual({
      type: "failed",
      reason: "scope-policy-not-implemented",
    });
    expect(startFailureReport(new UnknownScopePolicyError(true))).toEqual({
      type: "failed",
      reason: "scope-policy-invalid",
    });
    const { UnregisteredAdapterError } = await import("./derivative-coverage.ts");
    const unregistered = new UnregisteredAdapterError(["engine"], "fixed text");
    expect(startFailureReport(unregistered)).toEqual({
      type: "failed",
      reason: "adapter-unregistered",
    });
    // the log line keeps the error's name, which carries the adapter kinds
    expect(startFailureLine(unregistered)).toBe(`backend start failed: ${unregistered.name}`);
    expect(startFailureLine(new ScopePolicyNotImplementedError()).startsWith("배포처 후속")).toBe(
      true,
    );
    expect(startFailureLine(new UnknownScopePolicyError(true))).toMatch(/is empty/);
  });
});

describe("the runner's scope does not reach what is not derived (I04-R11, I03-T09 handlers)", () => {
  const refusing: ScopePolicy = { ...defaultScopePolicy, combinable: () => false };
  const throwing: ScopePolicy = {
    ...defaultScopePolicy,
    combinable: () => {
      throw new Error("cannot judge");
    },
  };

  it.each([
    ["refusing", refusing],
    ["throwing", throwing],
  ])(
    "closes maintenance and connector-sync normally under a %s policy, their writes run",
    async (_n, policy) => {
      db = openCanonicalDb(dir);
      const manager = {
        list: () => [{ id: "c1", kind: "scripted", state: "ready" as const }],
        sync: async () => ({
          connectorId: "c1",
          received: 2,
          created: 2,
          unchanged: 0,
          scopeUpdated: 0,
          stale: 0,
          staleTombstone: 0,
          blocked: 0,
          tombstoned: 0,
          rejected: [],
          rejectedCount: 0,
          rescanned: false,
          deletionsMayBeMissed: false,
        }),
      };
      const registry = productRegistry({
        engine: new NullKnowledgeEngine(),
        vectorIndex: new EmptyVectorIndex(),
        policy,
      });
      const { createConnectorSyncHandler, CONNECTOR_SYNC_KIND } =
        await import("./connector-sync-job.ts");
      const { createMaintenanceHandler } = await import("./maintenance.ts");
      const { MAINTENANCE_KIND } = await import("./scheduler.ts");
      const { createJobRunner } = await import("./job-runner.ts");
      const { createCommitScope } = await import("@pki/storage");
      registerJob(db, { kind: CONNECTOR_SYNC_KIND, target: "c1" });
      registerJob(db, { kind: MAINTENANCE_KIND, target: "" });
      runner = createJobRunner({
        db,
        handlers: {
          [CONNECTOR_SYNC_KIND]: createConnectorSyncHandler({ db, manager: () => manager }),
          [MAINTENANCE_KIND]: createMaintenanceHandler({ db }),
        },
        scope: createCommitScope({ policy: registry.policy }),
      });
      await runner.wake();
      expect(db.all("SELECT kind, status FROM jobs ORDER BY kind")).toEqual([
        { kind: CONNECTOR_SYNC_KIND, status: "succeeded" },
        { kind: MAINTENANCE_KIND, status: "succeeded" },
      ]);
      // their own writes ran: the lease-guarded result counts are stored
      const counts = db.all("SELECT kind, result_counts FROM jobs ORDER BY kind");
      expect(JSON.parse(counts[0]?.result_counts as string)).toMatchObject({ created: 2 });
      expect(counts[1]?.result_counts).not.toBeNull();
      expect(db.all("SELECT count(*) AS n FROM scope_policy_drops")).toEqual([{ n: 0 }]);
    },
  );
});
