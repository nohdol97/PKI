// Contract schemas must also serve as JSON Schema (V01 spec, 스키마 검증 row):
// CLI structured-output options take JSON Schema built from the same definition.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ConnectorListResponseSchema,
  ErrorResponseSchema,
  routes,
  SYNC_STOP_CODES,
  SyncResponseSchema,
} from "./index.ts";

describe("contract schemas", () => {
  const schemas = [
    ["error", ErrorResponseSchema],
    ...Object.entries(routes).map(([name, route]) => [name, route.response] as const),
    ...Object.entries(routes).flatMap(([name, route]) =>
      "request" in route ? [[`${name} request`, route.request] as const] : [],
    ),
  ] as const;

  it.each(schemas)("%s converts to a JSON Schema object", (_name, schema) => {
    expect(z.toJSONSchema(schema)).toMatchObject({ type: "object" });
  });

  it("reports parts that later tasks implement as not implemented, not ready", () => {
    expect(
      routes.status.response.safeParse({
        backend: { state: "ready" },
        provider: { state: "unavailable", providerId: null, reason: "no-provider" },
        embedding: { state: "not-implemented" },
        vectorIndex: { state: "not-implemented" },
        invalidations: { recent: [], scopePolicyDrops: 0 },
        dataProtection: {
          legacyCleanup: "done",
          ledger: {
            state: "ok",
            reapplied: 0,
            unrecoverable: 0,
            unwritable: 0,
            ignoredLines: 0,
            setAsideLedgers: 0,
            setAsideDeletions: 0,
            history: {
              missingCreated: { total: 0, last: null },
              setAside: { total: 0, last: null },
              unrecoverable: { total: 0, last: null },
              ignoredLines: { total: 0, last: null },
              reapplied: { total: 0, last: null },
              seeded: { total: 0, last: null },
            },
          },
        },
      }).success,
    ).toBe(true);
    expect(routes.status.response.safeParse({ backend: { state: "ready" } }).success).toBe(false);
  });

  it("states each invalidation record's counts per kind, never content (I04-R4)", () => {
    const invalidations = routes.status.response.shape.invalidations;
    const record = {
      changeSeq: 3,
      sourceId: 1,
      changeKind: "user-deleted",
      removedByKind: { facts: 2 },
      recomputedByKind: { insights: 1 },
      at: "2026-11-22T00:00:00.000Z",
    };
    const of = (r: object) => ({ recent: [r], scopePolicyDrops: 0 });
    expect(invalidations.safeParse(of(record)).success).toBe(true);
    // the list sits under `recent`, beside the count of what the scope policy left out (I04-T09)
    expect(invalidations.safeParse([record]).success).toBe(false);
    expect(invalidations.safeParse({ recent: [record] }).success).toBe(false);
    expect(invalidations.safeParse({ recent: [], scopePolicyDrops: -1 }).success).toBe(false);
    expect(invalidations.safeParse({ recent: [], scopePolicyDrops: 1.5 }).success).toBe(false);
    expect(invalidations.safeParse(of({ ...record, changeKind: "deleted" })).success).toBe(false);
    expect(invalidations.safeParse(of({ ...record, removedByKind: { facts: -1 } })).success).toBe(
      false,
    );
    expect(invalidations.safeParse(of({ ...record, sourceId: 0 })).success).toBe(false);
  });

  it("states why the default Provider cannot take a call, as a code (V01-R5, T16)", () => {
    const provider = routes.status.response.shape.provider;
    expect(provider.safeParse({ state: "ready", providerId: "codex" }).success).toBe(true);
    expect(provider.safeParse({ state: "ready" }).success).toBe(false);
    const missing = {
      state: "unavailable",
      providerId: "claude-code",
      reason: "cli-not-installed",
      check: {
        providerId: "claude-code",
        installed: false,
        version: null,
        authentication: "unknown",
      },
    };
    expect(provider.safeParse(missing).success).toBe(true);
    expect(provider.safeParse({ ...missing, reason: "CLI said: not found" }).success).toBe(false);
    expect(provider.safeParse({ state: "not-implemented" }).success).toBe(false);
  });

  it("states an unavailable component's reason (V01-R5, R15)", () => {
    const vectorIndex = routes.status.response.shape.vectorIndex;
    expect(vectorIndex.safeParse({ state: "unavailable", reason: "no module" }).success).toBe(true);
    expect(vectorIndex.safeParse({ state: "unavailable" }).success).toBe(false);
    expect(vectorIndex.safeParse({ state: "rebuilding" }).success).toBe(true);
  });

  it("states the embedding model's state and where it computes (V01-R14)", () => {
    const embedding = routes.status.response.shape.embedding;
    for (const state of ["ready", "model-missing", "preparing"]) {
      expect(embedding.safeParse({ state, egress: "local" }).success).toBe(true);
      expect(embedding.safeParse({ state }).success).toBe(false);
    }
    expect(embedding.safeParse({ state: "ready", egress: "cloud" }).success).toBe(false);
    expect(embedding.safeParse({ state: "rebuilding", egress: "local" }).success).toBe(false);
    expect(embedding.safeParse({ state: "unavailable", reason: "x" }).success).toBe(true);
    expect(embedding.safeParse({ state: "unavailable", egress: "local" }).success).toBe(false);
    expect(embedding.safeParse({ state: "not-implemented" }).success).toBe(true);
  });

  it("takes an embedding preparation source of the two kinds only (V01-R14)", () => {
    const request = routes.prepareEmbedding.request;
    expect(request.safeParse({ source: { kind: "download" } }).success).toBe(true);
    expect(
      request.safeParse({ source: { kind: "local-pack", path: "/synthetic/pack" } }).success,
    ).toBe(true);
    expect(
      request.safeParse({ source: { kind: "local-pack", path: `/${"p".repeat(4095)}` } }).success,
    ).toBe(true);
    for (const body of [
      {},
      { source: { kind: "local-pack" } },
      { source: { kind: "local-pack", path: "" } },
      { source: { kind: "local-pack", path: `/${"p".repeat(4096)}` } },
      { source: { kind: "url", url: "https://example.invalid/model" } },
      { source: { kind: "download", revision: "main" } },
      { source: { kind: "download" }, files: [] },
    ]) {
      expect(request.safeParse(body).success).toBe(false);
    }
  });
});

describe("sync v2 contract (I01-R19, R21, T03)", () => {
  const result = {
    connectorId: "c",
    received: 3,
    created: 1,
    unchanged: 1,
    scopeUpdated: 0,
    stale: 0,
    staleTombstone: 0,
    blocked: 1,
    tombstoned: 0,
    rejected: [{ at: "change:2", code: "schema" }],
    rejectedCount: 1,
    rescanned: false,
    deletionsMayBeMissed: false,
  };

  it("adds instance-busy and storage-failed to the API error codes", () => {
    for (const error of ["instance-busy", "storage-failed"]) {
      expect(ErrorResponseSchema.safeParse({ error }).success, error).toBe(true);
    }
  });

  it("states a stop as one code of the closed list and a rate limit's retryAfterMs", () => {
    expect([...SYNC_STOP_CODES]).toEqual([
      "invalid-page",
      "no-progress",
      "cursor-expired",
      "rate-limited",
      "connector-error",
      "connector-failed",
      "aborted",
      "instance-busy",
      "storage-failed",
      "credential-unusable",
    ]);
    expect(SyncResponseSchema.safeParse(result).success).toBe(true);
    expect(
      SyncResponseSchema.safeParse({ ...result, stopped: "rate-limited", retryAfterMs: 5000 })
        .success,
    ).toBe(true);
    expect(
      SyncResponseSchema.safeParse({ ...result, stopped: "unsupported-sdk-version" }).success,
    ).toBe(false);
    expect(SyncResponseSchema.safeParse({ ...result, retryAfterMs: -1 }).success).toBe(false);
    expect(
      SyncResponseSchema.safeParse({ ...result, rejected: [{ at: "x", code: "nope" }] }).success,
    ).toBe(false);
  });

  it("lists deletionsMayBeMissed on a Connector, optionally", () => {
    const base = { id: "c", kind: "k", state: "ready" };
    const parse = (c: object) => ConnectorListResponseSchema.safeParse({ connectors: [c] }).success;
    expect(parse(base)).toBe(true);
    expect(parse({ ...base, deletionsMayBeMissed: true })).toBe(true);
    expect(parse({ ...base, deletionsMayBeMissed: "yes" })).toBe(false);
  });
  // S01-T02: one object (a contract schema must convert to a JSON Schema object), the shape checked by a refinement
  it("accepts a Semantic outcome only in the shape of its status", () => {
    const entry = { kind: "fact", id: 1, status: "verified", epistemic: "user-approved" };
    const outcome = routes.semanticDecide.response;
    expect(outcome.safeParse({ status: "applied", seq: 2, entry }).success).toBe(true);
    expect(outcome.safeParse({ status: "unchanged", entry }).success).toBe(true);
    expect(outcome.safeParse({ status: "refused", reason: "not-latest" }).success).toBe(true);
    for (const wrong of [
      { status: "applied", entry },
      { status: "applied", seq: 2, entry, reason: "not-latest" },
      { status: "unchanged", seq: 2, entry },
      { status: "refused" },
      { status: "refused", reason: "not-latest", entry },
      { status: "refused", reason: "a text, not a code" },
    ]) {
      expect(outcome.safeParse(wrong).success, JSON.stringify(wrong)).toBe(false);
    }
  });
});
