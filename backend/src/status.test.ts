// V01-T12 / R15: the status API reads the vector index state from the configured
// VectorIndex, and the product configuration reports it unavailable.
import { ErrorResponseSchema, routes, type VectorIndex } from "@pki/contracts";
import { migrate } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { MemoryVectorIndex, send } from "@pki/testkit";
import { describe, expect, it, vi } from "vitest";
import { productAdapters, productEgress } from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import { startServer } from "./server.ts";

const TOKEN = "s".repeat(43);
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };
const db = openBetterSqlite3(":memory:");
migrate(db);
const stores = { db, dataDirectory: "/synthetic/data", egress: productEgress(db) };

async function getStatus(vectorIndex: VectorIndex) {
  const server = await startServer({
    token: TOKEN,
    allowedOrigins: [],
    vectorIndex,
    connectors,
    ...stores,
  });
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

  it.each([
    ["an empty reason", { unavailable: "" }],
    ["an unknown state", "warming-up"],
  ])("degrades only the vector index on %s outside the contract", async (_name, bogus) => {
    const misbehaving = Object.assign(new MemoryVectorIndex(), {
      status: async () => bogus as never,
    });
    const res = await getStatus(misbehaving);
    expect(res.status).toBe(200);
    expect(routes.status.response.parse(res.body)).toMatchObject({
      backend: { state: "ready" },
      vectorIndex: { state: "unavailable", reason: "status check failed" },
    });
  });

  it("answers a handler failure with a generic 500 and logs no error text", async () => {
    const canary = "CANARY-7f3a secret detail";
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const options = {
      token: TOKEN,
      allowedOrigins: [],
      connectors,
      ...stores,
      get vectorIndex(): VectorIndex {
        throw new TypeError(canary);
      },
    };
    const server = await startServer(options);
    try {
      const res = await send(server.port, routes.status.path, {
        host: `127.0.0.1:${server.port}`,
        authorization: `Bearer ${TOKEN}`,
      });
      expect(res).toEqual({ status: 500, body: { error: "internal-error" } });
      expect(ErrorResponseSchema.parse(res.body)).toEqual(res.body);
      const lines = logged.mock.calls.map((args) => args.map(String).join(" "));
      expect(lines).toEqual([expect.stringMatching(/status.*TypeError/)]);
      expect(lines.join("\n")).not.toContain("CANARY");
    } finally {
      logged.mockRestore();
      await server.close();
    }
  });
});
