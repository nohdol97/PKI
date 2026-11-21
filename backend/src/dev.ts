// Development entry: `pnpm --filter @pki/backend dev [--port N] [--origin URL]...`.
// The session token is generated here and written to stdout as one JSON line, so it
// reaches only whoever holds this process's stdout pipe — not argv/env (readable by
// other processes of the same user) and not a file left on disk.
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { startServer } from "./server.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "0" },
    origin: { type: "string", multiple: true, default: [] },
  },
});

const token = randomBytes(32).toString("base64url");
const server = await startServer({
  token,
  allowedOrigins: values.origin,
  port: Number(values.port),
});
process.stdout.write(`${JSON.stringify({ url: server.url, token })}\n`);
