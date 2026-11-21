// Contract schemas must also serve as JSON Schema (V01 spec, 스키마 검증 row):
// CLI structured-output options take JSON Schema built from the same definition.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ErrorResponseSchema, routes } from "./index.ts";

describe("contract schemas", () => {
  const schemas = [
    ["error", ErrorResponseSchema],
    ...Object.entries(routes).map(([name, route]) => [name, route.response] as const),
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
});
