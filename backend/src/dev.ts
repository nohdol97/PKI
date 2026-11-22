// Development entry: `pnpm --filter @pki/backend dev [--port N] [--origin URL]... [--data-dir DIR]
// [--fixtures FILE]`. The test Connector replays FILE (default: the repository's fixtures).
// The DB defaults to a sibling "PKI-dev" folder (same OS rules as the product's data
// directory), so synthetic seeds never land in the product's canonical DB.
// The session token is generated here and written to stdout as one JSON line, so it
// reaches only whoever holds this process's stdout pipe — not argv/env (readable by
// other processes of the same user) and not a file left on disk.
// The browser has no shell to hold secrets, so here only a Provider's key comes from
// the environment (PKI_DEV_SECRET_<NAME>, secret-sources.ts), read at call time and
// never stored. This entry is not part of the product build.
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { dataDirectory } from "@pki/storage";
import { bootBackend, closeProviders } from "./boot.ts";
import { fixtureConnectors } from "./composition.ts";
import { envSecrets } from "./secret-sources.ts";

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
const token = randomBytes(32).toString("base64url");
const { server, providers } = await bootBackend({
  dataDir: dir,
  connectors: fixtureConnectors(values.fixtures),
  token,
  allowedOrigins: values.origin,
  port: Number(values.port),
  secrets: envSecrets(process.env),
});
process.stdout.write(`${JSON.stringify({ url: server.url, token })}\n`);
// stopped by the dev server (SIGTERM) or Ctrl+C: end running CLI trees first (V01-T10)
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => void closeProviders(providers, 3_000).then(() => process.exit(0)));
}
