// V01-C4 `cli-gate` (V01-R10, ARCHITECTURE 3.1): every execution-condition case on
// a test build, each picking "decide as production" or "as development", with a
// CLI-transport double. User calls are the connection test through the API (and,
// for input other than the fixed material, a user action record the API layer's
// issuer opens); background calls name a job row in the canonical jobs table.
// The product wiring runs: productEgress, productCalls (Broker, execution gate,
// history), the API server, a real canonical file.
import { routes, type ConnectionTestResult, type ProviderCall } from "@pki/contracts";
import { CLI_PROFILES, type TestBuildExecution } from "@pki/providers";
import { registerConnectorInstance, saveSourceRecord, type SqlDriver } from "@pki/storage";
import { FakeProvider, send } from "@pki/testkit";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCanonicalDb, productAdapters, productCalls, productEgress } from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import { startServer, type RunningServer } from "./server.ts";

const TOKEN = "g".repeat(43);
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };
const OS = platform();
const VERSION = "2.1.3";
const STANDARD = CLI_PROFILES["claude-code"].standard;
const MINIMAL = CLI_PROFILES["claude-code"].minimal;
const LISTED = {
  cli: "claude-code",
  version: VERSION,
  os: OS,
  profile: STANDARD,
  verifiedOn: "2026-12-01",
};

const fixtures = readFileSync(
  resolve(import.meta.dirname, "../../fixtures/test-connector.jsonl"),
  "utf8",
)
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as { title: string; body: string; malicious?: boolean });
const plain = fixtures.find((f) => !f.malicious);
const malicious = fixtures.find((f) => f.malicious);
if (!plain || !malicious) throw new Error("fixtures need a plain and a malicious record");

let dir: string;
let db: SqlDriver;
let server: RunningServer | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-cli-gate-"));
  db = openCanonicalDb(dir);
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
/** Stores a source as the test Connector's sync would; returns its version ID. */
function store(record: { title: string; body: string }): string {
  registerConnectorInstance(db, "fixtures", "test-fixtures");
  saveSourceRecord(db, "fixtures", { externalId: `gate-${++seq}`, ...record });
  return String(db.all("SELECT max(id) AS id FROM source_versions")[0]?.id);
}

/** A job row, as V02's runner will queue one: the Broker calls it background. */
function job(sourceVersionId: string): string {
  db.run("INSERT INTO jobs (kind, source_version_id, status) VALUES ('extract', ?, 'queued')", [
    Number(sourceVersionId),
  ]);
  return String(db.all("SELECT max(id) AS id FROM jobs")[0]?.id);
}

interface Stack {
  testBuild?: TestBuildExecution;
  /** What the CLI double's version query reports, read before every attempt. */
  version?: () => string | undefined;
}

async function stack(options: Stack = {}) {
  const egress = productEgress(db);
  // consent for both classes, so only the execution conditions decide
  const shown = egress.overview().providers.find((p) => p.providerId === "claude-code");
  const granted = egress.grant("claude-code", ["synthetic", "general"], {
    destination: shown?.destination ?? "",
    policyVersion: egress.policyVersion(),
  });
  if ("error" in granted) throw new Error(granted.error);
  const version = options.version ?? (() => VERSION);
  const provider = new FakeProvider({
    id: "claude-code",
    transport: "cli",
    detect: async () => {
      const v = version();
      return v === undefined ? { installed: true } : { installed: true, version: v };
    },
    answer: (r) => (r.taskKind === "extract" ? { claims: [] } : { reply: "ok" }),
  });
  const calls = productCalls(
    db,
    egress,
    options.testBuild === undefined
      ? { providers: [provider] }
      : { providers: [provider], testBuild: options.testBuild },
  );
  server = await startServer({
    token: TOKEN,
    allowedOrigins: [],
    connectors,
    db,
    dataDirectory: dir,
    egress,
    calls,
    ...productAdapters(),
  });
  const port = server.port;
  const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
  return {
    provider,
    /** The connection test the Settings screen sends. */
    connectionTest: async (acknowledgeUnverified = false) =>
      (await send(port, routes.connectionTest.path, headers, "POST", { acknowledgeUnverified }))
        .body as ConnectionTestResult,
    background: async (on: boolean) =>
      send(port, routes.setExecutionSettings.path, headers, "POST", { cliBackground: on }),
    /** A user call with stored input: only the API layer's issuer can open one. */
    userExtract: (ids: string[], acknowledgeUnverified = true) =>
      calls.issuer.during(
        (userActionId) =>
          calls.broker.call({
            taskKind: "extract",
            sourceVersionIds: ids,
            candidateItemIds: [],
            origin: { userActionId },
            schemaVersion: 1,
            budget: { timeoutMs: 1000 },
            retryable: false,
          }),
        { acknowledgeUnverified },
      ),
    backgroundExtract: (sourceVersionId: string) =>
      calls.broker.call({
        taskKind: "extract",
        sourceVersionIds: [sourceVersionId],
        candidateItemIds: [],
        origin: { jobId: job(sourceVersionId) },
        schemaVersion: 1,
        budget: { timeoutMs: 1000 },
        retryable: false,
      }),
    history: async () =>
      ((await send(port, routes.activity.path, headers)).body as { calls: ProviderCall[] }).calls,
  };
}

const asProduction = (verified: unknown[] = [LISTED]): TestBuildExecution => ({
  decideAs: "production",
  verified,
});
const asDevelopment: TestBuildExecution = { decideAs: "development", verified: [] };

describe("listed combination, deciding as production", () => {
  it("① runs a user call with the listed profile, marked verified", async () => {
    const s = await stack({ testBuild: asProduction() });
    expect(await s.connectionTest()).toEqual({
      outcome: "ok",
      reason: null,
      isolation: "verified",
    });
    expect(s.provider.requests.map((r) => r.execution)).toEqual([
      { profile: STANDARD, isolation: "verified" },
    ]);
  });

  it("② runs a background call while the background setting is on", async () => {
    const s = await stack({ testBuild: asProduction() });
    expect((await s.background(true)).body).toEqual({ cliBackground: true });
    expect(await s.backgroundExtract(store(plain))).toMatchObject({
      status: "ok",
      cli: { profile: STANDARD, isolation: "verified" },
    });
    expect(s.provider.requests).toHaveLength(1);
    expect(s.provider.requests[0]?.trigger).toBe("background");
  });

  it("③ blocks a background call with the setting off (the default)", async () => {
    const s = await stack({ testBuild: asProduction() });
    expect(await s.backgroundExtract(store(plain))).toMatchObject({
      status: "blocked",
      reason: "cli-background-off",
    });
    expect(s.provider.requests).toEqual([]);
    expect((await s.history()).map((c) => [c.outcome, c.reason])).toEqual([
      ["blocked", "cli-background-off"],
    ]);
  });
});

describe("combination not listed, deciding as production", () => {
  it("④ blocks a user call, acknowledged or not", async () => {
    const s = await stack({ testBuild: asProduction([]) });
    expect(await s.connectionTest(true)).toEqual({
      outcome: "blocked",
      reason: "cli-not-verified",
      isolation: null,
    });
    expect(await s.connectionTest(false)).toEqual({
      outcome: "blocked",
      reason: "cli-not-verified",
      isolation: null,
    });
    expect(s.provider.requests).toEqual([]);
  });

  it("⑤ blocks a background call, the setting on", async () => {
    const s = await stack({ testBuild: asProduction([]) });
    await s.background(true);
    expect(await s.backgroundExtract(store(plain))).toMatchObject({
      status: "blocked",
      reason: "cli-not-verified",
    });
    expect(s.provider.requests).toEqual([]);
  });
});

describe("combination not listed, deciding as development", () => {
  it("⑥ runs an acknowledged synthetic user call with the minimal profile, marked unverified", async () => {
    const s = await stack({ testBuild: asDevelopment });
    expect(await s.connectionTest(true)).toEqual({
      outcome: "ok",
      reason: null,
      isolation: "unverified",
    });
    expect(s.provider.requests.map((r) => r.execution)).toEqual([
      { profile: MINIMAL, isolation: "unverified" },
    ]);
    // the confirmation is not stored: the next call asks again
    expect(await s.connectionTest(false)).toEqual({
      outcome: "blocked",
      reason: "unverified-ack-required",
      isolation: null,
    });
    expect(s.provider.requests).toHaveLength(1);
  });

  it("⑦ blocks a call the user did not acknowledge", async () => {
    const s = await stack({ testBuild: asDevelopment });
    expect(await s.connectionTest(false)).toEqual({
      outcome: "blocked",
      reason: "unverified-ack-required",
      isolation: null,
    });
    expect(s.provider.requests).toEqual([]);
  });

  it("⑧ blocks input that is not synthetic", async () => {
    const s = await stack({ testBuild: asDevelopment });
    const general = store({ title: "Plain note", body: "Not in the synthetic manifest." });
    expect(await s.userExtract([general])).toMatchObject({
      status: "blocked",
      reason: "unverified-not-synthetic",
    });
    // mixed with synthetic input it is still general
    expect(await s.userExtract([store(plain), general])).toMatchObject({
      reason: "unverified-not-synthetic",
    });
    expect(s.provider.requests).toEqual([]);
  });

  it("⑨ blocks a malicious synthetic variant", async () => {
    const s = await stack({ testBuild: asDevelopment });
    expect(await s.userExtract([store(malicious)])).toMatchObject({
      status: "blocked",
      reason: "unverified-malicious",
    });
    expect(s.provider.requests).toEqual([]);
  });

  it("⑩ blocks a background call, synthetic and with the setting on", async () => {
    const s = await stack({ testBuild: asDevelopment });
    await s.background(true);
    expect(await s.backgroundExtract(store(plain))).toMatchObject({
      status: "blocked",
      reason: "unverified-background",
    });
    expect(s.provider.requests).toEqual([]);
  });

  it("runs acknowledged synthetic stored input as a user call too", async () => {
    const s = await stack({ testBuild: asDevelopment });
    expect(await s.userExtract([store(plain)])).toMatchObject({
      status: "ok",
      cli: { profile: MINIMAL, isolation: "unverified" },
    });
  });
});

describe("combination that differs from the list: treated as not listed", () => {
  it("⑪ a CLI updated to another version", async () => {
    let version = VERSION;
    const s = await stack({ testBuild: asProduction(), version: () => version });
    expect(await s.connectionTest()).toMatchObject({ outcome: "ok" });
    version = "2.1.4";
    expect(await s.connectionTest()).toEqual({
      outcome: "blocked",
      reason: "cli-not-verified",
      isolation: null,
    });
    expect(s.provider.requests).toHaveLength(1);
  });

  it("⑫ an entry naming another profile", async () => {
    const s = await stack({ testBuild: asProduction([{ ...LISTED, profile: MINIMAL }]) });
    expect(await s.connectionTest()).toEqual({
      outcome: "blocked",
      reason: "cli-not-verified",
      isolation: null,
    });
  });

  it("⑬ an entry for another OS", async () => {
    const other = OS === "win32" ? "linux" : "win32";
    const s = await stack({ testBuild: asProduction([{ ...LISTED, os: other }]) });
    expect(await s.connectionTest()).toEqual({
      outcome: "blocked",
      reason: "cli-not-verified",
      isolation: null,
    });
  });

  it.each([
    ["not a version", () => "2.1.3 (Claude Code)"],
    ["unreadable", () => undefined],
  ])("⑭ a version that is %s", async (_, version) => {
    const s = await stack({ testBuild: asProduction(), version });
    expect(await s.connectionTest()).toEqual({
      outcome: "blocked",
      reason: "cli-not-verified",
      isolation: null,
    });
    expect(s.provider.requests).toEqual([]);
  });
});

describe("a test build that picks nothing", () => {
  it("decides as production: an unlisted CLI is blocked even acknowledged", async () => {
    const s = await stack({ testBuild: { verified: [] } });
    expect(await s.connectionTest(true)).toEqual({
      outcome: "blocked",
      reason: "cli-not-verified",
      isolation: null,
    });
  });

  it("with no test options at all, uses the build's own (empty) list", async () => {
    const s = await stack();
    expect(await s.connectionTest(true)).toEqual({
      outcome: "blocked",
      reason: "cli-not-verified",
      isolation: null,
    });
    expect(s.provider.requests).toEqual([]);
  });
});
