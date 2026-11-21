// The Provider API (V01-R9, R5, T10 handoff 8·9): the list and the default run no
// process; the user's default choice decides which Provider the next call goes to
// (connection-test history names it); an unbound name is refused; "check" runs the
// two queries that need no decision, against the fake CLI on a test PATH.
import { routes, type ProviderCall } from "@pki/contracts";
import { createClaudeCodeProvider, createCodexProvider } from "@pki/providers/adapters";
import { writeSetting, type SqlDriver } from "@pki/storage";
import { DEFAULT_PROVIDER_SETTING } from "@pki/providers";
import { installFakeCli, send, type FakeCli } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openCanonicalDb, productAdapters, productCalls, productEgress } from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import { startServer, type RunningServer } from "./server.ts";

// every fake CLI run is a Node start: slow when the whole suite runs in parallel
vi.setConfig({ testTimeout: 30_000 });

const TOKEN = "p".repeat(43);
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };

let dir: string;
let db: SqlDriver;
let fake: FakeCli;
let server: RunningServer;
let headers: Record<string, string>;

async function start(path: string) {
  const egress = productEgress(db);
  const env = { PATH: path };
  server = await startServer({
    token: TOKEN,
    allowedOrigins: [],
    connectors,
    db,
    dataDirectory: dir,
    egress,
    calls: productCalls(db, egress, {
      providers: [createClaudeCodeProvider({ env }), createCodexProvider({ env })],
    }),
    ...productAdapters(dir),
  });
  headers = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` };
}

const get = (path: string) => send(server.port, path, headers);
const post = (path: string, body?: unknown) => send(server.port, path, headers, "POST", body);
const connectionTest = () => post(routes.connectionTest.path, { acknowledgeUnverified: false });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pki-providers-api-"));
  db = openCanonicalDb(join(dir, "data"));
  fake = installFakeCli({ auth: "logged-in" }, dir);
  await start(fake.bin);
});
afterEach(async () => {
  expect(await fake.leftovers()).toEqual([]);
  await server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("providers API", () => {
  it("lists the bound Providers with no default and runs nothing", async () => {
    expect(await get(routes.providers.path)).toEqual({
      status: 200,
      body: {
        defaultProvider: null,
        providers: [
          { providerId: "claude-code", transport: "cli" },
          { providerId: "codex", transport: "cli" },
        ],
      },
    });
    expect(fake.runs()).toEqual([]);
  });

  it("calls nothing until the user picks a default, then the one picked", async () => {
    expect((await connectionTest()).body).toMatchObject({ reason: "no-provider" });

    const picked = await post(routes.setDefaultProvider.path, { providerId: "codex" });
    expect(picked).toMatchObject({ status: 200, body: { defaultProvider: "codex" } });
    expect((await get(routes.providers.path)).body).toMatchObject({ defaultProvider: "codex" });
    // no consent in this test: the Broker records a blocked attempt for the Provider it chose
    expect((await connectionTest()).body).toMatchObject({
      outcome: "blocked",
      reason: "no-consent",
    });

    await post(routes.setDefaultProvider.path, { providerId: "claude-code" });
    await connectionTest();
    const calls = ((await get(routes.activity.path)).body as { calls: ProviderCall[] }).calls;
    expect(calls.map((c) => c.provider).sort()).toEqual(["claude-code", "codex"]);
    expect(fake.modelCalls()).toBe(0);
  });

  it("refuses a Provider that is not bound, and any other body", async () => {
    expect(await post(routes.setDefaultProvider.path, { providerId: "openai-compatible" })).toEqual(
      { status: 404, body: { error: "not-found" } },
    );
    expect(await post(routes.setDefaultProvider.path, { providerId: "bogus" })).toMatchObject({
      status: 400,
    });
    expect(
      await post(routes.setDefaultProvider.path, { providerId: "codex", extra: 1 }),
    ).toMatchObject({ status: 400 });
    expect((await get(routes.providers.path)).body).toMatchObject({ defaultProvider: null });
  });

  it("checks each Provider with the version and login status queries only", async () => {
    expect(await post(routes.checkProviders.path)).toEqual({
      status: 200,
      body: {
        providers: [
          {
            providerId: "claude-code",
            installed: true,
            version: "2.1.3",
            authentication: "unknown",
          },
          {
            providerId: "codex",
            installed: true,
            version: "2.1.3",
            authentication: "authenticated",
          },
        ],
      },
    });
    expect(
      fake
        .runs()
        .map((r) => `${r.name} ${r.args.join(" ")}`)
        .sort(),
    ).toEqual(["claude --version", "codex --version", "codex login status"]);
    expect(fake.modelCalls()).toBe(0);
  });

  it("adds install or login guidance to a connection test the default CLI cannot serve", async () => {
    const consent = async (providerId: "codex" | "claude-code") => {
      const { policyVersion } = (await get(routes.consents.path)).body as { policyVersion: string };
      await post(routes.grantConsent.path, {
        providerId,
        allowedClasses: ["synthetic"],
        destination: `vendor:${providerId}`,
        policyVersion,
      });
    };
    await post(routes.setDefaultProvider.path, { providerId: "codex" });
    // before consent the CLI is not why: nothing is queried and nothing is added
    expect((await connectionTest()).body).toEqual({
      outcome: "blocked",
      reason: "no-consent",
      isolation: null,
    });
    await consent("codex");
    // installed and logged in, but not listed (deciding as production): nothing to guide
    const versionRuns = fake.runs().length;
    expect((await connectionTest()).body).toEqual({
      outcome: "blocked",
      reason: "cli-not-verified",
      isolation: null,
    });
    expect(fake.runs().length).toBeGreaterThan(versionRuns);
    fake.configure({ auth: "logged-out" });
    expect((await connectionTest()).body).toEqual({
      outcome: "blocked",
      reason: "cli-not-verified",
      isolation: null,
      providerCheck: {
        providerId: "codex",
        installed: true,
        version: "2.1.3",
        authentication: "unauthenticated",
      },
    });
    await server.close();
    await start(join(dir, "data")); // nothing on PATH
    await post(routes.setDefaultProvider.path, { providerId: "claude-code" });
    await consent("claude-code");
    expect((await connectionTest()).body).toEqual({
      outcome: "blocked",
      reason: "cli-not-verified",
      isolation: null,
      providerCheck: {
        providerId: "claude-code",
        installed: false,
        version: null,
        authentication: "unknown",
      },
    });
    expect(fake.modelCalls()).toBe(0);
  });

  it("shows no default and calls none when the stored one is not bound", async () => {
    writeSetting(db, DEFAULT_PROVIDER_SETTING, "openai-compatible"); // a Provider this server lacks
    expect((await get(routes.providers.path)).body).toMatchObject({ defaultProvider: null });
    expect((await connectionTest()).body).toMatchObject({ reason: "no-provider" });
  });

  it("runs one check for requests that arrive while it is running", async () => {
    const answers = await Promise.all([
      post(routes.checkProviders.path),
      post(routes.checkProviders.path),
      post(routes.checkProviders.path),
    ]);
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(fake.runs()).toHaveLength(3); // claude --version, codex --version, codex login status
    await post(routes.checkProviders.path); // a later request checks again
    expect(fake.runs()).toHaveLength(6);
  });

  it("reports CLIs that are not installed", async () => {
    await server.close();
    await start(join(dir, "data"));
    expect((await post(routes.checkProviders.path)).body).toEqual({
      providers: [
        { providerId: "claude-code", installed: false, version: null, authentication: "unknown" },
        { providerId: "codex", installed: false, version: null, authentication: "unknown" },
      ],
    });
  });
});
