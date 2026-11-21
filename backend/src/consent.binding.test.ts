// V01-C5 `consent.binding` (V01-R12, ADR 0014): a consent given through the API
// binds to Provider, destination and policy version. Changing the endpoint host,
// or any rule, blocks the next call until consent is given again; an `http`
// endpoint is refused except loopback in a test build. Everything runs on a real
// canonical file: the API, the egress policy, the Broker and the history writer.
import { ProviderError, routes, type ConsentList, type ProviderId } from "@pki/contracts";
import {
  createBroker,
  createCallRecorder,
  createEgressPolicy,
  createUserActionLedger,
  OPENAI_BASE_URL_SETTING,
  type EgressRule,
} from "@pki/providers";
import { listProviderCalls, writeSetting, type SqlDriver } from "@pki/storage";
import { FakeProvider, send } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCanonicalDb, productAdapters } from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import { startServer, type RunningServer } from "./server.ts";

const TOKEN = "b".repeat(43);
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };

let dir: string;
let db: SqlDriver;
let server: RunningServer | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-consent-"));
  db = openCanonicalDb(dir);
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Stack {
  rules?: EgressRule[];
  allowLoopbackHttp?: boolean;
  provider?: FakeProvider;
  onSleep?: () => void;
}

/** API and Broker over one egress policy, as the composition root will bind them. */
async function stack(options: Stack = {}) {
  const egress = createEgressPolicy({
    db,
    siteRules: options.rules ?? [],
    allowLoopbackHttp: options.allowLoopbackHttp ?? false,
  });
  await server?.close();
  server = await startServer({
    token: TOKEN,
    allowedOrigins: [],
    connectors,
    db,
    dataDirectory: dir,
    egress,
    ...productAdapters(),
  });
  const port = server.port;
  const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
  const provider = options.provider ?? new FakeProvider({ id: "openai-compatible" });
  const ledger = createUserActionLedger();
  const broker = createBroker({
    db,
    provider: () => provider,
    userActions: ledger.redeemer,
    candidates: { lookup: () => undefined },
    egress,
    execution: { decide: () => ({ run: true }) }, // CLI execution conditions are T09's
    recorder: createCallRecorder(db),
    clock: { now: () => 0, sleep: async () => options.onSleep?.() },
  });
  return {
    egress,
    provider,
    post: (path: string, body: unknown) => send(port, path, headers, "POST", body),
    /** As the consent screen does: send back the destination and version it shows. */
    grant: async (providerId: ProviderId, allowedClasses: string[]) => {
      const shown = (await send(port, routes.consents.path, headers)).body as ConsentList;
      const entry = shown.providers.find((p) => p.providerId === providerId);
      return send(port, routes.grantConsent.path, headers, "POST", {
        providerId,
        allowedClasses,
        destination: entry?.destination ?? "",
        policyVersion: shown.policyVersion,
      });
    },
    revoke: (providerId: ProviderId) =>
      send(port, routes.revokeConsent.path, headers, "POST", { providerId }),
    overview: async () => (await send(port, routes.consents.path, headers)).body as ConsentList,
    activity: () => send(port, routes.activity.path, headers),
    connectionTest: (retryable = false) =>
      ledger.issuer.during((userActionId) =>
        broker.call({
          taskKind: "connection-test",
          sourceVersionIds: [],
          candidateItemIds: [],
          origin: { userActionId },
          schemaVersion: 1,
          budget: { timeoutMs: 1000 },
          retryable,
        }),
      ),
  };
}

const consentOf = (list: ConsentList, id: ProviderId) =>
  list.providers.find((p) => p.providerId === id);

describe("consent binding", () => {
  it("blocks again after the endpoint's host changes, until consent is given again", async () => {
    writeSetting(db, OPENAI_BASE_URL_SETTING, "https://one.synthetic.example/v1");
    const s = await stack();
    expect(await s.connectionTest()).toMatchObject({ status: "blocked", reason: "no-consent" });

    const granted = await s.grant("openai-compatible", ["synthetic"]);
    expect(granted.status).toBe(200);
    expect(consentOf(granted.body as ConsentList, "openai-compatible")?.consent).toMatchObject({
      destination: "one.synthetic.example",
      state: "valid",
    });
    expect(await s.connectionTest()).toMatchObject({ status: "ok" });
    expect(s.provider.requests.at(-1)?.egress).toEqual({
      allowed: true,
      destination: "one.synthetic.example",
      policyVersion: s.egress.policyVersion(),
    });

    writeSetting(db, OPENAI_BASE_URL_SETTING, "https://two.synthetic.example/v1");
    const sent = s.provider.requests.length;
    expect(await s.connectionTest()).toMatchObject({
      status: "blocked",
      reason: "consent-stale-destination",
    });
    expect(s.provider.requests).toHaveLength(sent);
    expect(consentOf(await s.overview(), "openai-compatible")).toMatchObject({
      destination: "two.synthetic.example",
      consent: { destination: "one.synthetic.example", state: "stale-destination" },
    });

    await s.grant("openai-compatible", ["synthetic"]);
    expect(await s.connectionTest()).toMatchObject({ status: "ok" });
    expect(s.provider.requests.at(-1)?.egress.destination).toBe("two.synthetic.example");
  });

  it("blocks again after one rule changes, because the policy version changes", async () => {
    writeSetting(db, OPENAI_BASE_URL_SETTING, "https://one.synthetic.example/v1");
    const deny: EgressRule = {
      provider: "codex",
      taskKind: "extract",
      classification: "general",
      effect: "deny",
    };
    const before = await stack({ rules: [deny] });
    await before.grant("openai-compatible", ["synthetic"]);
    expect(await before.connectionTest()).toMatchObject({ status: "ok" });

    const edited: EgressRule[] = [{ ...deny, classification: "synthetic" }];
    const after = await stack({ rules: edited });
    expect(after.egress.policyVersion()).not.toBe(before.egress.policyVersion());
    expect(await after.connectionTest()).toMatchObject({
      status: "blocked",
      reason: "consent-stale-policy",
    });
    expect(after.provider.requests).toHaveLength(0);
    expect(consentOf(await after.overview(), "openai-compatible")?.consent?.state).toBe(
      "stale-policy",
    );
  });

  it("refuses an http endpoint; loopback http passes only in a test build", async () => {
    writeSetting(db, OPENAI_BASE_URL_SETTING, "http://api.synthetic.example/v1");
    const product = await stack();
    expect((await product.grant("openai-compatible", ["synthetic"])).body).toEqual({
      error: "destination-unavailable",
    });
    expect(await product.connectionTest()).toMatchObject({
      status: "blocked",
      reason: "insecure-endpoint",
    });

    writeSetting(db, OPENAI_BASE_URL_SETTING, "http://127.0.0.1:9/v1");
    expect(await product.connectionTest()).toMatchObject({ reason: "insecure-endpoint" });
    const testBuild = await stack({ allowLoopbackHttp: true });
    expect((await testBuild.grant("openai-compatible", ["synthetic"])).status).toBe(200);
    expect(await testBuild.connectionTest()).toMatchObject({ status: "ok" });

    writeSetting(db, OPENAI_BASE_URL_SETTING, "http://api.synthetic.example/v1");
    expect(await testBuild.connectionTest()).toMatchObject({ reason: "insecure-endpoint" });
    expect(testBuild.provider.requests).toHaveLength(1);
  });

  it("stops the next attempt when consent is revoked during the retry wait", async () => {
    const during: { policy?: { revoke(id: ProviderId): unknown } } = {};
    const provider = new FakeProvider({
      id: "claude-code",
      transport: "cli",
      script: [{ error: new ProviderError("busy", { retryable: true }) }],
    });
    const s = await stack({ provider, onSleep: () => during.policy?.revoke("claude-code") });
    during.policy = s.egress;
    await s.grant("claude-code", ["synthetic"]);
    const result = await s.connectionTest(true);
    expect(result).toMatchObject({ status: "blocked", reason: "no-consent" });
    expect(provider.requests).toHaveLength(1);
    expect(
      listProviderCalls(db).map((c) => [c.attempt, c.outcome, c.reason, c.destination]),
    ).toEqual([
      [2, "blocked", "no-consent", null],
      [1, "provider-error", null, "vendor:claude-code"],
    ]);
  });

  it("records and shows a CLI call as external egress", async () => {
    const provider = new FakeProvider({ id: "codex", transport: "cli" });
    const s = await stack({ provider });
    await s.grant("codex", ["synthetic"]);
    await s.connectionTest();
    const res = await s.activity();
    expect(res.body).toMatchObject({
      calls: [
        {
          provider: "codex",
          egress: "external",
          destination: "vendor:codex",
          policyVersion: s.egress.policyVersion(),
          outcome: "ok",
          reason: null,
        },
      ],
    });
  });

  it("refuses a grant for a destination or policy version the screen no longer shows", async () => {
    writeSetting(db, OPENAI_BASE_URL_SETTING, "https://one.synthetic.example/v1");
    const s = await stack();
    const shown = await s.overview();
    const seen = consentOf(shown, "openai-compatible")?.destination;
    expect(seen).toBe("one.synthetic.example");
    // the endpoint changes between showing the screen and pressing grant
    writeSetting(db, OPENAI_BASE_URL_SETTING, "https://two.synthetic.example/v1");
    const stale = await s.post(routes.grantConsent.path, {
      providerId: "openai-compatible",
      allowedClasses: ["synthetic"],
      destination: seen,
      policyVersion: shown.policyVersion,
    });
    expect(stale).toEqual({ status: 409, body: { error: "consent-stale" } });
    expect(consentOf(await s.overview(), "openai-compatible")?.consent).toBeNull();

    // the rules changed after the screen was shown
    const edited = await stack({
      rules: [{ provider: "codex", taskKind: "*", classification: "*", effect: "deny" }],
    });
    const oldVersion = await edited.post(routes.grantConsent.path, {
      providerId: "openai-compatible",
      allowedClasses: ["synthetic"],
      destination: "two.synthetic.example",
      policyVersion: shown.policyVersion,
    });
    expect(oldVersion).toEqual({ status: 409, body: { error: "consent-stale" } });
    expect(await edited.connectionTest()).toMatchObject({
      status: "blocked",
      reason: "no-consent",
    });
    expect(edited.provider.requests).toHaveLength(0);
  });

  it("rejects a grant naming an unknown Provider or class, or no class", async () => {
    const s = await stack();
    for (const body of [
      { providerId: "fake", allowedClasses: ["synthetic"] },
      { providerId: "codex", allowedClasses: ["secret"] },
      { providerId: "codex", allowedClasses: [] },
      { providerId: "codex", allowedClasses: ["synthetic"] },
      { providerId: "codex", allowedClasses: ["synthetic"], destination: "vendor:codex" },
      {
        providerId: "codex",
        allowedClasses: ["synthetic"],
        destination: "vendor:codex",
        policyVersion: "",
      },
      {
        providerId: "codex",
        allowedClasses: ["synthetic"],
        destination: "vendor:codex",
        policyVersion: s.egress.policyVersion(),
        extra: 1,
      },
    ]) {
      const res = await s.post(routes.grantConsent.path, body);
      expect(res).toEqual({ status: 400, body: { error: "bad-request" } });
    }
    expect(consentOf(await s.overview(), "codex")?.consent).toBeNull();
  });
});
