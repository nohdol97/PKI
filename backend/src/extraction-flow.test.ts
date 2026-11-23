// flow.insight and flow.date-variant (V02-C1) through the product's pieces:
// the JSONL import registers extraction jobs, the composition point's runner
// extracts them through the product Broker (consent, egress, run conditions) with
// the per-fixture Provider double, links A and B across the three sources and the
// rule makes one inferred Insight with three evidence. Imported files grade
// "general", so consent covers "general". And what happens to the flow while the
// background setting is off (default) or consent is missing: jobs are held with
// the Broker's reason, no Provider call, and released in their own rows when the
// setting, the consent or the egress rules change (V02 미해결 질문 7).
import { routes } from "@pki/contracts";
import {
  CLI_PROFILES,
  DEFAULT_PROVIDER_SETTING,
  type EgressControls,
  type TestBuildExecution,
} from "@pki/providers";
import { readJob, writeSetting, type SqlDriver } from "@pki/storage";
import { FakeProvider, fixtureExtraction, send, dirTemplate } from "@pki/testkit";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openCanonicalDb,
  productAdapters,
  productCalls,
  productEgress,
  productImporter,
  productRunner,
} from "./composition.ts";
import { releaseHeldOnEvent, releaseOnPolicyChange } from "./held-release.ts";
import type { ConnectorManager } from "./connectors.ts";
import type { JobRunner } from "./job-runner.ts";
import { startServer, type RunningServer } from "./server.ts";

const seedDataDir = dirTemplate((path) => openCanonicalDb(path).close());

const FIXTURES = resolve(import.meta.dirname, "../../fixtures");
const read = (name: string) => readFileSync(resolve(FIXTURES, name), "utf8");
interface Evidence {
  record_id: string;
  version: number;
  span: [number, number];
  quote: string;
}
const expected = JSON.parse(read("v02-expected.json")) as {
  sets: Record<string, { files: string[]; insights: { evidence: Evidence[] }[] }>;
};
const fileText = (set: string) => expected.sets[set]?.files.map(read).join("\n") ?? "";
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

let dir: string;
let db: SqlDriver;
let server: RunningServer | undefined;
let runner: JobRunner | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-flow-"));
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

function consent(egress: EgressControls, providerId: "local-model" | "claude-code") {
  const shown = egress.overview().providers.find((p) => p.providerId === providerId);
  const granted = egress.grant(providerId, ["general"], {
    destination: shown?.destination ?? "",
    policyVersion: egress.policyVersion(),
  });
  if ("error" in granted) throw new Error(granted.error);
}

/** The product's Broker and runner with one Provider double; the import wakes the runner. */
function pipeline(provider: FakeProvider, testBuild?: TestBuildExecution) {
  const egress = productEgress(db);
  writeSetting(db, DEFAULT_PROVIDER_SETTING, provider.id); // the user's default (V01-T10)
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
const cliDouble = () =>
  new FakeProvider({
    id: "claude-code",
    transport: "cli",
    detect: async () => ({ installed: true, version: VERSION }),
    answer: fixtureExtraction(),
  });
// K01: the Wiki's own `wiki-build` jobs are not what this file's jobs are about
const jobs = () => db.all("SELECT status, reason FROM jobs WHERE kind <> 'wiki-build' ORDER BY id");

describe("flow.insight", () => {
  it("links A and B across the three imported sources into one inferred Insight with three evidence", async () => {
    const provider = localDouble();
    const { egress, runner, importer } = pipeline(provider);
    consent(egress, "local-model");
    expect(await importer(fileText("plain"))).toMatchObject({ created: 3, errorCount: 0 });
    await runner.wake();

    expect(provider.requests).toHaveLength(3);
    expect(provider.requests.map((r) => r.dataClassification)).toEqual([
      "general",
      "general",
      "general",
    ]);
    expect(jobs()).toEqual([
      { status: "succeeded", reason: null },
      { status: "succeeded", reason: null },
      { status: "succeeded", reason: null },
    ]);
    expect(db.all("SELECT type, name FROM items ORDER BY id")).toEqual([
      { type: "Project", name: "미리내 프로젝트" },
      { type: "System", name: "물결 API" },
    ]);
    const insights = db.all("SELECT id, epistemic, state FROM insights");
    expect(insights).toEqual([{ id: 1, epistemic: "inferred", state: "active" }]);
    const evidence = db.all(
      `SELECT s.external_id, v.version, e.start_offset, e.end_offset, e.quote
         FROM insight_evidence ie JOIN evidence e ON e.id = ie.evidence_id
         JOIN source_versions v ON v.id = e.source_version_id
         JOIN sources s ON s.id = v.source_id ORDER BY e.start_offset`,
    );
    const want = expected.sets.plain?.insights[0]?.evidence ?? [];
    expect(evidence.map((e) => [e.version, e.start_offset, e.end_offset, e.quote])).toEqual(
      want
        .map((e) => [e.version, e.span[0], e.span[1], e.quote])
        .sort((a, b) => (a[1] as number) - (b[1] as number)),
    );
    expect(db.all("SELECT sum(dropped_quotes) AS q, sum(dropped_other) AS o FROM jobs")).toEqual([
      { q: 0, o: 0 },
    ]);
  });
});

describe("flow.date-variant", () => {
  it("makes no Insight when B finishes before A's target", async () => {
    const { egress, runner, importer } = pipeline(localDouble());
    consent(egress, "local-model");
    await importer(fileText("date-variant"));
    await runner.wake();
    expect(jobs().map((j) => j.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(db.all("SELECT value FROM facts WHERE kind = 'completion_date'")).toEqual([
      { value: "2026-12-03" },
    ]);
    expect(db.all("SELECT count(*) AS n FROM relations")).toEqual([{ n: 1 }]);
    expect(db.all("SELECT * FROM insights")).toEqual([]);
  });
});

describe("held extraction", () => {
  async function api(egress: EgressControls, run: JobRunner) {
    server = await startServer({
      token: TOKEN,
      allowedOrigins: [],
      connectors,
      db,
      dataDirectory: dir,
      egress,
      onRunConditionsChanged: () => void run.wake(),
      ...productAdapters(dir),
    });
    const port = server.port;
    const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
    return (path: string, body: unknown) => send(port, path, headers, "POST", body);
  }

  it("holds a listed CLI's jobs while the background setting is off (default), runs them once it is on", async () => {
    const provider = cliDouble();
    const { egress, runner, importer } = pipeline(provider, listed);
    consent(egress, "claude-code");
    const post = await api(egress, runner);
    await importer(fileText("plain"));
    await runner.wake();
    expect(provider.requests).toHaveLength(0);
    expect(jobs()).toEqual(Array(3).fill({ status: "held", reason: "cli-background-off" }));

    await post(routes.setExecutionSettings.path, { cliBackground: true });
    await runner.wake(); // the release woke it already; this waits for the drain
    expect(provider.requests).toHaveLength(3);
    expect(jobs().map((j) => j.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(db.all("SELECT count(*) AS n FROM jobs WHERE kind <> 'wiki-build'")).toEqual([{ n: 3 }]); // same rows
    expect(db.all("SELECT state FROM insights")).toEqual([{ state: "active" }]);
  });

  it("holds without consent and runs after the user grants it through the API", async () => {
    const provider = localDouble();
    const { egress, runner, importer } = pipeline(provider);
    const post = await api(egress, runner);
    await importer(fileText("plain"));
    await runner.wake();
    expect(jobs()).toEqual(Array(3).fill({ status: "held", reason: "no-consent" }));

    const shown = egress.overview().providers.find((p) => p.providerId === "local-model");
    await post(routes.grantConsent.path, {
      providerId: "local-model",
      allowedClasses: ["general"],
      destination: shown?.destination,
      policyVersion: egress.policyVersion(),
    });
    await runner.wake();
    expect(provider.requests).toHaveLength(3);
    expect(jobs().map((j) => j.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
  });

  it("releases every held job a changed default Provider can lift but one held for size: settings cannot make a source smaller", async () => {
    const { runner, importer } = pipeline(localDouble());
    await importer(fileText("plain"));
    await runner.wake();
    const [first, second] = db.all("SELECT id FROM jobs ORDER BY id") as [
      { id: number },
      { id: number },
    ];
    db.run("UPDATE jobs SET reason = 'source-too-large' WHERE id = ?", [first.id]);
    expect(releaseHeldOnEvent(db, "default-provider")).toBe(2);
    expect(readJob(db, first.id)).toMatchObject({ status: "held", reason: "source-too-large" });
    expect(readJob(db, second.id)?.status).not.toBe("held");
    await runner.wake();
  });

  it("stamps a hold with its policy and releases at start only what a changed fingerprint can end", async () => {
    const { calls, runner, importer } = pipeline(localDouble());
    await importer(fileText("plain"));
    await runner.wake();
    const [first] = db.all("SELECT id FROM jobs ORDER BY id") as [{ id: number }];
    const fingerprint = calls.policyFingerprint();
    expect(readJob(db, first.id)).toMatchObject({ status: "held", policyFingerprint: fingerprint });

    expect(releaseOnPolicyChange(db, fingerprint, runner)).toBe(0); // same policy: stays held
    expect(releaseOnPolicyChange(db, "pf-older", runner)).toBe(0); // no consent is not a policy matter
    db.run("UPDATE jobs SET reason = 'rule-denied'");
    expect(releaseOnPolicyChange(db, "pf-older", runner)).toBe(3);
  });
});
