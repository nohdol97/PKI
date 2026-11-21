// V01-C4 `cli-list.readonly` (V01-R10): the verified CLI list is a build resource.
// A settings-table row, a file in the user's data folder, environment variables
// and the settings API all fail to add an entry: a CLI whose exact version, OS and
// profile they name stays blocked. The backend's modules are loaded afresh after
// every attempt, so nothing read when a module loads can carry the entry either.
import { routes, type ConnectionTestResult } from "@pki/contracts";
import { CLI_PROFILES } from "@pki/providers";
import { writeSetting, type SqlDriver } from "@pki/storage";
import { FakeProvider, send } from "@pki/testkit";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openCanonicalDb } from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import type { RunningServer } from "./server.ts";

const TOKEN = "r".repeat(43);
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };
const ENTRY = {
  cli: "claude-code",
  version: "2.1.3",
  os: platform(),
  profile: CLI_PROFILES["claude-code"].standard,
  verifiedOn: "2026-12-01",
};
const ENV_KEYS = [
  "PKI_VERIFIED_CLI_COMBINATIONS",
  "PKI_VERIFIED_CLI",
  "PKI_BUILD_KIND",
  "__PKI_BUILD_KIND__",
  "NODE_ENV",
];

let dir: string;
let db: SqlDriver;
let server: RunningServer | undefined;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-cli-list-"));
  db = openCanonicalDb(dir);
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  db.close();
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of savedEnv) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
});

/**
 * The product's list (no test-build list), deciding as production, a consented CLI
 * double, with every module (the list resource's loader included) loaded now.
 */
async function backend() {
  vi.resetModules();
  const { productAdapters, productCalls, productEgress } = await import("./composition.ts");
  const { startServer } = await import("./server.ts");
  const { VERIFIED_CLI_COMBINATIONS } = await import("@pki/providers");
  expect(VERIFIED_CLI_COMBINATIONS).toEqual([]);
  const egress = productEgress(db);
  const granted = egress.grant("claude-code", ["synthetic"], {
    destination: "vendor:claude-code",
    policyVersion: egress.policyVersion(),
  });
  if ("error" in granted) throw new Error(granted.error);
  const provider = new FakeProvider({
    id: "claude-code",
    transport: "cli",
    detect: async () => ({ installed: true, version: ENTRY.version }),
  });
  await server?.close();
  server = await startServer({
    token: TOKEN,
    allowedOrigins: [],
    connectors,
    db,
    dataDirectory: dir,
    egress,
    calls: productCalls(db, egress, { providers: [provider] }),
    ...productAdapters(),
  });
  const port = server.port;
  const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
  return {
    provider,
    post: (path: string, body: unknown) => send(port, path, headers, "POST", body),
    connectionTest: async () =>
      (
        await send(port, routes.connectionTest.path, headers, "POST", {
          acknowledgeUnverified: true,
        })
      ).body as ConnectionTestResult,
  };
}

const BLOCKED = { outcome: "blocked", reason: "cli-not-verified", isolation: null };

describe("the verified CLI list cannot be extended at run time", () => {
  it("blocks the CLI to begin with (the public list is empty)", async () => {
    expect(await (await backend()).connectionTest()).toEqual(BLOCKED);
  });

  it("ignores settings-table rows naming the combination", async () => {
    const list = JSON.stringify([ENTRY]);
    for (const key of [
      "providers.cli.verified",
      "providers.cli.verifiedCombinations",
      "verified-cli-combinations",
      "build.kind",
    ]) {
      writeSetting(db, key, key === "build.kind" ? "development" : list);
    }
    const b = await backend();
    expect(await b.connectionTest()).toEqual(BLOCKED);
    expect(b.provider.requests).toEqual([]);
  });

  it("ignores a list file in the user's data folder", async () => {
    for (const name of ["verified-cli-combinations.json", "verified-cli.json", "settings.json"]) {
      writeFileSync(join(dir, name), JSON.stringify([ENTRY]));
    }
    expect(await (await backend()).connectionTest()).toEqual(BLOCKED);
  });

  it("ignores environment variables, a development-looking build kind included", async () => {
    process.env.PKI_VERIFIED_CLI_COMBINATIONS = JSON.stringify([ENTRY]);
    process.env.PKI_VERIFIED_CLI = JSON.stringify([ENTRY]);
    process.env.PKI_BUILD_KIND = "development";
    process.env.__PKI_BUILD_KIND__ = "development";
    process.env.NODE_ENV = "development";
    expect(await (await backend()).connectionTest()).toEqual(BLOCKED);
  });

  it("has no settings API that takes an entry", async () => {
    const b = await backend();
    const set = routes.setExecutionSettings.path;
    expect((await b.post(set, { cliBackground: true, verified: [ENTRY] })).status).toBe(400);
    expect((await b.post(set, { verifiedCombinations: [ENTRY] })).status).toBe(400);
    for (const path of ["/api/settings/verified-cli", "/api/settings/cli", "/api/settings"]) {
      expect([404, 405]).toContain((await b.post(path, [ENTRY])).status);
    }
    expect(
      (
        await b.post(routes.connectionTest.path, {
          acknowledgeUnverified: true,
          verified: [ENTRY],
        })
      ).status,
    ).toBe(400);
    expect(await b.connectionTest()).toEqual(BLOCKED);
  });
});
