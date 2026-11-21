// Development entry: `pnpm --filter @pki/backend dev [--port N] [--origin URL]...`.
// The session token is generated here and written to stdout as one JSON line, so it
// reaches only whoever holds this process's stdout pipe — not argv/env (readable by
// other processes of the same user) and not a file left on disk.
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { productAdapters } from "./composition.ts";
import { connectorInstances, connectorKinds, openCanonicalDb } from "./composition.ts";
import { createConnectorManager } from "./connectors.ts";
import { startServer } from "./server.ts";

// Development seeds come from the repository's synthetic fixtures (V01-R7).
const FIXTURES = resolve(import.meta.dirname, "../../fixtures/test-connector.jsonl");

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "0" },
    origin: { type: "string", multiple: true, default: [] },
  },
});

const db = openCanonicalDb();
const connectors = await createConnectorManager(db, connectorInstances(FIXTURES), connectorKinds);
const token = randomBytes(32).toString("base64url");
const server = await startServer({
  token,
  allowedOrigins: values.origin,
  port: Number(values.port),
  ...productAdapters(),
  connectors,
});
process.stdout.write(`${JSON.stringify({ url: server.url, token })}\n`);
