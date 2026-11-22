// I01-R24, C3 `import.api` ①: POST /api/imports over a real server. The size limit answers 413
// before a body is parsed, a request that does not fit the contract 400, an instance bound to
// another kind 400, a held instance 409 `instance-busy`, a failed storage 500 `storage-failed`;
// every answer matches @pki/contracts. Synthetic data only.
import { ErrorResponseSchema, routes } from "@pki/contracts";
import { MAX_JSONL_BYTES } from "@pki/connector-sdk";
import type { SqlDriver } from "@pki/storage";
import { send, sendRaw } from "@pki/testkit";
import { request } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  openCanonicalDb,
  productAdapters,
  productEgress,
  productInstanceImporter,
} from "./composition.ts";
import { createConnectorManager, tryLockInstance } from "./connectors.ts";
import { errorStatus, IMPORTS_BODY_LIMIT, startServer, type RunningServer } from "./server.ts";

const TOKEN = "h".repeat(43);
const MAIL = readFileSync(resolve(import.meta.dirname, "../../fixtures/v02-mail.jsonl"), "utf8");

let dir: string;
let db: SqlDriver;
let server: RunningServer;
let valid: Record<string, string>;
const logged: unknown[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pki-import-http-"));
  db = openCanonicalDb(join(dir, "data"));
  server = await startServer({
    token: TOKEN,
    allowedOrigins: [],
    connectors: await createConnectorManager(db, [], {}),
    db,
    dataDirectory: dir,
    egress: productEgress(db),
    ...productAdapters(dir),
    instanceImporter: productInstanceImporter(db, { logger: (...args) => void logged.push(args) }),
  });
  valid = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` };
});
afterAll(async () => {
  await server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const route = routes.imports;
const post = (body: unknown) => send(server.port, route.path, valid, route.method, body);
const sourceCount = () => db.all("SELECT count(*) AS n FROM sources")[0]?.n as number;

describe("import.api ①: POST /api/imports", () => {
  it("answers 200 with a sync-shaped result that matches the contract", async () => {
    const res = await post({ instanceId: "http-ok", content: MAIL });
    expect(res.status).toBe(200);
    expect(route.response.parse(res.body)).toMatchObject({
      connectorId: "http-ok",
      received: 1,
      created: 1,
      rejected: [],
    });
  });

  it.each([
    ["not json", "not json"],
    ["no instanceId", { content: "" }],
    ["an empty instanceId", { instanceId: "", content: "" }],
    ["an over-long instanceId", { instanceId: "i".repeat(129), content: "" }],
    ["no content", { instanceId: "i" }],
    ["content that is not a string", { instanceId: "i", content: 5 }],
    ["an unknown key", { instanceId: "i", content: "", extra: 1 }],
  ])("answers 400 bad-request to %s", async (_name, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(ErrorResponseSchema.parse(res.body)).toEqual({ error: "bad-request" });
  });

  it("answers 400 for an instance registered as another kind, and stores nothing", async () => {
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('http-other', 'test-fixtures')");
    const before = sourceCount();
    const res = await post({ instanceId: "http-other", content: MAIL });
    expect(res).toEqual({ status: 400, body: { error: "bad-request" } });
    expect(sourceCount()).toBe(before);
  });

  it("answers 409 instance-busy while the instance is held, then works once it is free", async () => {
    const release = tryLockInstance(db, "http-busy");
    const held = await post({ instanceId: "http-busy", content: MAIL });
    expect(held.status).toBe(409);
    expect(ErrorResponseSchema.parse(held.body)).toEqual({ error: "instance-busy" });
    release?.();
    expect((await post({ instanceId: "http-busy", content: MAIL })).status).toBe(200);
  });

  it("answers 500 storage-failed when the transaction fails, with none of the text, and logs the class only", async () => {
    const canary = "CANARY-http-storage-8812";
    db.exec(`CREATE TRIGGER http_boom BEFORE INSERT ON sources WHEN new.external_id LIKE 'boom%'
      BEGIN SELECT RAISE(ABORT, '${canary}'); END`);
    const line = JSON.stringify({ ...JSON.parse(MAIL.trim()), external_id: "boom-1" });
    try {
      const before = sourceCount();
      const res = await post({ instanceId: "http-fail", content: line });
      expect(res.status).toBe(500);
      expect(ErrorResponseSchema.parse(res.body)).toEqual({ error: "storage-failed" });
      expect(JSON.stringify(res.body)).not.toContain(canary);
      expect(sourceCount()).toBe(before);
      expect(JSON.stringify(logged)).not.toContain(canary);
      expect(logged.length).toBeGreaterThan(0);
    } finally {
      db.exec("DROP TRIGGER http_boom");
    }
  });
});

describe("the API's error table (I01-T03 handoff 7)", () => {
  it("maps the import API's own codes: instance-busy 409 and storage-failed 500", () => {
    // storage-failed is also the table's default (500); the entry says it is meant
    expect(errorStatus["instance-busy"]).toBe(409);
    expect(errorStatus["storage-failed"]).toBe(500);
    expect(errorStatus["bad-request"]).toBe(400);
  });
});

describe("import.api ①: the size limit (I01-R24)", () => {
  /** A request body of exactly `bytes`: blank content pads it. */
  const body = (bytes: number) => {
    const shell = JSON.stringify({ instanceId: "http-size", content: "" });
    return `${shell.slice(0, -2)}${" ".repeat(bytes - shell.length)}"}`;
  };

  it("is 10 MiB, and a body of exactly the limit is accepted", async () => {
    expect(MAX_JSONL_BYTES).toBe(10 * 1024 * 1024);
    expect(IMPORTS_BODY_LIMIT).toBe(MAX_JSONL_BYTES);
    const text = body(IMPORTS_BODY_LIMIT);
    expect(Buffer.byteLength(text)).toBe(IMPORTS_BODY_LIMIT);
    const res = await send(server.port, route.path, valid, "POST", text);
    expect(res.status).toBe(200);
  });

  it("answers 413 payload-too-large to a body one byte over, before storing or parsing anything", async () => {
    const before = sourceCount();
    const res = await send(server.port, route.path, valid, "POST", body(IMPORTS_BODY_LIMIT + 1));
    expect(res.status).toBe(413);
    expect(ErrorResponseSchema.parse(res.body)).toEqual({ error: "payload-too-large" });
    expect(sourceCount()).toBe(before);
  });

  it("answers 413 on the declared length alone, without waiting for the body", async () => {
    const status = await sendRaw(server.port, [
      `POST ${route.path} HTTP/1.1`,
      `Host: ${valid.host}`,
      `Authorization: ${valid.authorization}`,
      "Content-Type: application/json",
      `Content-Length: ${IMPORTS_BODY_LIMIT + 1}`,
    ]);
    expect(status).toBe(413);
  });

  it("answers 413 to a chunked body over the limit that declares no length", async () => {
    const res = await new Promise<{ status: number; body: unknown }>((done, fail) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: server.port,
          path: route.path,
          method: "POST",
          headers: { ...valid, "transfer-encoding": "chunked" },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (c: Buffer) => chunks.push(c));
          response.on("end", () =>
            done({
              status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            }),
          );
        },
      );
      req.on("error", fail);
      req.end(body(IMPORTS_BODY_LIMIT + 1));
    });
    expect(res).toEqual({ status: 413, body: { error: "payload-too-large" } });
  });

  it("keeps the other routes at 400 for a body over their limits", async () => {
    const res = await send(
      server.port,
      routes.syncConnector.path,
      valid,
      "POST",
      JSON.stringify({ connectorId: "x".repeat(20_000) }),
    );
    expect(res).toEqual({ status: 400, body: { error: "bad-request" } });
  });
});
