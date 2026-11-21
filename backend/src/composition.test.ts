// V01-R6/R7 composition: the canonical DB opens inside the per-user data
// directory, created owner-only first, at the latest schema; the site
// Connector kinds are registered and fail with the follow-up notice.
import { CONNECTOR_NOT_IMPLEMENTED } from "@pki/contracts";
import { BUILD_KIND, OPENAI_BASE_URL_SETTING, OPENAI_MODEL_SETTING } from "@pki/providers";
import { migrations, schemaVersion, writeSetting } from "@pki/storage";
import { FakeProvider } from "@pki/testkit";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CANONICAL_DB_FILE,
  connectorKinds,
  openCanonicalDb,
  productCalls,
  productEgress,
  productProviders,
} from "./composition.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pki-compose-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("openCanonicalDb", () => {
  it("creates the data directory, then the migrated canonical file inside it", () => {
    const dir = join(root, "nested", "PKI");
    const db = openCanonicalDb(dir);
    try {
      expect(existsSync(join(dir, CANONICAL_DB_FILE))).toBe(true);
      expect(schemaVersion(db)).toBe(migrations.length);
      if (process.platform !== "win32") expect(statSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      db.close();
    }
  });
});

describe("site Connector kinds", () => {
  it.each(["site-mail", "site-messenger", "site-wiki"] as const)(
    "%s is registered and fails to initialize with the notice",
    async (kind) => {
      const connector = connectorKinds[kind]();
      expect(connector.manifest.type).toBe(kind);
      await expect(connector.initialize({})).rejects.toThrow(CONNECTOR_NOT_IMPLEMENTED);
      await expect(connector.healthCheck()).resolves.toEqual({
        state: "unavailable",
        reason: CONNECTOR_NOT_IMPLEMENTED,
      });
    },
  );
});

describe("productEgress", () => {
  // V01-R11, C5 consent.binding: loopback http passes in development and test builds
  // only, by the build kind (providers/src/build-kind.test.ts covers each kind);
  // this is the test build. Plain http elsewhere is refused in every build.
  it("takes loopback http in a test build and refuses http to anywhere else", () => {
    expect(BUILD_KIND).toBe("test");
    const db = openCanonicalDb(join(root, "PKI"));
    try {
      const egress = productEgress(db);
      for (const [url, host] of [
        ["http://127.0.0.1:9/v1", "127.0.0.1:9"],
        ["http://localhost:9/v1", "localhost:9"],
        ["http://[::1]:9/v1", "[::1]:9"],
      ] as const) {
        writeSetting(db, OPENAI_BASE_URL_SETTING, url);
        expect(egress.destination("openai-compatible")).toEqual({ destination: host });
      }
      writeSetting(db, OPENAI_BASE_URL_SETTING, "http://api.synthetic.example/v1");
      expect(egress.destination("openai-compatible")).toEqual({ problem: "insecure-endpoint" });
      writeSetting(db, OPENAI_BASE_URL_SETTING, "https://api.synthetic.example/v1");
      expect(egress.destination("openai-compatible")).toEqual({
        destination: "api.synthetic.example",
      });
    } finally {
      db.close();
    }
  });
});

describe("productProviders", () => {
  // V01-T11 (provisional): the OpenAI-compatible Provider is the one callable Provider
  // until T10 adds the CLI ones and the user's default choice; the local-model stub
  // is not bound (it can never serve a structured request).
  it("binds the OpenAI-compatible Provider only, with the egress policy's loopback rule", async () => {
    const db = openCanonicalDb(join(root, "PKI"));
    try {
      const providers = productProviders(db, NO_SECRET_STORE, productEgress(db));
      expect(providers.map((p) => p.id)).toEqual(["openai-compatible"]);
      const [openai] = providers;
      writeSetting(db, OPENAI_MODEL_SETTING, "m");
      // the same build-kind rule as productEgress (this is the test build)
      writeSetting(db, OPENAI_BASE_URL_SETTING, "http://127.0.0.1:9/v1");
      expect(await openai?.checkHealth()).toEqual({
        state: "unavailable",
        reason: "secret-store-unavailable",
      });
      writeSetting(db, OPENAI_BASE_URL_SETTING, "http://api.synthetic.example/v1");
      expect(await openai?.checkHealth()).toEqual({
        state: "unavailable",
        reason: "insecure-endpoint",
      });
    } finally {
      db.close();
    }
  });

  it("is what the product Broker calls: a connection test reaches its egress decision", async () => {
    const db = openCanonicalDb(join(root, "PKI"));
    try {
      const egress = productEgress(db);
      const providers = productProviders(db, NO_SECRET_STORE, egress);
      const { broker, issuer } = productCalls(db, egress, { providers });
      const result = await issuer.during((userActionId) =>
        broker.call({
          taskKind: "connection-test",
          sourceVersionIds: [],
          candidateItemIds: [],
          origin: { userActionId },
          schemaVersion: 1,
          budget: { timeoutMs: 1000 },
          retryable: false,
        }),
      );
      // bound (not "no-provider"); no endpoint yet, so the egress decision stops it
      expect(result).toMatchObject({ status: "blocked", reason: "destination-unavailable" });
    } finally {
      db.close();
    }
  });
});

describe("productCalls", () => {
  it("with no Provider bound, a call is blocked without a fallback", async () => {
    const db = openCanonicalDb(join(root, "PKI"));
    try {
      const { broker, issuer } = productCalls(db, productEgress(db), { providers: [] });
      const result = await issuer.during((userActionId) =>
        broker.call({
          taskKind: "connection-test",
          sourceVersionIds: [],
          candidateItemIds: [],
          origin: { userActionId },
          schemaVersion: 1,
          budget: { timeoutMs: 1000 },
          retryable: false,
        }),
      );
      expect(result).toMatchObject({ status: "blocked", reason: "no-provider" });
    } finally {
      db.close();
    }
  });

  it("calls none of several bound Providers (the user's default is T10's)", async () => {
    const db = openCanonicalDb(join(root, "PKI"));
    try {
      const a = new FakeProvider({ id: "claude-code", transport: "cli" });
      const b = new FakeProvider({ id: "codex", transport: "cli" });
      const { broker, issuer } = productCalls(db, productEgress(db), { providers: [a, b] });
      const result = await issuer.during((userActionId) =>
        broker.call({
          taskKind: "connection-test",
          sourceVersionIds: [],
          candidateItemIds: [],
          origin: { userActionId },
          schemaVersion: 1,
          budget: { timeoutMs: 1000 },
          retryable: false,
        }),
      );
      expect(result).toMatchObject({ status: "blocked", reason: "no-provider" });
      expect([...a.requests, ...b.requests]).toEqual([]);
    } finally {
      db.close();
    }
  });
});
