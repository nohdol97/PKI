// V01-T12 / R15: the status API reads the vector index state from the configured
// VectorIndex, and the product configuration reports it unavailable.
import { routes, type VectorIndex } from "@pki/contracts";
import { MemoryVectorIndex, send } from "@pki/testkit";
import { describe, expect, it } from "vitest";
import { productAdapters } from "./composition.ts";
import { startServer } from "./server.ts";

const TOKEN = "s".repeat(43);

async function vectorIndexStatus(vectorIndex: VectorIndex) {
  const server = await startServer({ token: TOKEN, allowedOrigins: [], vectorIndex });
  try {
    const res = await send(server.port, routes.status.path, {
      host: `127.0.0.1:${server.port}`,
      authorization: `Bearer ${TOKEN}`,
    });
    return routes.status.response.parse(res.body).vectorIndex;
  } finally {
    await server.close();
  }
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
});
