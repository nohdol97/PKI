// P01-C3a (R7, D15) through the product's pieces: a synthetic JSONL goes in through the import, the Insights the
// rules judge are queued for interpretation once the setting is on, and without consent the job is held, no
// Provider is asked and the Insight row stays as it was. (The setting has no API toggle yet: the storage switch is used.)
import { routes, type RouteName, type RouteRequest, type RouteResponse } from "@pki/contracts";
import { DEFAULT_PROVIDER_SETTING, type EgressControls } from "@pki/providers";
import { readInsight, setInsightInterpret, writeSetting, type SqlDriver } from "@pki/storage";
import { FakeProvider, fixtureExtraction, send, dirTemplate } from "@pki/testkit";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
import type { ConnectorManager } from "./connectors.ts";
import { releaseHeldOnEvent } from "./held-release.ts";
import type { JobRunner } from "./job-runner.ts";
import { startServer, type RunningServer } from "./server.ts";

const seedDataDir = dirTemplate((path) => openCanonicalDb(path).close());

const FIXTURES = resolve(import.meta.dirname, "../../fixtures");
const read = (name: string) => readFileSync(resolve(FIXTURES, name), "utf8");
const TOKEN = "w".repeat(43);
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };

let dir: string;
let db: SqlDriver;
let server: RunningServer | undefined;
let runner: JobRunner | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-wiki-flow-"));
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

function consent(egress: EgressControls) {
  const shown = egress.overview().providers.find((p) => p.providerId === "local-model");
  const granted = egress.grant("local-model", ["general"], {
    destination: shown?.destination ?? "",
    policyVersion: egress.policyVersion(),
  });
  if ("error" in granted) throw new Error(granted.error);
}

/** The product's runner (it queues `wiki-build` itself), the import and the API over one database. */
async function backend() {
  const extraction = fixtureExtraction();
  const egress = productEgress(db);
  const provider = new FakeProvider({
    id: "local-model",
    transport: "http",
    answer: (request) =>
      request.taskKind === "insight-interpret"
        ? { reasoningSummary: "합성 해석", impact: 70, actionability: 30, opportunity: null }
        : extraction(request),
  });
  writeSetting(db, DEFAULT_PROVIDER_SETTING, provider.id);
  const calls = productCalls(db, egress, { providers: [provider] });
  const run = productRunner(db, calls.broker, { policyFingerprint: calls.policyFingerprint });
  runner = run;
  consent(egress);
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
  const headers = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` };
  const port = server.port;
  const call = async <Name extends RouteName>(name: Name, body?: RouteRequest<Name>) => {
    const route = routes[name];
    const res = await send(port, route.path, headers, route.method, body);
    return { status: res.status, body: res.body as RouteResponse<Name> };
  };
  const importer = productImporter(db, { runner: run });
  return {
    call,
    run,
    egress,
    provider,
    importIn: async (text: string) => (await importer(text), await run.wake()),
  };
}

const interpretJobs = () =>
  db.all("SELECT status, reason FROM jobs WHERE kind = 'insight-interpret' ORDER BY id");
const IMPORT = ["v02-mail", "v02-wiki", "v02-messenger"].map((n) => read(`${n}.jsonl`)).join("\n");
const insights = () =>
  db.all("SELECT rule, x_item_id, y_item_id FROM insights WHERE state = 'active'");

describe("insight.interpret-flow: the setting and consent (P01-C3a)", () => {
  it("without consent the job is held, no Provider is asked and the Insight row is unchanged; with consent the reading is stored", async () => {
    const { run, egress, provider, importIn } = await backend();
    await importIn(IMPORT);
    const key = insights()[0] as { rule: string; x_item_id: number; y_item_id: number };
    expect(interpretJobs()).toEqual([]);
    const k = { rule: key.rule, xItemId: key.x_item_id, yItemId: key.y_item_id };
    const before = readInsight(db, k);
    expect(before).toBeDefined();

    egress.revoke("local-model");
    const asked = provider.requests.length;
    setInsightInterpret(db, true, new Date());
    await run.wake();

    expect(interpretJobs().length).toBeGreaterThan(0);
    expect(interpretJobs().every((j) => j.status === "held" && j.reason === "no-consent")).toBe(
      true,
    );
    expect(provider.requests.length).toBe(asked);
    expect(readInsight(db, k)).toEqual(before);

    consent(egress);
    releaseHeldOnEvent(db, "consent");
    await run.wake();
    expect(readInsight(db, k)?.interpretation).toEqual({
      reasoningSummary: "합성 해석",
      impact: 70,
      actionability: 30,
    });
  });
});
