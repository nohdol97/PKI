// V01-R6/R7 composition: the canonical DB opens inside the per-user data
// directory, created owner-only first, at the latest schema; the site
// Connector kinds are registered and fail with the follow-up notice.
import { CONNECTOR_NOT_IMPLEMENTED } from "@pki/contracts";
import {
  BUILD_KIND,
  DEFAULT_PROVIDER_SETTING,
  OPENAI_BASE_URL_SETTING,
  OPENAI_MODEL_SETTING,
} from "@pki/providers";
import {
  IdentityKeyMissingError,
  insertItem,
  listCheckLines,
  migrations,
  onMembershipChanged,
  registerConnectorInstance,
  saveCheckLine,
  saveDatasetTable,
  saveFact,
  saveSourceRecord,
  readSetting,
  schemaVersion,
  writeSetting,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { FakeProvider } from "@pki/testkit";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CANONICAL_DB_FILE,
  MEMBERSHIP_LISTENERS,
  chooseNormalizerSpawner,
  connectorKinds,
  fixtureConnectors,
  isolatedNormalizerPort,
  openCanonicalDb,
  productConnectors,
  productCalls,
  productEgress,
  productProviders,
  productUserDecisions,
} from "./composition.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";
import type { HostSpawner } from "@pki/document-normalize";

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

describe("openCanonicalDb: the start of a database with deleted sources (I04-R6, R7)", () => {
  it("finishes the one-time clean-up, so the next start has none to do", () => {
    const dir = join(root, "PKI");
    openCanonicalDb(dir).close();
    const again = openCanonicalDb(dir);
    try {
      expect(readSetting(again, "purge.legacy-cleanup")).toBe("done");
    } finally {
      again.close();
    }
  });

  it("refuses to start when hashed sources lost the identity key, and makes no new key", () => {
    const dir = join(root, "PKI");
    const first = openCanonicalDb(dir);
    first.run("INSERT INTO connector_instances (id, kind) VALUES ('c', 'k')");
    first.run(
      "INSERT INTO sources (connector_instance_id, namespace, external_id, identity_hashed) VALUES ('c', 'h', 'h', 1)",
    );
    first.run("DELETE FROM identity_key");
    first.close();
    expect(() => openCanonicalDb(dir)).toThrow(IdentityKeyMissingError);
    const raw = openBetterSqlite3(join(dir, CANONICAL_DB_FILE));
    try {
      expect(raw.all("SELECT count(*) AS n FROM identity_key")[0]?.n).toBe(0);
    } finally {
      raw.close();
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

describe("Connectors of the product and of source runs (V01-T15)", () => {
  it("the product registers the site kinds only: no test Connector (T04 ③)", () => {
    expect(Object.keys(connectorKinds).sort()).toEqual([
      "local-files",
      "site-mail",
      "site-messenger",
      "site-wiki",
    ]);
    const product = productConnectors();
    expect(product.kinds).toBe(connectorKinds);
    expect(product.instances.map((i) => i.kind)).toEqual([
      "site-mail",
      "site-messenger",
      "site-wiki",
      "local-files",
    ]);
  });

  it("a source run adds the test Connector replaying the given file", () => {
    const set = fixtureConnectors("/synthetic/fixtures.jsonl");
    expect(Object.keys(set.kinds).sort()).toEqual([
      "local-files",
      "site-mail",
      "site-messenger",
      "site-wiki",
      "test-fixtures",
    ]);
    expect(set.instances[0]).toEqual({
      id: "fixtures",
      kind: "test-fixtures",
      config: { file: "/synthetic/fixtures.jsonl" },
    });
  });
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

const connectionTest = (calls: ReturnType<typeof productCalls>) =>
  calls.issuer.during((userActionId) =>
    calls.broker.call({
      taskKind: "connection-test",
      sourceVersionIds: [],
      candidateItemIds: [],
      origin: { userActionId },
      schemaVersion: 1,
      budget: { timeoutMs: 1000 },
      retryable: false,
    }),
  );

describe("productProviders", () => {
  // the two CLI Providers (T10) and the OpenAI-compatible one (T11); the local-model
  // stub is not bound (it can never serve a structured request)
  it("binds the CLI Providers and the OpenAI-compatible one with the egress policy's loopback rule", async () => {
    const db = openCanonicalDb(join(root, "PKI"));
    try {
      const providers = productProviders(db, NO_SECRET_STORE, productEgress(db));
      expect(providers.map((p) => [p.id, p.transport])).toEqual([
        ["claude-code", "cli"],
        ["codex", "cli"],
        ["openai-compatible", "http"],
      ]);
      const openai = providers.find((p) => p.id === "openai-compatible");
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

  it("are what the product Broker calls: the chosen one reaches its egress decision", async () => {
    const db = openCanonicalDb(join(root, "PKI"));
    try {
      const egress = productEgress(db);
      const providers = productProviders(db, NO_SECRET_STORE, egress);
      const calls = productCalls(db, egress, { providers });
      expect(calls.providers).toBe(providers);
      // no default chosen: none is called, though three are bound
      expect(await connectionTest(calls)).toMatchObject({
        status: "blocked",
        reason: "no-provider",
      });
      writeSetting(db, DEFAULT_PROVIDER_SETTING, "openai-compatible");
      // chosen (not "no-provider"); no endpoint yet, so the egress decision stops it
      expect(await connectionTest(calls)).toMatchObject({
        status: "blocked",
        reason: "destination-unavailable",
      });
    } finally {
      db.close();
    }
  });
});

describe("productCalls", () => {
  it("with no Provider bound, a call is blocked without a fallback", async () => {
    const db = openCanonicalDb(join(root, "PKI"));
    try {
      writeSetting(db, DEFAULT_PROVIDER_SETTING, "codex");
      const calls = productCalls(db, productEgress(db), { providers: [] });
      expect(await connectionTest(calls)).toMatchObject({
        status: "blocked",
        reason: "no-provider",
      });
    } finally {
      db.close();
    }
  });

  it("calls the user's default among several, read again for every call", async () => {
    const db = openCanonicalDb(join(root, "PKI"));
    try {
      const a = new FakeProvider({ id: "claude-code", transport: "cli" });
      const b = new FakeProvider({ id: "codex", transport: "cli" });
      const egress = productEgress(db);
      const calls = productCalls(db, egress, { providers: [a, b] });
      expect(await connectionTest(calls)).toMatchObject({ reason: "no-provider" });
      writeSetting(db, DEFAULT_PROVIDER_SETTING, "codex");
      // no consent: the egress decision blocks, but only after the default was chosen
      expect(await connectionTest(calls)).toMatchObject({ reason: "no-consent" });
      writeSetting(db, DEFAULT_PROVIDER_SETTING, "openai-compatible"); // not bound: no fallback
      expect(await connectionTest(calls)).toMatchObject({ reason: "no-provider" });
      expect(
        db.all("SELECT provider FROM provider_calls ORDER BY id").map((r) => r.provider),
      ).toEqual(["codex"]);
      expect([...a.requests, ...b.requests]).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("check.staleness: the membership receivers' fixed list (S02-R13, S03-R11)", () => {
  it("holds S03's receiver, and a merge through productUserDecisions erases a seeded line", () => {
    expect(MEMBERSHIP_LISTENERS).toContain(onMembershipChanged);
    const dbFile = openCanonicalDb(root);
    try {
      registerConnectorInstance(dbFile, "c1", "test-fixtures");
      const attrs = {
        epistemic: "explicit",
        status: "candidate",
        validAt: null,
        observedAt: "t",
      } as const;
      const saved = saveSourceRecord(dbFile, "c1", { externalId: "t", title: "t", body: "a\tb" });
      if (saved.status !== "created") throw new Error(saved.status);
      const versionId = dbFile.all("SELECT id FROM source_versions")[0]?.id as number;
      const [x, y] = [
        insertItem(dbFile, { type: "Dataset", name: "x", ...attrs }),
        insertItem(dbFile, { type: "Dataset", name: "y", ...attrs }),
      ] as const;
      saveDatasetTable(dbFile, { itemId: x, sourceId: saved.sourceId, key: "", rowCount: 1 });
      const fact = saveFact(dbFile, {
        itemId: x,
        kind: "dataset.grain",
        value: '["a"]',
        ...attrs,
      }).id;
      saveCheckLine(dbFile, {
        factId: fact,
        check: "grain",
        passed: true,
        failure: null,
        examined: 1,
        violations: 0,
        skipped: 0,
        versionId,
        otherVersionId: null,
        at: "t",
      });
      expect(listCheckLines(dbFile, fact)).toHaveLength(1);
      const merged = dbFile.transaction(() =>
        productUserDecisions({ combinable: () => true }).entities.merge(dbFile, y, x),
      );
      expect(merged.status).toBe("applied");
      expect(listCheckLines(dbFile, fact)).toEqual([]);
    } finally {
      dbFile.close();
    }
  });
});

describe("the normalizer host's spawner (I02B-R22, D9)", () => {
  const shell: HostSpawner = { spawn: () => Promise.reject(new Error("not used")) };

  it("plain Node forks the host; Electron uses the shell's channel; Electron without one has none, never the fork", () => {
    const forked = chooseNormalizerSpawner({ underElectron: false, shell });
    expect(forked).toBeDefined();
    expect(forked).not.toBe(shell);
    expect(chooseNormalizerSpawner({ underElectron: true, shell })).toBe(shell);
    expect(chooseNormalizerSpawner({ underElectron: true })).toBeUndefined();
  });

  it("no spawner gives a normalizer that is unavailable, visibly, and never throws", async () => {
    const port = isolatedNormalizerPort(undefined, {
      timeoutMs: 1_000,
      maxHeapMb: 256,
      maxExternalMemoryBytes: 1 << 28,
    });
    expect(port.unavailable()).toBe(true);
    expect(await port.recheck()).toBe(false);
    const result = await port.normalize({ bytes: new Uint8Array(), name: "a.md" }, {});
    expect(result).toMatchObject({
      ok: false,
      error: { code: "worker-failed" },
      unavailable: true,
    });
  });
});
