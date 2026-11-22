// I01-C2 `scope.claimed-grade` (I01-R15): the configured scope is not the settings' to show or to
// write (⑥), and the Broker the backend builds judges a claimed scope with the registry's policy.
import { routes } from "@pki/contracts";
import {
  createDerivativeRegistry,
  defaultScopePolicy,
  registerConnectorInstance,
  saveSourceRecord,
  setConfiguredScope,
  type ScopePolicy,
} from "@pki/storage";
import { createProductRegistry } from "@pki/knowledge-engine";
import { FakeProvider, send } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootBackend } from "./boot.ts";
import { fixtureConnectors, openCanonicalDb, productCalls, productEgress } from "./composition.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";

const TOKEN = "k".repeat(43);
const FIXTURE_FILE = resolve(import.meta.dirname, "../../fixtures/test-connector.jsonl");
/** A value no route has a reason to carry. */
const CANARY = "canary-configured-scope-7f3a";

let dir: string;
let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-claimed-api-"));
});
afterEach(async () => {
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function boot() {
  booted = await bootBackend({
    dataDir: dir,
    token: TOKEN,
    allowedOrigins: [],
    secrets: NO_SECRET_STORE,
    providers: [],
    connectors: fixtureConnectors(FIXTURE_FILE),
  });
  const { port } = booted.server;
  const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
  return {
    db: booted.db,
    get: (path: string) => send(port, path, headers),
    post: (path: string, body: unknown) => send(port, path, headers, "POST", body),
  };
}

describe("scope.claimed-grade ⑥: no response carries the configured scope, no request writes it", () => {
  it("no GET route and no read of stored sources answers with the configured scope or its name", async () => {
    const { db, get, post } = await boot();
    await post(routes.syncConnector.path, { connectorId: "fixtures" });
    setConfiguredScope(db, "fixtures", [CANARY]);
    // the canary is where the Broker reads it: the instance row
    expect(db.all("SELECT configured_scope FROM connector_instances")).toEqual([
      { configured_scope: JSON.stringify([CANARY]) },
    ]);
    const getRoutes = Object.values(routes).filter((r) => r.method === "GET");
    expect(getRoutes.length).toBeGreaterThanOrEqual(8);
    const bodies: string[] = [];
    for (const route of getRoutes) {
      const res = await get(route.path);
      bodies.push(`${route.path} ${res.status} ${JSON.stringify(res.body)}`);
    }
    bodies.push(JSON.stringify((await post(routes.searchSources.path, { query: "등대" })).body));
    expect(bodies.some((b) => b.includes('"fixtures"'))).toBe(true); // the instance itself is shown
    for (const body of bodies) {
      expect(body).not.toContain(CANARY);
      expect(body.toLowerCase()).not.toMatch(/configured_?scope/);
    }
  });

  it("the settings write refuses a request that carries a configured scope, and stores nothing", async () => {
    const { db, post } = await boot();
    const valid = { openaiCompatible: { baseUrl: "https://synthetic.invalid/v1", model: "m" } };
    for (const extra of [
      { configuredScope: [CANARY] },
      { configured_scope: [CANARY] },
      { connectorScopes: { fixtures: [CANARY] } },
    ]) {
      const res = await post(routes.writeSettings.path, { ...valid, ...extra });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain(CANARY);
    }
    const nested = await post(routes.writeSettings.path, {
      openaiCompatible: { ...valid.openaiCompatible, configuredScope: [CANARY] },
    });
    expect(nested.status).toBe(400);
    expect(db.all("SELECT 1 FROM settings WHERE value LIKE ?", [`%${CANARY}%`])).toEqual([]);
    expect(db.all("SELECT 1 FROM connector_instances WHERE configured_scope IS NOT NULL")).toEqual(
      [],
    );
  });

  it("the sync request refuses a configured scope as well", async () => {
    const { post } = await boot();
    const res = await post(routes.syncConnector.path, {
      connectorId: "fixtures",
      configuredScope: [CANARY],
    });
    expect(res.status).toBe(400);
  });
});

describe("scope.claimed-grade: the Broker the backend builds judges with the registry's policy", () => {
  const claimedSource = (db: ReturnType<typeof openCanonicalDb>) => {
    registerConnectorInstance(db, "imp", "jsonl-import");
    setConfiguredScope(db, "imp", ["team"]);
    saveSourceRecord(db, "imp", { externalId: "e", title: "제목", body: "본문" });
    db.run("UPDATE sources SET scope_claimed = 1, access_scope = ?", [JSON.stringify(["open"])]);
    return String(db.all("SELECT max(id) AS id FROM source_versions")[0]?.id);
  };
  const request = (id: string) => ({
    taskKind: "extract" as const,
    sourceVersionIds: [id],
    candidateItemIds: [],
    schemaVersion: 4,
    budget: { timeoutMs: 1000 },
    retryable: false,
  });
  const registryWith = (policy: ScopePolicy) =>
    createDerivativeRegistry({
      kinds: createProductRegistry({ policy: defaultScopePolicy }).kinds,
      policy,
    });

  it("a policy of the registry that cannot compare stops the call; the default policy lets it through", async () => {
    const db = openCanonicalDb(dir);
    const id = claimedSource(db);
    const extractor = new FakeProvider({
      answer: () => ({ items: [], facts: [], relations: [], terms: [], definitions: [] }),
    });
    const asUser = (calls: ReturnType<typeof productCalls>) =>
      calls.issuer.during((userActionId) =>
        calls.broker.call({ origin: { userActionId }, ...request(id) }),
      );

    const refusing: ScopePolicy = {
      ...defaultScopePolicy,
      compare: () => {
        throw new Error("policy down");
      },
    };
    const stopped = await asUser(
      productCalls(db, productEgress(db), {
        providers: [extractor],
        registry: registryWith(refusing),
      }),
    );
    expect(stopped).toEqual({ status: "rejected", reason: "scope-unjudged" });

    const through = await asUser(productCalls(db, productEgress(db), { providers: [extractor] }));
    expect(through.status).not.toBe("rejected");
    db.close();
  });
});
