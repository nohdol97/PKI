// V01-R3: the routes behind Sources, Activity and Settings answer from the
// canonical DB and the configured data directory, never from fixed values.
import { ErrorResponseSchema, routes } from "@pki/contracts";
import { createCallRecorder } from "@pki/providers";
import { registerConnectorInstance, saveSourceRecord, type SqlDriver } from "@pki/storage";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { send } from "@pki/testkit";
import {
  CANONICAL_DB_FILE,
  openCanonicalDb,
  productAdapters,
  productEgress,
} from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import { startServer, type RunningServer } from "./server.ts";

const TOKEN = "w".repeat(43);
const DATA_DIR = mkdtempSync(join(tmpdir(), "pki-screens-"));
let db: SqlDriver;
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };
let server: RunningServer;
let valid: Record<string, string>;

beforeAll(async () => {
  db = openCanonicalDb(DATA_DIR);
  registerConnectorInstance(db, "fixtures", "test-fixtures");
  saveSourceRecord(db, "fixtures", {
    externalId: "x1",
    title: "합성 등대 일지",
    body: "합성 자료",
  });
  // the history writer the Broker uses, so Activity shows what it writes
  const recorder = createCallRecorder(db, () => new Date("2026-11-21T00:00:00Z"));
  recorder.record({
    requestId: "r1",
    attempt: 1,
    providerId: "claude-code",
    taskKind: "connection-test",
    classification: "synthetic",
    outcome: "ok",
    destination: "vendor:claude-code",
    policyVersion: "p1",
    durationMs: 5,
  });
  recorder.record({
    requestId: "r1",
    attempt: 2,
    providerId: "claude-code",
    taskKind: "connection-test",
    classification: "synthetic",
    outcome: "blocked",
    reason: "no-consent",
  });
  server = await startServer({
    token: TOKEN,
    allowedOrigins: [],
    connectors,
    db,
    dataDirectory: DATA_DIR,
    databaseFile: join(DATA_DIR, CANONICAL_DB_FILE),
    egress: productEgress(db),
    ...productAdapters(),
  });
  valid = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` };
});
afterAll(async () => {
  await server.close();
  db.close();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

const call = (path: string, method = "GET", body?: unknown) =>
  send(server.port, path, valid, method, body);

describe("screen routes", () => {
  it("lists stored sources", async () => {
    const res = await call(routes.sources.path);
    expect(res.body).toEqual({
      sources: [{ id: 1, connectorId: "fixtures", externalId: "x1", title: "합성 등대 일지" }],
    });
  });

  it("searches stored sources by keyword", async () => {
    const { path, method } = routes.searchSources;
    expect((await call(path, method, { query: "등대" })).body).toMatchObject({
      sources: [{ externalId: "x1" }],
    });
    expect((await call(path, method, { query: "없는말" })).body).toEqual({ sources: [] });
  });

  it.each([{ query: "" }, { query: "x".repeat(201) }, { query: "등대", extra: 1 }, {}])(
    "rejects the search body %j",
    async (body) => {
      const { path, method } = routes.searchSources;
      const res = await call(path, method, body);
      expect(res.status).toBe(400);
      expect(ErrorResponseSchema.parse(res.body)).toEqual({ error: "bad-request" });
    },
  );

  it("lists the provider call history, a CLI call labelled external, a blocked one with its reason", async () => {
    expect((await call(routes.activity.path)).body).toEqual({
      calls: [
        {
          requestId: "r1",
          attempt: 2,
          provider: "claude-code",
          egress: "external",
          destination: null,
          taskKind: "connection-test",
          classification: "synthetic",
          policyVersion: null,
          outcome: "blocked",
          reason: "no-consent",
          durationMs: null,
          createdAt: "2026-11-21T00:00:00.000Z",
        },
        {
          requestId: "r1",
          attempt: 1,
          provider: "claude-code",
          egress: "external",
          destination: "vendor:claude-code",
          taskKind: "connection-test",
          classification: "synthetic",
          policyVersion: "p1",
          outcome: "ok",
          reason: null,
          durationMs: 5,
          createdAt: "2026-11-21T00:00:00.000Z",
        },
      ],
    });
  });

  it("reads the settings, the encryption state read from the canonical file", async () => {
    expect((await call(routes.settings.path)).body).toEqual({
      dataDirectory: DATA_DIR,
      schemaVersion: 4,
      databaseEncryption: "not-applied",
    });
  });

  it("grants and revokes consent, which the consent list then shows", async () => {
    const grant = await call(routes.grantConsent.path, "POST", {
      providerId: "claude-code",
      allowedClasses: ["synthetic"],
    });
    expect(grant.status).toBe(200);
    const listed = await call(routes.consents.path);
    expect(listed.body).toMatchObject({
      providers: expect.arrayContaining([
        expect.objectContaining({
          providerId: "claude-code",
          egress: "external",
          consent: expect.objectContaining({ allowedClasses: ["synthetic"], state: "valid" }),
        }),
      ]),
    });
    const revoked = await call(routes.revokeConsent.path, "POST", { providerId: "claude-code" });
    expect(revoked.body).toMatchObject({
      providers: expect.arrayContaining([
        expect.objectContaining({ providerId: "claude-code", consent: null }),
      ]),
    });
  });
});
