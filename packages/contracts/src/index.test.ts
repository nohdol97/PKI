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
      }).success,
    ).toBe(true);
    expect(routes.status.response.safeParse({ backend: { state: "ready" } }).success).toBe(false);
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
});
