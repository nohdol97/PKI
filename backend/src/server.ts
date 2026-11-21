// Local API server (V01-R2, ADR 0008): loopback-only, and every request must
// carry the per-run session token, name this server as Host, and come from an
// allowlisted Origin (or no Origin: non-browser clients such as the shell).
import { routes, type ErrorResponse, type RouteName, type RouteResponse } from "@pki/contracts";
import { timingSafeEqual } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { matchRoute } from "./routing.ts";

const LOOPBACK = "127.0.0.1";
const MIN_TOKEN_LENGTH = 32;

export interface ServerOptions {
  /** Fresh per run; the caller generates it and passes it in-process, never via argv/env. */
  token: string;
  /** Exact `Origin` values allowed to call, e.g. the browser dev server. */
  allowedOrigins: readonly string[];
  /** 0 (default) picks a free port. */
  port?: number;
}

export interface RunningServer {
  url: string;
  /** The address actually bound, as reported by the socket. */
  address: string;
  port: number;
  close(): Promise<void>;
}

const handlers: { [Name in RouteName]: () => RouteResponse<Name> } = {
  status: () => ({
    backend: { state: "ready" },
    provider: { state: "not-implemented" },
    embedding: { state: "not-implemented" },
    vectorIndex: { state: "not-implemented" },
  }),
};

function reply(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function reject(res: ServerResponse, status: number, error: ErrorResponse["error"]) {
  reply(res, status, { error });
}

function tokenMatches(header: string | undefined, expected: Buffer) {
  const given = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  if (options.token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`session token must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  const token = Buffer.from(options.token);
  const allowedOrigins = new Set(options.allowedOrigins);
  let selfHost = "";

  const server = createServer((req, res) => {
    // Node keeps only the first Host header, and an absolute-form URI names a host of its
    // own; both would let the Host check read something other than what is routed.
    const hostHeaders = req.rawHeaders.filter((name, i) => i % 2 === 0 && /^host$/i.test(name));
    if (hostHeaders.length > 1) return reject(res, 400, "bad-request");
    if (!req.url?.startsWith("/")) return reject(res, 400, "bad-request");
    if (req.headers.host !== selfHost) return reject(res, 403, "forbidden-host");
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      return reject(res, 403, "forbidden-origin");
    }
    if (!tokenMatches(req.headers.authorization, token)) return reject(res, 401, "unauthorized");

    const match = matchRoute(routes, req.method, new URL(req.url, "http://_").pathname);
    if (typeof match !== "string") {
      return reject(res, match.error === "not-found" ? 404 : 405, match.error);
    }
    reply(res, 200, handlers[match]());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, LOOPBACK, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { address, port } = server.address() as AddressInfo;
  selfHost = `${LOOPBACK}:${port}`;
  return {
    url: `http://${selfHost}`,
    address,
    port,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
