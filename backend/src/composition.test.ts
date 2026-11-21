// V01-R6/R7 composition: the canonical DB opens inside the per-user data
// directory, created owner-only first, at the latest schema; the site
// Connector kinds are registered and fail with the follow-up notice.
import { CONNECTOR_NOT_IMPLEMENTED } from "@pki/contracts";
import { OPENAI_BASE_URL_SETTING, OPENAI_MODEL_SETTING } from "@pki/providers";
import { migrations, schemaVersion, writeSetting } from "@pki/storage";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CANONICAL_DB_FILE,
  connectorKinds,
  openCanonicalDb,
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
  // The product build refuses loopback http (V01-R11, C5 consent.binding); T09 replaces
  // this with the build-kind switch, under which only development and test builds allow it.
  it("refuses an http endpoint, loopback included", () => {
    const db = openCanonicalDb(join(root, "PKI"));
    try {
      const egress = productEgress(db);
      for (const url of ["http://127.0.0.1:9/v1", "http://localhost:9/v1", "http://[::1]:9/v1"]) {
        writeSetting(db, OPENAI_BASE_URL_SETTING, url);
        expect(egress.destination("openai-compatible")).toEqual({ problem: "insecure-endpoint" });
      }
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
  it("binds the OpenAI-compatible and the unimplemented local-model Providers", async () => {
    const db = openCanonicalDb(join(root, "PKI"));
    try {
      const providers = productProviders(db, NO_SECRET_STORE);
      expect(Object.keys(providers).sort()).toEqual(["local-model", "openai-compatible"]);
      expect(await providers["local-model"]?.checkHealth()).toEqual({
        state: "unavailable",
        reason: "not-implemented",
      });
      // the same build-kind flag as productEgress: loopback http refused (T09 switches both)
      writeSetting(db, OPENAI_BASE_URL_SETTING, "http://127.0.0.1:9/v1");
      writeSetting(db, OPENAI_MODEL_SETTING, "m");
      const openai = providers["openai-compatible"];
      expect(await openai?.checkHealth()).toEqual({
        state: "unavailable",
        reason: "insecure-endpoint",
      });
      // without a store the Provider is unavailable, never a plaintext fallback
      writeSetting(db, OPENAI_BASE_URL_SETTING, "https://api.synthetic.example/v1");
      expect(await openai?.checkHealth()).toEqual({
        state: "unavailable",
        reason: "secret-store-unavailable",
      });
    } finally {
      db.close();
    }
  });
});
