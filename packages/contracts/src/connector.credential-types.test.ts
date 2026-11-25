// I06-T01 `connector.credential-types` (I06-C3 ①②; R5): what the specification
// adds for credentials is optional, so a Connector whose `initialize` takes one
// argument still type-checks and still runs, and the new error and health reason
// have the fixed shapes the product reads.
import { describe, expect, it } from "vitest";
import {
  CONNECTOR_SDK_VERSION,
  CONNECTOR_CREDENTIAL_MESSAGE,
  ConnectorCredentialError,
  HEALTH_REASON_CREDENTIAL_REJECTED,
  type Connector,
  type ConnectorContext,
} from "./connector.ts";
import { CREDENTIAL_REASONS, ConnectorSummarySchema } from "./index.ts";
import { LOGIN_TIMEOUT_MS, LoginDescriptionSchema } from "./secrets.ts";

/** The shape every Connector had before this change: `initialize` takes the config only. */
const legacy: Connector = {
  manifest: {
    type: "legacy",
    schemaVersion: CONNECTOR_SDK_VERSION,
    capabilities: {
      incremental: true,
      deletes: false,
      accessScope: false,
      fullRescan: true,
      deletionsOnRescan: false,
    },
  },
  async initialize(config: unknown) {
    void config;
  },
  async healthCheck() {
    return { state: "ok" };
  },
  async getChanges() {
    return { changes: [], nextCursor: "", hasMore: false };
  },
  async getDocument() {
    return null;
  },
};

describe("connector.credential-types", () => {
  it("keeps the specification version at 2", () => {
    expect(CONNECTOR_SDK_VERSION).toBe(2);
  });

  it("lets a one-argument initialize satisfy Connector and run when a context is passed", async () => {
    const context: ConnectorContext = {
      credentials: { read: async () => "synthetic-secret-0123456789" },
    };
    await expect(legacy.initialize({}, context)).resolves.toBeUndefined();
    await expect(legacy.initialize({})).resolves.toBeUndefined();
  });

  it("makes ConnectorCredentialError without arguments, with a fixed message and no value in it", () => {
    const error = new ConnectorCredentialError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ConnectorCredentialError");
    expect(error.message).toBe(CONNECTOR_CREDENTIAL_MESSAGE);
    expect(Object.keys(error)).toEqual(["name"]);
  });

  it("takes no argument: a message cannot be passed", () => {
    // @ts-expect-error the constructor has no parameter
    const error = new ConnectorCredentialError("x");
    expect(error.message).toBe(CONNECTOR_CREDENTIAL_MESSAGE);
  });

  it("names the health reason that reports a rejection", () => {
    expect(HEALTH_REASON_CREDENTIAL_REJECTED).toBe("credential-rejected");
  });

  it("adds the session surface as optional pieces (I06S-C1 types)", async () => {
    const readOnly: ConnectorContext = { credentials: { read: async () => "x" } };
    const writing: ConnectorContext = {
      credentials: { read: async () => "x", write: async () => {} },
    };
    await expect(writing.credentials.write?.("session", "v")).resolves.toBeUndefined();
    expect(readOnly.credentials.write).toBeUndefined();
    expect(CREDENTIAL_REASONS).toContain("login-required");
    expect(LOGIN_TIMEOUT_MS).toBe(300_000);
    const summary = ConnectorSummarySchema.parse({
      id: "a",
      kind: "k",
      state: "unavailable",
      reason: "login-required",
      credentials: [{ slot: "session", name: "n", state: "missing", login: true }],
    });
    expect(summary.credentials?.[0]?.login).toBe(true);
  });

  it("accepts https and loopback http login descriptions and rejects the rest", () => {
    const base = {
      slot: "session",
      startUrl: "https://idp.example.test/login",
      doneUrlPrefix: "https://app.example.test/home",
      cookies: ["sid"],
    };
    expect(LoginDescriptionSchema.safeParse(base).success).toBe(true);
    expect(
      LoginDescriptionSchema.safeParse({ ...base, startUrl: "http://127.0.0.1:8080/x" }).success,
    ).toBe(true);
    expect(
      LoginDescriptionSchema.safeParse({ ...base, startUrl: "http://example.com/x" }).success,
    ).toBe(false);
    expect(LoginDescriptionSchema.safeParse({ ...base, cookies: [] }).success).toBe(false);
    const nine = Array.from({ length: 9 }, (_, i) => `c${i}`);
    expect(LoginDescriptionSchema.safeParse({ ...base, cookies: nine }).success).toBe(false);
    expect(LoginDescriptionSchema.safeParse({ ...base, cookies: ["a", "a"] }).success).toBe(false);
    expect(LoginDescriptionSchema.safeParse({ ...base, cookies: ["a b"] }).success).toBe(false);
  });
});
