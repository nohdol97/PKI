// I06-T04 (I06-R12, R13; I06-C9 ④ ⑥, C10): the API of the credential path. A real server on a real manager with a
// memory store: the list carries each declared slot's presence (never a value), and the change notice
// (POST /api/connectors/credentials-changed) answers with the instance's summary and what became of the rebuild.
// The request and the answer have no field a value could ride in. Every value is made up.
import {
  CredentialsChangedRequestSchema,
  CredentialsChangedResponseSchema,
  ConnectorCredentialError,
  CONNECTOR_SDK_VERSION,
  ErrorResponseSchema,
  routes,
  type Connector,
  type ConnectorContext,
  type SecretRead,
} from "@pki/contracts";
import { migrate } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { send } from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { productAdapters, productEgress } from "./composition.ts";
import { connectorCredentialName } from "./connector-credentials.ts";
import { createConnectorManager, type ConnectorFactory } from "./connectors.ts";
import { startServer, type RunningServer } from "./server.ts";

const TOKEN = "k".repeat(43);
const KIND = "fork";
const route = routes.credentialsChanged;
const name = (id: string, slot = "token") => connectorCredentialName(KIND, id, slot);

/** Accepts only the stored value "synthetic-good-token"; the origin refuses anything else. */
const factory: ConnectorFactory = () =>
  ({
    manifest: {
      type: KIND,
      schemaVersion: CONNECTOR_SDK_VERSION,
      capabilities: {
        incremental: true,
        deletes: true,
        accessScope: false,
        fullRescan: true,
        deletionsOnRescan: false,
      },
    },
    initialize: async (_config: unknown, context?: ConnectorContext) => {
      const value = await (context as ConnectorContext).credentials.read("token");
      if (value !== "synthetic-good-token") throw new ConnectorCredentialError();
    },
    healthCheck: async () => ({ state: "ok" as const }),
    getChanges: async () => ({ changes: [], nextCursor: "0", hasMore: false }),
    getDocument: async () => null,
  }) as unknown as Connector;

const values = new Map<string, string>();
const store = {
  read: async (n: string): Promise<SecretRead> => {
    const value = values.get(n);
    return value === undefined ? { state: "missing" } : { state: "present", value };
  },
  has: async (n: string) => (values.has(n) ? ("present" as const) : ("missing" as const)),
  deleteOthers: async () => "done" as const,
};

let server: RunningServer;
let headers: Record<string, string>;
let close: () => void;
beforeEach(async () => {
  values.clear();
  const db = openBetterSqlite3(":memory:");
  migrate(db);
  const connectors = await createConnectorManager(
    db,
    [
      { id: "with-slot", kind: KIND, config: {}, credentials: ["token"] },
      { id: "no-slot", kind: KIND, config: {} },
    ],
    { [KIND]: factory },
    { secrets: store },
  );
  const stores = { db, dataDirectory: "/synthetic/data", egress: productEgress(db) };
  server = await startServer({
    token: TOKEN,
    allowedOrigins: [],
    connectors,
    ...stores,
    ...productAdapters(stores.dataDirectory),
  });
  headers = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` };
  close = () => db.close();
});
afterEach(async () => {
  await server.close();
  close();
});

const notify = (body: unknown) => send(server.port, route.path, headers, route.method, body);
const list = async () =>
  (await send(server.port, routes.connectors.path, headers)).body as {
    connectors: { id: string; state: string; reason?: string; credentials?: unknown[] }[];
  };

describe("connectors.credentials-api (I06-T04)", () => {
  it("C10 lists a declared slot's name and presence, none for an instance that declared none, and never a value", async () => {
    let seen = await list();
    expect(seen.connectors.find((c) => c.id === "no-slot")).not.toHaveProperty("credentials");
    expect(seen.connectors.find((c) => c.id === "with-slot")).toMatchObject({
      state: "unavailable",
      reason: "credential-missing",
      credentials: [{ slot: "token", name: name("with-slot"), state: "missing" }],
    });
    values.set(name("with-slot"), "synthetic-good-token");
    await notify({ connectorId: "with-slot" });
    seen = await list();
    expect(seen.connectors.find((c) => c.id === "with-slot")?.credentials).toEqual([
      { slot: "token", name: name("with-slot"), state: "present" },
    ]);
    expect(JSON.stringify(seen)).not.toContain("synthetic-good-token");
  });

  it("C9 a value stored since the start, then the notice: done, ready, and the answer is the summary and the rebuild only", async () => {
    values.set(name("with-slot"), "synthetic-good-token");
    const res = await notify({ connectorId: "with-slot" });
    expect(res.status).toBe(200);
    expect(CredentialsChangedResponseSchema.parse(res.body)).toEqual(res.body);
    expect(res.body).toEqual({
      summary: {
        id: "with-slot",
        kind: KIND,
        state: "ready",
        credentials: [{ slot: "token", name: name("with-slot"), state: "present" }],
      },
      rebuild: "done",
    });
    expect(JSON.stringify(res.body)).not.toContain("synthetic-good-token");
  });

  it("a wrong value is refused by the origin: the notice answers credential-rejected", async () => {
    values.set(name("with-slot"), "synthetic-wrong-token");
    expect((await notify({ connectorId: "with-slot" })).body).toMatchObject({
      summary: { state: "unavailable", reason: "credential-rejected" },
      rebuild: "done",
    });
  });

  it("C9 ③ a ready instance whose value was deleted is rebuilt into credential-missing", async () => {
    values.set(name("with-slot"), "synthetic-good-token");
    expect((await notify({ connectorId: "with-slot" })).body).toMatchObject({
      summary: { state: "ready" },
    });
    values.delete(name("with-slot"));
    expect((await notify({ connectorId: "with-slot" })).body).toMatchObject({
      summary: {
        state: "unavailable",
        reason: "credential-missing",
        credentials: [{ slot: "token", state: "missing" }],
      },
      rebuild: "done",
    });
  });

  it("an instance that declared no slot is rebuilt the same way, and its summary has no credentials", async () => {
    const res = await notify({ connectorId: "no-slot" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rebuild: "done" });
    expect((res.body as { summary: object }).summary).not.toHaveProperty("credentials");
  });

  it.each([
    ["not json", "not json"],
    ["no id", {}],
    ["empty id", { connectorId: "" }],
    ["a value field (the schema is strict)", { connectorId: "with-slot", value: "x" }],
    ["a credentials field", { connectorId: "with-slot", credentials: { token: "x" } }],
  ])("C9 ⑥ a request with %s is bad-request and rebuilds nothing", async (_label, body) => {
    values.set(name("with-slot"), "synthetic-good-token");
    const res = await notify(body);
    expect(res.status).toBe(400);
    expect(ErrorResponseSchema.parse(res.body)).toEqual({ error: "bad-request" });
    // nothing was rebuilt: the instance still shows the state of the start (no value was stored then)
    expect((await list()).connectors.find((c) => c.id === "with-slot")?.state).toBe("unavailable");
  });

  it("C9 ④ an unknown id is not-found", async () => {
    const res = await notify({ connectorId: "nope" });
    expect(res.status).toBe(404);
    expect(ErrorResponseSchema.parse(res.body)).toEqual({ error: "not-found" });
  });

  it("C9 ⑥ the schemas have no field a value could ride in", () => {
    expect(CredentialsChangedRequestSchema.safeParse({ connectorId: "a" }).success).toBe(true);
    expect(
      CredentialsChangedRequestSchema.safeParse({ connectorId: "a", value: "x" }).success,
    ).toBe(false);
    const answer = {
      summary: { id: "a", kind: KIND, state: "ready" },
      rebuild: "done",
    };
    expect(CredentialsChangedResponseSchema.safeParse(answer).success).toBe(true);
    expect(CredentialsChangedResponseSchema.safeParse({ ...answer, value: "x" }).success).toBe(
      false,
    );
    for (const rebuild of ["queued", "skipped"]) {
      expect(CredentialsChangedResponseSchema.safeParse({ ...answer, rebuild }).success).toBe(true);
    }
    expect(
      CredentialsChangedResponseSchema.safeParse({ ...answer, rebuild: "maybe" }).success,
    ).toBe(false);
  });
});

describe("the route passes the manager's answer through", () => {
  it.each(["done", "queued", "skipped"] as const)(
    "answers %s as the manager said it",
    async (rebuild) => {
      const db = openBetterSqlite3(":memory:");
      migrate(db);
      const stores = { db, dataDirectory: "/synthetic/data", egress: productEgress(db) };
      const stub = await startServer({
        token: TOKEN,
        allowedOrigins: [],
        connectors: {
          list: () => [],
          sync: async () => ({ error: "not-found" as const }),
          rebuild: async (id) => ({ summary: { id, kind: KIND, state: "ready" }, rebuild }),
        },
        ...stores,
        ...productAdapters(stores.dataDirectory),
      });
      try {
        const res = await send(
          stub.port,
          route.path,
          { host: `127.0.0.1:${stub.port}`, authorization: `Bearer ${TOKEN}` },
          route.method,
          { connectorId: "x" },
        );
        expect(res.status).toBe(200);
        expect(CredentialsChangedResponseSchema.parse(res.body)).toMatchObject({ rebuild });
      } finally {
        await stub.close();
        db.close();
      }
    },
  );
});

describe("the route without a manager that can rebuild", () => {
  it("answers connector-unavailable (a manager of a development entry has no rebuild)", async () => {
    const db = openBetterSqlite3(":memory:");
    migrate(db);
    const stores = { db, dataDirectory: "/synthetic/data", egress: productEgress(db) };
    const bare = await startServer({
      token: TOKEN,
      allowedOrigins: [],
      connectors: { list: () => [], sync: async () => ({ error: "not-found" as const }) },
      ...stores,
      ...productAdapters(stores.dataDirectory),
    });
    try {
      const res = await send(
        bare.port,
        route.path,
        { host: `127.0.0.1:${bare.port}`, authorization: `Bearer ${TOKEN}` },
        route.method,
        { connectorId: "x" },
      );
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "connector-unavailable" });
    } finally {
      await bare.close();
      db.close();
    }
  });
});
