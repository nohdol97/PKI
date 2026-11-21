// V01-T12 / R15: the status API reads the vector index state from the configured
// VectorIndex, and the product configuration reports it unavailable.
import { ErrorResponseSchema, routes, type VectorIndex } from "@pki/contracts";
import { MemoryVectorIndex, send } from "@pki/testkit";
import { describe, expect, it } from "vitest";
import { productAdapters } from "./composition.ts";
import { startServer } from "./server.ts";

const TOKEN = "s".repeat(43);

async function getStatus(vectorIndex: VectorIndex) {
  const server = await startServer({ token: TOKEN, allowedOrigins: [], vectorIndex });
  try {
    return await send(server.port, routes.status.path, {
      host: `127.0.0.1:${server.port}`,
      authorization: `Bearer ${TOKEN}`,
    });
  } finally {
    await server.close();
  }
}

async function vectorIndexStatus(vectorIndex: VectorIndex) {
  return routes.status.response.parse((await getStatus(vectorIndex)).body).vectorIndex;
}

describe("status API: vector index", () => {
  it("is unavailable, with a reason, in the product configuration", async () => {
    expect(await vectorIndexStatus(productAdapters().vectorIndex)).toEqual({
      state: "unavailable",
      reason: expect.stringMatching(/\S/),
    });
  });

  it("reports what the configured index says", async () => {
    const ready = new MemoryVectorIndex();
    const rebuilding = Object.assign(new MemoryVectorIndex(), {
      status: async () => "rebuilding" as const,
    });
    expect(await vectorIndexStatus(ready)).toEqual({ state: "ready" });
    expect(await vectorIndexStatus(rebuilding)).toEqual({ state: "rebuilding" });
  });

  it("reports an index whose status cannot be read as unavailable", async () => {
    const broken = Object.assign(new MemoryVectorIndex(), {
      status: async () => Promise.reject(new Error("corrupt")),
    });
    expect(await vectorIndexStatus(broken)).toEqual({
      state: "unavailable",
      reason: "status check failed",
    });
  });

  it("answers a handler failure with a generic 500 and no detail", async () => {
    // A status outside the contract (empty reason) makes the handler reject.
    const misbehaving = Object.assign(new MemoryVectorIndex(), {
      status: async () => ({ unavailable: "" }),
    });
    const res = await getStatus(misbehaving);
    expect(res.status).toBe(500);
    expect(ErrorResponseSchema.parse(res.body)).toEqual({ error: "internal-error" });
    expect(res.body).toEqual({ error: "internal-error" });
  });
});
