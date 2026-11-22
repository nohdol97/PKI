// Contract schemas must also serve as JSON Schema (V01 spec, 스키마 검증 row):
// CLI structured-output options take JSON Schema built from the same definition.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ErrorResponseSchema, routes } from "./index.ts";

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
        provider: { state: "not-implemented" },
        embedding: { state: "not-implemented" },
        vectorIndex: { state: "not-implemented" },
        invalidations: { recent: [] },
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
    const of = (r: object) => ({ recent: [r] });
    expect(invalidations.safeParse(of(record)).success).toBe(true);
    // the list sits under `recent`; I04-T09 adds `scopePolicyDrops` beside it
    expect(invalidations.safeParse([record]).success).toBe(false);
    expect(invalidations.safeParse(of({ ...record, changeKind: "deleted" })).success).toBe(false);
    expect(invalidations.safeParse(of({ ...record, removedByKind: { facts: -1 } })).success).toBe(
      false,
    );
    expect(invalidations.safeParse(of({ ...record, sourceId: 0 })).success).toBe(false);
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
