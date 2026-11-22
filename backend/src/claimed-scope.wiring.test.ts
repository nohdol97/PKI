// I01-C2 `scope.claimed-grade` (I01-R15), I07-C4 ① ②, the wiring: the instances' configured scopes
// follow the registration's `connectorScopes` when the backend starts, and an instance a sync names
// for the first time gets its scope before anything of it is stored. The value is a map the test
// holds and hands in as the registration's field (I07-R1).
import { routes } from "@pki/contracts";
import { registerConnectorInstance, setConfiguredScope } from "@pki/storage";
import { send } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bootBackend } from "./boot.ts";
import { fixtureConnectors, openCanonicalDb } from "./composition.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";

const held = { scopes: new Map<string, string[] | null>() };

const TOKEN = "w".repeat(43);
const FIXTURE_FILE = resolve(import.meta.dirname, "../../fixtures/test-connector.jsonl");

let dir: string;
let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-claimed-scope-"));
  held.scopes = new Map();
});
afterEach(async () => {
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const boot = async () => {
  booted = await bootBackend({
    dataDir: dir,
    token: TOKEN,
    allowedOrigins: [],
    secrets: NO_SECRET_STORE,
    providers: [],
    connectors: fixtureConnectors(FIXTURE_FILE),
    site: { connectorScopes: Object.fromEntries(held.scopes) },
  });
  const { port } = booted.server;
  const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
  return {
    db: booted.db,
    post: (path: string, body: unknown) => send(port, path, headers, "POST", body),
  };
};
const configured = (db: { all: (sql: string) => Record<string, unknown>[] }) =>
  db.all("SELECT id, configured_scope FROM connector_instances ORDER BY id");

describe("scope.claimed-grade: the configured scopes follow the build's file", () => {
  it("at start, every instance row is set from the file or cleared when the file does not name it", async () => {
    const earlier = openCanonicalDb(dir);
    for (const id of ["a-kept", "b-gone", "c-named"]) registerConnectorInstance(earlier, id, "k");
    setConfiguredScope(earlier, "a-kept", ["old"]);
    setConfiguredScope(earlier, "b-gone", ["old"]);
    earlier.close();
    held.scopes = new Map([
      ["a-kept", ["team"]],
      ["c-named", ["x", "y"]],
    ]);
    const { db } = await boot();
    expect(configured(db)).toEqual([
      { id: "a-kept", configured_scope: '["team"]' },
      { id: "b-gone", configured_scope: null },
      { id: "c-named", configured_scope: '["x","y"]' },
    ]);
  });

  it("an instance first named by a sync gets its configured scope with its row", async () => {
    held.scopes = new Map([["fixtures", ["team"]]]);
    const { db, post } = await boot();
    expect(configured(db)).toEqual([]);
    expect((await post(routes.syncConnector.path, { connectorId: "fixtures" })).status).toBe(200);
    expect(configured(db)).toEqual([{ id: "fixtures", configured_scope: '["team"]' }]);
  });

  it("a sync re-reads the file's value over what the row held", async () => {
    held.scopes = new Map([["fixtures", ["team"]]]);
    const { db, post } = await boot();
    await post(routes.syncConnector.path, { connectorId: "fixtures" });
    setConfiguredScope(db, "fixtures", ["tampered"]);
    await post(routes.syncConnector.path, { connectorId: "fixtures" });
    expect(configured(db)).toEqual([{ id: "fixtures", configured_scope: '["team"]' }]);
  });
});
