// Development entry: `pnpm --filter @pki/backend dev [--port N] [--origin URL]... [--data-dir DIR]
// [--fixtures FILE]`. The test Connector replays FILE (default: the repository's fixtures).
// The DB defaults to a sibling "PKI-dev" folder (same OS rules as the product's data
// directory), so synthetic seeds never land in the product's canonical DB.
// The session token is generated here and written to stdout as one JSON line, so it
// reaches only whoever holds this process's stdout pipe — not argv/env (readable by
// other processes of the same user) and not a file left on disk.
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { dataDirectory } from "@pki/storage";
import {
  CANONICAL_DB_FILE,
  connectorInstances,
  connectorKinds,
  openCanonicalDb,
  productAdapters,
  productEgress,
} from "./composition.ts";
import { createConnectorManager } from "./connectors.ts";
import { startServer } from "./server.ts";

// Development seeds come from the repository's synthetic fixtures (V01-R7).
const FIXTURES = resolve(import.meta.dirname, "../../fixtures/test-connector.jsonl");

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "0" },
    origin: { type: "string", multiple: true, default: [] },
    "data-dir": { type: "string" },
    fixtures: { type: "string", default: FIXTURES },
  },
});

const dir = values["data-dir"] ?? `${dataDirectory()}-dev`;
const db = openCanonicalDb(dir);
const connectors = await createConnectorManager(
  db,
  connectorInstances(values.fixtures),
  connectorKinds,
);
const token = randomBytes(32).toString("base64url");
const server = await startServer({
  token,
  allowedOrigins: values.origin,
  port: Number(values.port),
  ...productAdapters(),
  connectors,
  db,
  dataDirectory: dir,
  databaseFile: join(dir, CANONICAL_DB_FILE),
  egress: productEgress(db),
});
process.stdout.write(`${JSON.stringify({ url: server.url, token })}\n`);
