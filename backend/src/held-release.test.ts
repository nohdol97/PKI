// I03-T07 on the product's own pieces: `held.release`, `held.precheck`,
// `background.gate` and `manual-retry` (C3; I03-R12 ①②, R15, R16). The JSONL import
// registers real extraction jobs, the composition point's Broker judges them with
// a Provider double, and the API changes the conditions that hold them.
import { routes } from "@pki/contracts";
import {
  CLI_BACKGROUND_SETTING,
  CLI_PROFILES,
  DEFAULT_PROVIDER_SETTING,
  type EgressControls,
  type TestBuildExecution,
} from "@pki/providers";
import { readConsent, readJob, registerJob, writeSetting, type SqlDriver } from "@pki/storage";
import { FakeProvider, fixtureExtraction, send, dirTemplate } from "@pki/testkit";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  openCanonicalDb,
  productAdapters,
  productCalls,
  productEgress,
  productImporter,
  productRunner,
} from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import {
  computePolicyFingerprint,
  HELD_REASONS,
  HELD_REEVALUATION_MS,
  reevaluateHeldJobs,
  releaseHeldOnEvent,
  releaseOnPolicyChange,
  startHeldReevaluation,
} from "./held-release.ts";
import { createJobActions } from "./job-actions.ts";
import type { JobRunner } from "./job-runner.ts";
import { startServer, type RunningServer } from "./server.ts";

const seedDataDir = dirTemplate((path) => openCanonicalDb(path).close());

const FIXTURES = resolve(import.meta.dirname, "../../fixtures");
const read = (name: string) => readFileSync(resolve(FIXTURES, name), "utf8");
const expected = JSON.parse(read("v02-expected.json")) as {
  sets: Record<string, { files: string[] }>;
};
const plain = expected.sets.plain?.files.map(read).join("\n") ?? "";
const TOKEN = "f".repeat(43);
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };
const VERSION = "2.1.3";
const LISTED = {
  cli: "claude-code",
  version: VERSION,
  os: platform(),
  profile: CLI_PROFILES["claude-code"].standard,
  model: "synthetic-model",
  verifiedOn: "2026-12-01",
};
const listed: TestBuildExecution = { decideAs: "production", verified: [LISTED] };
const unlisted: TestBuildExecution = { decideAs: "production", verified: [] };

let dir: string;
let db: SqlDriver;
let server: RunningServer | undefined;
let runner: JobRunner | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-held-"));
  seedDataDir(dir);
  db = openCanonicalDb(dir);
});
afterEach(async () => {
  await server?.close();
  await runner?.stop();
  server = undefined;
  runner = undefined;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function consent(
  egress: EgressControls,
  providerId: "local-model" | "claude-code" | "openai-compatible",
) {
  const shown = egress.overview().providers.find((p) => p.providerId === providerId);
  const granted = egress.grant(providerId, ["general"], {
    destination: shown?.destination ?? "",
    policyVersion: egress.policyVersion(),
  });
  if ("error" in granted) throw new Error(granted.error);
}

/** The product's Broker and runner with one Provider double, the way boot.ts joins them. */
function pipeline(provider: FakeProvider, testBuild?: TestBuildExecution) {
  const egress = productEgress(db);
  writeSetting(db, DEFAULT_PROVIDER_SETTING, provider.id);
  const calls = productCalls(
    db,
    egress,
    testBuild ? { providers: [provider], testBuild } : { providers: [provider] },
  );
  runner = productRunner(db, calls.broker, { policyFingerprint: calls.policyFingerprint });
  return { egress, calls, runner, importer: productImporter(db, { runner }) };
}

const localDouble = () =>
  new FakeProvider({ id: "local-model", transport: "http", answer: fixtureExtraction() });
const apiKeyDouble = () =>
  new FakeProvider({ id: "openai-compatible", transport: "http", answer: fixtureExtraction() });
function cliDouble(counter?: { queries: number }) {
  return new FakeProvider({
    id: "claude-code",
    transport: "cli",
    detect: async () => {
      if (counter) counter.queries++;
      return { installed: true, version: VERSION };
    },
    answer: fixtureExtraction(),
  });
}
// K01: the Wiki's own `wiki-build` jobs are not what this file's jobs are about
const jobs = () =>
  db.all("SELECT status, reason, attempts FROM jobs WHERE kind <> 'wiki-build' ORDER BY id");
const ids = () =>
  db.all("SELECT id FROM jobs WHERE kind <> 'wiki-build' ORDER BY id").map((r) => r.id as number);

async function api(pipe: ReturnType<typeof pipeline>, wake = true) {
  server = await startServer({
    token: TOKEN,
    allowedOrigins: [],
    connectors,
    db,
    dataDirectory: dir,
    egress: pipe.egress,
    calls: pipe.calls,
    onRunConditionsChanged: () => wake && void pipe.runner.wake(),
    ...productAdapters(dir),
  });
  const headers = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` };
  const port = server.port;
  return (path: string, body: unknown) => send(port, path, headers, "POST", body);
}

/** Three imported jobs, held for the Broker's reason by the first run. */
async function heldThree(pipe: ReturnType<typeof pipeline>) {
  await pipe.importer(plain);
  await pipe.runner.wake();
  return ids();
}

describe("held.release (I03-R16 ①, ③)", () => {
  it("releases only the jobs a consent can lift, inside the consent's own transaction", async () => {
    const provider = localDouble();
    const pipe = pipeline(provider);
    const post = await api(pipe, false); // no wake: the release is not left to a callback
    const [a, b, c] = (await heldThree(pipe)) as [number, number, number];
    expect(jobs()).toEqual(Array(3).fill({ status: "held", reason: "no-consent", attempts: 0 }));
    db.run("UPDATE jobs SET reason = 'cli-background-off' WHERE id = ?", [a]);
    db.run("UPDATE jobs SET reason = 'source-too-large' WHERE id = ?", [c]);

    expect(provider.requests).toHaveLength(0); // held: no Provider call
    const history = db.all("SELECT count(*) AS n FROM provider_calls");
    const shown = pipe.egress.overview().providers.find((p) => p.providerId === "local-model");
    const answer = await post(routes.grantConsent.path, {
      providerId: "local-model",
      allowedClasses: ["general"],
      destination: shown?.destination,
      policyVersion: pipe.egress.policyVersion(),
    });
    expect(answer.status).toBe(200);
    expect(provider.requests).toHaveLength(0); // the release calls nobody
    expect(db.all("SELECT count(*) AS n FROM provider_calls")).toEqual(history); // and writes no history
    expect([a, b, c].map((id) => readJob(db, id)?.status)).toEqual(["held", "queued", "held"]);
    expect(readJob(db, b)).toMatchObject({ reason: null, attempts: 0 });

    await pipe.runner.wake(); // the next claim judges it again, and the Provider is called
    expect(readJob(db, b)?.status).toBe("succeeded");
    expect(provider.requests).toHaveLength(1); // only the released job's call
  });

  it("keeps the development exception's reasons liftable outside a production build", async () => {
    // a production bundle leaves them out (artifact.contents): only the exception gives them
    const pipe = pipeline(localDouble());
    const ids = (await heldThree(pipe)) as [number, number, number];
    const [a, b, c] = ids;
    db.run("UPDATE jobs SET reason = 'unverified-ack-required' WHERE id = ?", [a]);
    db.run("UPDATE jobs SET reason = 'unverified-background' WHERE id = ?", [b]);
    db.run("UPDATE jobs SET reason = 'unverified-malicious' WHERE id = ?", [c]);
    expect(releaseHeldOnEvent(db, "default-provider")).toBe(3);
    // every reason of the exception, not only the three set above
    expect(Object.keys(HELD_REASONS)).toEqual(
      expect.arrayContaining([
        "unverified-background",
        "unverified-not-synthetic",
        "unverified-malicious",
        "unverified-ack-required",
      ]),
    );
    expect(ids.map((id) => readJob(db, id)?.status)).toEqual(["queued", "queued", "queued"]);
  });

  it("writes the consent and the release in one transaction: a failing release leaves no consent", async () => {
    const pipe = pipeline(localDouble());
    const post = await api(pipe);
    await heldThree(pipe);
    db.exec(
      `CREATE TRIGGER no_release BEFORE UPDATE OF status ON jobs WHEN NEW.status = 'queued'
       BEGIN SELECT RAISE(ABORT, 'release failed'); END`,
    );
    const shown = pipe.egress.overview().providers.find((p) => p.providerId === "local-model");
    const answer = await post(routes.grantConsent.path, {
      providerId: "local-model",
      allowedClasses: ["general"],
      destination: shown?.destination,
      policyVersion: pipe.egress.policyVersion(),
    });
    expect(answer.status).not.toBe(200);
    expect(readConsent(db, "local-model")).toBeUndefined();
    expect(jobs()).toEqual(Array(3).fill({ status: "held", reason: "no-consent", attempts: 0 }));
  });

  it("lets the background setting lift cli-background-off jobs only", async () => {
    const pipe = pipeline(cliDouble(), listed);
    consent(pipe.egress, "claude-code");
    const post = await api(pipe, false);
    const [a, b] = (await heldThree(pipe)) as [number, number, number];
    expect(jobs()).toEqual(
      Array(3).fill({ status: "held", reason: "cli-background-off", attempts: 0 }),
    );
    db.run("UPDATE jobs SET reason = 'no-consent' WHERE id = ?", [b]);

    await post(routes.setExecutionSettings.path, { cliBackground: true });
    expect([a, b].map((id) => readJob(db, id)?.status)).toEqual(["queued", "held"]);
  });

  it("lets the endpoint setting lift a consent-stale-destination job, and a consent revoke the no-consent ones", async () => {
    const pipe = pipeline(localDouble());
    const post = await api(pipe, false);
    const [a, b] = (await heldThree(pipe)) as [number, number, number];
    db.run("UPDATE jobs SET reason = 'consent-stale-destination' WHERE id = ?", [a]);
    await post(routes.writeSettings.path, {
      openaiCompatible: { baseUrl: "https://api.example.invalid/v1", model: "m" },
    });
    expect([a, b].map((id) => readJob(db, id)?.status)).toEqual(["queued", "held"]);

    await post(routes.revokeConsent.path, { providerId: "local-model" });
    expect(readJob(db, b)?.status).toBe("queued");
  });

  it("lets a changed default Provider lift a no-provider job", async () => {
    const pipe = pipeline(localDouble());
    consent(pipe.egress, "local-model");
    const post = await api(pipe, false);
    db.run("DELETE FROM settings WHERE key = ?", [DEFAULT_PROVIDER_SETTING]);
    const [a] = (await heldThree(pipe)) as [number];
    expect(readJob(db, a)).toMatchObject({ status: "held", reason: "no-provider" });
    await post(routes.setDefaultProvider.path, { providerId: "local-model" });
    expect(readJob(db, a)?.status).toBe("queued");
  });

  it("does not lift a no-consent job by a restart alone, but lifts policy jobs once the policy fingerprint changed", async () => {
    const pipe = pipeline(localDouble());
    const [a, b, c] = (await heldThree(pipe)) as [number, number, number];
    const fp = pipe.calls.policyFingerprint();
    expect(readJob(db, a)?.policyFingerprint).toBe(fp); // written when the run held it
    db.run("UPDATE jobs SET reason = 'rule-denied' WHERE id = ?", [b]);
    db.run("UPDATE jobs SET reason = 'source-too-large' WHERE id = ?", [c]);

    expect(releaseOnPolicyChange(db, fp, pipe.runner)).toBe(0); // same fingerprint: nothing
    expect(jobs().map((j) => j.status)).toEqual(["held", "held", "held"]);

    expect(releaseOnPolicyChange(db, "pf-changed", pipe.runner)).toBe(1); // the rule one only
    expect([a, b, c].map((id) => readJob(db, id)?.status)).toEqual(["held", "queued", "held"]);
  });
});

describe("held.precheck (I03-R16 ②)", () => {
  /** n held jobs for `reason`, registered on the one imported source's versions. */
  async function held(pipe: ReturnType<typeof pipeline>, n: number, reason: string) {
    await pipe.importer(plain);
    const source = db.all("SELECT source_id AS s FROM jobs LIMIT 1")[0]?.s as number;
    db.run("DELETE FROM jobs");
    for (let i = 1; i <= n; i++) {
      const r = registerJob(db, { kind: "extract", sourceId: source, fenceVersion: i });
      if (!r.registered) throw new Error("expected a new job");
    }
    db.run("UPDATE jobs SET status = 'held', reason = ?", [reason]);
  }

  it("judges 200 jobs held for cli-not-verified once: one version query, no history, all still held; a changed list frees them together", async () => {
    const counter = { queries: 0 };
    const cli = cliDouble(counter);
    const blocked = pipeline(cli, unlisted);
    consent(blocked.egress, "claude-code");
    writeSetting(db, CLI_BACKGROUND_SETTING, "on");
    await held(blocked, 200, "cli-not-verified");
    counter.queries = 0; // the import's own run asked once already
    const history = db.all("SELECT count(*) AS n FROM provider_calls");

    expect(await reevaluateHeldJobs(db, blocked.calls.broker)).toBe(0);
    expect(counter.queries).toBe(1);
    expect(db.all("SELECT count(*) AS n FROM provider_calls")).toEqual(history);
    expect(cli.requests).toHaveLength(0);
    expect(db.all("SELECT count(*) AS n FROM jobs WHERE status = 'held' AND attempts = 0")).toEqual(
      [{ n: 200 }],
    );

    const fixed = pipeline(cli, listed); // the verified list changed
    expect(await reevaluateHeldJobs(db, fixed.calls.broker)).toBe(200);
    expect(counter.queries).toBe(2);
    expect(db.all("SELECT count(*) AS n FROM jobs WHERE status = 'queued'")).toEqual([{ n: 200 }]);
  });

  it("leaves no-consent and size holds alone: they are not judged by the clock", async () => {
    const pipe = pipeline(cliDouble(), listed);
    consent(pipe.egress, "claude-code");
    writeSetting(db, CLI_BACKGROUND_SETTING, "on");
    await held(pipe, 3, "no-consent");
    db.run("UPDATE jobs SET reason = 'source-too-large' WHERE id = 1");
    expect(await reevaluateHeldJobs(db, pipe.calls.broker)).toBe(0);
    expect(jobs().map((j) => j.status)).toEqual(["held", "held", "held"]);
  });

  it("judges no-provider once a default Provider is chosen", async () => {
    const pipe = pipeline(localDouble());
    consent(pipe.egress, "local-model");
    await held(pipe, 2, "no-provider");
    expect(await reevaluateHeldJobs(db, pipe.calls.broker)).toBe(2);
  });
});

describe("background.gate (I03-R15, C3)", () => {
  it("holds a scheduled job and a manually retried job's CLI call with cli-background-off, calling nothing", async () => {
    const cli = cliDouble();
    const pipe = pipeline(cli, listed);
    consent(pipe.egress, "claude-code");
    const [a, b] = (await heldThree(pipe)) as [number, number, number];
    db.run(
      "UPDATE jobs SET status = 'queued', reason = NULL, priority = 'scheduled' WHERE id = ?",
      [a],
    );
    db.run("UPDATE jobs SET status = 'dead_letter', reason = 'invalid-output' WHERE id = ?", [b]);
    const actions = createJobActions({ db, runner: pipe.runner });
    expect(actions.retry(b)).toBe("queued");
    await pipe.runner.wake();
    expect(cli.requests).toHaveLength(0);
    expect([a, b].map((id) => readJob(db, id))).toMatchObject([
      { status: "held", reason: "cli-background-off", attempts: 0 },
      { status: "held", reason: "cli-background-off", attempts: 0 },
    ]);
  });

  it("runs a scheduled job through an API key Provider the consent and rules allow, and holds it once the consent is withdrawn", async () => {
    const provider = apiKeyDouble();
    const pipe = pipeline(provider, listed);
    const baseUrl = "https://api.example.invalid/v1";
    writeSetting(db, "providers.openaiCompatible.baseUrl", baseUrl);
    consent(pipe.egress, "openai-compatible");
    await pipe.importer(plain);
    db.run("UPDATE jobs SET priority = 'scheduled'");
    await pipe.runner.wake();
    expect(provider.requests).toHaveLength(3);
    expect(jobs().map((j) => j.status)).toEqual(Array(3).fill("succeeded"));

    pipe.egress.revoke("openai-compatible");
    const first = JSON.parse(plain.split("\n")[0] ?? "{}") as Record<string, unknown>;
    await pipe.importer(
      JSON.stringify({ ...first, id: "x-1", external_id: "<x-1@mail.example.test>" }),
    );
    db.run("UPDATE jobs SET priority = 'scheduled' WHERE status = 'queued'");
    await pipe.runner.wake();
    expect(provider.requests).toHaveLength(3); // no new call
    expect(db.all("SELECT reason FROM jobs WHERE status = 'held'")).toEqual([
      { reason: "no-consent" },
    ]);
  });

  it("gives the runner no user action record: its Broker calls name the job and carry none", async () => {
    const requests: unknown[] = [];
    const broker = {
      call: async (request: unknown) => {
        requests.push(request);
        return { status: "blocked", requestId: "r", reason: "no-consent" } as const;
      },
      budgetUsage: () => ({ used: 0, maxCalls: 1, windowMs: 1, resetsAt: null }),
    };
    runner = productRunner(db, broker);
    const importer = productImporter(db, { runner });
    await importer(plain);
    await runner.wake();
    expect(requests).toHaveLength(3);
    for (const request of requests as { origin: Record<string, unknown> }[]) {
      expect(Object.keys(request.origin).sort()).toEqual(["jobId", "leaseToken"]);
    }
    // the issuer exists only in what productCalls hands the API layer
    const calls = productCalls(db, productEgress(db), { providers: [] });
    expect(Object.keys(calls).sort()).toEqual([
      "broker",
      "execution",
      "issuer",
      "policyFingerprint",
      "providers",
    ]);
  });
});

describe("manual-retry (I03-R12 ① ②, C3)", () => {
  it("runs a dead letter again with no attempts used, and discards another", async () => {
    const provider = localDouble();
    const pipe = pipeline(provider);
    consent(pipe.egress, "local-model");
    const actions = createJobActions({ db, runner: pipe.runner });
    await pipe.importer(plain);
    const [a, b] = ids() as [number, number];
    db.run(
      "UPDATE jobs SET status = 'dead_letter', reason = 'invalid-output', attempts = 3 WHERE id IN (?, ?)",
      [a, b],
    );
    db.run("UPDATE jobs SET priority = 'maintenance' WHERE id = ?", [a]);
    expect(actions.discard(b)).toBe("discarded");
    expect(actions.retry(a)).toBe("queued");
    expect(readJob(db, a)).toMatchObject({ status: "queued", attempts: 0, priority: "user" });
    await pipe.runner.wake();
    expect(readJob(db, a)?.status).toBe("succeeded");
    expect(readJob(db, b)?.status).toBe("cancelled");
  });

  it("closes a retried job superseded when its source changed meanwhile", async () => {
    const provider = localDouble();
    const pipe = pipeline(provider);
    consent(pipe.egress, "local-model");
    const actions = createJobActions({ db, runner: pipe.runner });
    await pipe.importer(plain);
    await pipe.runner.wake(); // the import's own run ends first
    const [a] = ids() as [number];
    db.run("UPDATE jobs SET status = 'dead_letter', reason = 'invalid-output' WHERE id = ?", [a]);
    // a new version of the job's source arrives while the job lies dead
    const sourceId = readJob(db, a)?.sourceId as number;
    db.run(
      "INSERT INTO source_versions (source_id, version, title, body, content_hash) SELECT source_id, version + 1, title, body, content_hash || 'x' FROM source_versions WHERE source_id = ? ORDER BY version DESC LIMIT 1",
      [sourceId],
    );
    expect(actions.retry(a)).toBe("queued");
    const before = provider.requests.length;
    await pipe.runner.wake();
    expect(readJob(db, a)?.status).toBe("superseded");
    expect(provider.requests.length).toBe(before); // no call for a version that is gone
  });

  it("holds a retried held job again, attempts 0, while its condition stands", async () => {
    const pipe = pipeline(localDouble());
    const actions = createJobActions({ db, runner: pipe.runner });
    const [a] = (await heldThree(pipe)) as [number];
    expect(actions.retry(a)).toBe("queued");
    await vi.waitFor(() =>
      expect(readJob(db, a)).toMatchObject({ status: "held", reason: "no-consent", attempts: 0 }),
    );
  });
});

describe("computePolicyFingerprint (I03-R2, R16 ③)", () => {
  const base = { policyVersion: "pv-1", verified: [{ cli: "x" }], defaultProvider: "codex" };
  it("is equal for equal inputs and changes with each input alone", () => {
    const fp = computePolicyFingerprint(base);
    expect(computePolicyFingerprint({ ...base, verified: [{ cli: "x" }] })).toBe(fp);
    expect(computePolicyFingerprint({ ...base, policyVersion: "pv-2" })).not.toBe(fp);
    expect(computePolicyFingerprint({ ...base, verified: [] })).not.toBe(fp);
    expect(computePolicyFingerprint({ ...base, defaultProvider: "claude-code" })).not.toBe(fp);
    expect(computePolicyFingerprint({ ...base, defaultProvider: undefined })).not.toBe(fp);
  });
});

describe("startHeldReevaluation (I03-R16 ②, fake clock)", () => {
  afterEach(() => vi.useRealTimers());

  it("judges held jobs at start and every hour, and a blocked verdict leaves them held with attempts 0", async () => {
    vi.useFakeTimers();
    const pipe = pipeline(localDouble());
    await pipe.importer(plain);
    await pipe.runner.wake();
    db.run("UPDATE jobs SET reason = 'cli-not-verified'"); // held, as an unlisted CLI leaves them
    let allowed = false;
    const precheck = vi.fn(async () =>
      allowed
        ? ({ allowed: true } as const)
        : ({ allowed: false, reason: "cli-not-verified" } as const),
    );
    const wake = vi.fn(async () => {});
    const pass = startHeldReevaluation({ db, broker: { precheck }, runner: { wake } });

    await vi.advanceTimersByTimeAsync(0); // the start pass
    expect(precheck).toHaveBeenCalledTimes(1);
    expect(jobs()).toEqual(
      Array(3).fill({ status: "held", reason: "cli-not-verified", attempts: 0 }),
    );
    await vi.advanceTimersByTimeAsync(HELD_REEVALUATION_MS - 1);
    expect(precheck).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // the hour
    expect(precheck).toHaveBeenCalledTimes(2);
    expect(jobs().every((j) => j.status === "held" && j.attempts === 0)).toBe(true);

    allowed = true; // the verified list changed: the next hour frees them together
    await vi.advanceTimersByTimeAsync(HELD_REEVALUATION_MS);
    expect(jobs().map((j) => j.status)).toEqual(Array(3).fill("queued"));
    expect(wake).toHaveBeenCalledTimes(1);

    pass.stop();
    await vi.advanceTimersByTimeAsync(HELD_REEVALUATION_MS * 2);
    expect(precheck).toHaveBeenCalledTimes(3);
  });

  it("frees at start what the verified list already allows", async () => {
    vi.useFakeTimers();
    const pipe = pipeline(localDouble());
    await pipe.importer(plain);
    await pipe.runner.wake();
    db.run("UPDATE jobs SET reason = 'cli-not-verified'");
    const wake = vi.fn(async () => {});
    const pass = startHeldReevaluation({
      db,
      broker: { precheck: async () => ({ allowed: true }) },
      runner: { wake },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(jobs().map((j) => j.status)).toEqual(Array(3).fill("queued"));
    pass.stop();
  });
});
