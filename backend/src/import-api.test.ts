// V02-R2: the Sources screen's import goes through POST /api/import/jsonl. The
// body limit of this route only is raised to take a file; the response is the
// import's counts and its per-line errors, checked against @pki/contracts.
import { routes } from "@pki/contracts";
import { migrate } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { send } from "@pki/testkit";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { productAdapters, productEgress, productImporter } from "./composition.ts";
import { createConnectorManager } from "./connectors.ts";
import { IMPORT_BODY_LIMIT, startServer, type RunningServer } from "./server.ts";

const TOKEN = "i".repeat(43);
const MAIL = readFileSync(resolve(import.meta.dirname, "../../fixtures/v02-mail.jsonl"), "utf8");
const db = openBetterSqlite3(":memory:");
let bound: RunningServer;
let unbound: RunningServer;

const options = async () => ({
  token: TOKEN,
  allowedOrigins: [],
  connectors: await createConnectorManager(db, [], {}),
  db,
  dataDirectory: "/synthetic/data",
  egress: productEgress(db),
  ...productAdapters("/synthetic/data"),
});
const headers = (server: RunningServer) => ({
  host: `127.0.0.1:${server.port}`,
  authorization: `Bearer ${TOKEN}`,
});
const post = (server: RunningServer, body: unknown) =>
  send(server.port, routes.importJsonl.path, headers(server), "POST", body);

beforeAll(async () => {
  migrate(db);
  bound = await startServer({ ...(await options()), importer: productImporter(db) });
  unbound = await startServer(await options());
});
afterAll(async () => {
  await bound.close();
  await unbound.close();
  db.close();
});

describe("POST /api/import/jsonl", () => {
  it("imports a file larger than the other routes' body limit and reports its line errors", async () => {
    const padding = Array(400).fill("{".repeat(60)).join("\n"); // ~24 KiB of malformed lines
    const res = await post(bound, { text: `${MAIL.trimEnd()}\n${padding}` });
    expect(res.status).toBe(200);
    const body = routes.importJsonl.response.parse(res.body);
    expect(body).toEqual(res.body);
    expect(body.received).toBe(1);
    expect(body.created).toBe(1);
    expect(body.errors).toHaveLength(400);
    expect(body.errors[0]).toEqual({ line: 2, reason: "invalid-json" });
  });

  it("refuses a body over the import limit", async () => {
    const res = await post(bound, { text: "x".repeat(IMPORT_BODY_LIMIT) });
    expect(res).toEqual({ status: 400, body: { error: "bad-request" } });
  });

  it("answers connector-unavailable when the composition bound no importer", async () => {
    expect(await post(unbound, { text: MAIL })).toEqual({
      status: 409,
      body: { error: "connector-unavailable" },
    });
  });
});
