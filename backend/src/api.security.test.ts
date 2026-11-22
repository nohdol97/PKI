// V01-C2 `api.security`: a real server on an ephemeral port rejects each
// unauthorized request kind and is unreachable from non-loopback addresses.
import { migrate } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { send, sendRaw } from "@pki/testkit";
import { productAdapters, productEgress } from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import { startServer, type RunningServer } from "./server.ts";

const TOKEN = "t".repeat(43);
const ALLOWED_ORIGIN = "http://localhost:5173";

let server: RunningServer;
let valid: Record<string, string>;
const synced: string[] = [];
const imported: string[] = [];
const db = openBetterSqlite3(":memory:");
migrate(db);
const stores = { db, dataDirectory: "/synthetic/data", egress: productEgress(db) };
const connectors: ConnectorManager = {
  list: () => [],
  sync: async (id) => {
    synced.push(id);
    return {
      connectorId: id,
      received: 0,
      created: 0,
      unchanged: 0,
      scopeUpdated: 0,
      stale: 0,
      staleTombstone: 0,
      blocked: 0,
      tombstoned: 0,
      rejected: [],
      rejectedCount: 0,
      rescanned: false,
      deletionsMayBeMissed: false,
    };
  },
};

beforeAll(async () => {
  server = await startServer({
    token: TOKEN,
    allowedOrigins: [ALLOWED_ORIGIN],
    connectors,
    ...stores,
    ...productAdapters(stores.dataDirectory),
    // a double that only records: the route's checks are what is under test (I01-R24)
    instanceImporter: async (instanceId) => {
      imported.push(instanceId);
      return { error: "bad-request" };
    },
  });
  valid = {
    host: `127.0.0.1:${server.port}`,
    authorization: `Bearer ${TOKEN}`,
    origin: ALLOWED_ORIGIN,
  };
});
afterAll(() => server.close());

function without(name: string) {
  return Object.fromEntries(Object.entries(valid).filter(([key]) => key !== name));
}

describe("local API security", () => {
  it("accepts a request that passes every check", async () => {
    expect((await send(server.port, "/api/status", valid)).status).toBe(200);
  });

  it("accepts a request without Origin (non-browser client)", async () => {
    expect((await send(server.port, "/api/status", without("origin"))).status).toBe(200);
  });

  it("rejects a request without a token", async () => {
    const res = await send(server.port, "/api/status", without("authorization"));
    expect(res).toEqual({ status: 401, body: { error: "unauthorized" } });
  });

  it("rejects a request with a wrong token", async () => {
    for (const authorization of [`Bearer ${"x".repeat(43)}`, `Bearer ${TOKEN}x`, TOKEN]) {
      const res = await send(server.port, "/api/status", { ...valid, authorization });
      expect(res).toEqual({ status: 401, body: { error: "unauthorized" } });
    }
  });

  it("rejects a Host that is not the server's own address", async () => {
    for (const host of ["evil.example", `evil.example:${server.port}`, "127.0.0.1:1"]) {
      const res = await send(server.port, "/api/status", { ...valid, host });
      expect(res).toEqual({ status: 403, body: { error: "forbidden-host" } });
    }
  });

  it("rejects an Origin that is not on the allowlist", async () => {
    for (const origin of ["https://evil.example", "null", `http://127.0.0.1:${server.port}x`]) {
      const res = await send(server.port, "/api/status", { ...valid, origin });
      expect(res).toEqual({ status: 403, body: { error: "forbidden-origin" } });
    }
  });

  it("checks before routing, so unknown paths leak nothing to unauthorized callers", async () => {
    const res = await send(server.port, "/nope", without("authorization"));
    expect(res.status).toBe(401);
  });

  it("runs a sync only for a request that passes every check", async () => {
    const body = { connectorId: "c" };
    for (const [header, value] of [
      ["authorization", "Bearer wrong"],
      ["host", "evil.example"],
      ["origin", "https://evil.example"],
    ] as const) {
      const res = await send(
        server.port,
        "/api/connectors/sync",
        { ...valid, [header]: value },
        "POST",
        body,
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    expect(synced).toEqual([]);
    expect((await send(server.port, "/api/connectors/sync", valid, "POST", body)).status).toBe(200);
    expect(synced).toEqual(["c"]);
  });

  it("runs an import (POST /api/imports) only for a request that passes every check (I01-R24, import.api ①)", async () => {
    const body = { instanceId: "i", content: "" };
    for (const [header, value, status] of [
      ["authorization", "Bearer wrong", 401],
      ["host", "evil.example", 403],
      ["origin", "https://evil.example", 403],
    ] as const) {
      const res = await send(
        server.port,
        "/api/imports",
        { ...valid, [header]: value },
        "POST",
        body,
      );
      expect(res.status).toBe(status);
    }
    expect(imported).toEqual([]);
    expect((await send(server.port, "/api/imports", valid, "POST", body)).status).toBe(400);
    expect(imported).toEqual(["i"]);
  });

  it("rejects a request carrying more than one Host header", async () => {
    const host = `Host: 127.0.0.1:${server.port}`;
    const auth = `Authorization: Bearer ${TOKEN}`;
    expect(await sendRaw(server.port, ["GET /api/status HTTP/1.1", host, auth])).toBe(200);
    expect(
      await sendRaw(server.port, ["GET /api/status HTTP/1.1", host, "Host: evil.example", auth]),
    ).toBe(400);
  });

  it("rejects an absolute-form request URI", async () => {
    const res = await send(server.port, `http://evil.example/api/status`, valid);
    expect(res).toEqual({ status: 400, body: { error: "bad-request" } });
  });

  it("does not let a backslash target name its own authority", async () => {
    const lines = [`Host: 127.0.0.1:${server.port}`, `Authorization: Bearer ${TOKEN}`];
    expect(await sendRaw(server.port, ["GET /\\evil.example/api/status HTTP/1.1", ...lines])).toBe(
      404,
    );
  });

  it("rejects a protocol-relative request target", async () => {
    const lines = [`Host: 127.0.0.1:${server.port}`, `Authorization: Bearer ${TOKEN}`];
    expect(await sendRaw(server.port, ["GET //evil.example/api/status HTTP/1.1", ...lines])).toBe(
      400,
    );
  });

  it("binds to 127.0.0.1", () => {
    expect(server.address).toBe("127.0.0.1");
  });

  const external = Object.values(networkInterfaces())
    .flat()
    .find((info) => info && !info.internal && info.family === "IPv4")?.address;

  it.skipIf(!external)(`refuses connections on a non-loopback address (${external})`, async () => {
    const outcome = await new Promise<string>((resolve) => {
      const socket = connect({ host: external, port: server.port });
      socket.on("connect", () => {
        socket.destroy();
        resolve("connected");
      });
      socket.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
    });
    expect(outcome).toBe("ECONNREFUSED");
  });

  it("refuses to start with a token too short to be a fresh secret", async () => {
    await expect(
      startServer({
        token: "",
        allowedOrigins: [],
        connectors,
        ...stores,
        ...productAdapters(stores.dataDirectory),
      }),
    ).rejects.toThrow(/token/);
    await expect(
      startServer({
        token: "short",
        allowedOrigins: [],
        connectors,
        ...stores,
        ...productAdapters(stores.dataDirectory),
      }),
    ).rejects.toThrow(/token/);
  });
});
