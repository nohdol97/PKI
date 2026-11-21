// Local API server (V01-R2, ADR 0008): loopback-only, and every request must
// carry the per-run session token, name this server as Host, and come from an
// allowlisted Origin (or no Origin: non-browser clients such as the shell).
import {
  ComponentStatusSchema,
  EmbeddingStatusSchema,
  routes,
  type ComponentStatus,
  type EmbeddingProvider,
  type EmbeddingStatusEntry,
  type ErrorResponse,
  type PrepareSource,
  type RouteName,
  type RouteRequest,
  type RouteResponse,
  type VectorIndex,
} from "@pki/contracts";
import { errorClass, log, type EgressControls } from "@pki/providers";
import {
  databaseEncryption,
  findSources,
  listProviderCalls,
  listSources,
  schemaVersion,
  type SqlDriver,
} from "@pki/storage";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ConnectorManager } from "./connectors.ts";
import { matchRoute } from "./routing.ts";

const LOOPBACK = "127.0.0.1";
const MIN_TOKEN_LENGTH = 32;
const MAX_BODY_BYTES = 16 * 1024;

export interface ServerOptions {
  /** Fresh per run; the caller generates it and passes it in-process, never via argv/env. */
  token: string;
  /** Exact `Origin` values allowed to call, e.g. the browser dev server. */
  allowedOrigins: readonly string[];
  /** 0 (default) picks a free port. */
  port?: number;
  /** Chosen by the composition point (composition.ts), never here. */
  vectorIndex: VectorIndex;
  /** Chosen by the composition point; null while no implementation is bound (reported not implemented). */
  embedder: EmbeddingProvider | null;
  /** Built by the composition point (composition.ts), never here. */
  connectors: ConnectorManager;
  /** The migrated canonical DB the screens read from. */
  db: SqlDriver;
  /** The folder holding `db`, shown read-only in Settings. */
  dataDirectory: string;
  /** The canonical file behind `db`, read to show its encryption state; absent for in-memory. */
  databaseFile?: string;
  /** Consent and egress rules, the same instance the Broker asks (composition.ts). */
  egress: EgressControls;
}

export interface RunningServer {
  url: string;
  /** The address actually bound, as reported by the socket. */
  address: string;
  port: number;
  close(): Promise<void>;
}

type Handlers = {
  [Name in RouteName]: (
    input: RouteRequest<Name>,
  ) => Promise<RouteResponse<Name> | { error: ErrorResponse["error"] }>;
};

const errorStatus: Partial<Record<ErrorResponse["error"], number>> = {
  "not-found": 404,
  "connector-unavailable": 409,
  "destination-unavailable": 409,
  "consent-stale": 409,
  "embedding-not-implemented": 409,
  "embedding-busy": 409,
};

const STATUS_CHECK_FAILED: ComponentStatus = {
  state: "unavailable",
  reason: "status check failed",
};

// One misbehaving adapter degrades only its own entry, so the UI still shows what works (V01-R5).
async function vectorIndexState(index: VectorIndex): Promise<ComponentStatus> {
  try {
    const status = await index.status();
    const mapped = ComponentStatusSchema.safeParse(
      typeof status === "string"
        ? { state: status }
        : { state: "unavailable", reason: status.unavailable },
    );
    // An index that cannot report a valid state cannot serve searches either.
    return mapped.success ? mapped.data : STATUS_CHECK_FAILED;
  } catch {
    return STATUS_CHECK_FAILED;
  }
}

const EMBEDDING_CHECK_FAILED: EmbeddingStatusEntry = {
  state: "unavailable",
  reason: "status check failed",
};

const EMBEDDER_STATES = new Set(["ready", "model-missing", "preparing"]);

// Reads state only: a status request never prepares a model or embeds (V01-R14).
async function embeddingState(embedder: EmbeddingProvider | null): Promise<EmbeddingStatusEntry> {
  if (embedder === null) return { state: "not-implemented" };
  try {
    const { egress } = embedder.describe();
    const status = await embedder.status();
    // "not-implemented" is the API's word for "nothing bound", never an embedder's.
    if (typeof status === "string" && !EMBEDDER_STATES.has(status)) return EMBEDDING_CHECK_FAILED;
    const mapped = EmbeddingStatusSchema.safeParse(
      typeof status === "string"
        ? { state: status, egress }
        : { state: "unavailable", reason: status.unavailable, egress },
    );
    return mapped.success ? mapped.data : EMBEDDING_CHECK_FAILED;
  } catch {
    return EMBEDDING_CHECK_FAILED;
  }
}

/**
 * Starts the preparation the user asked for and answers with the state it left,
 * without waiting (V01-R14). A running one is not restarted, a ready model is left
 * as is. The embedder's error text never reaches the response or the log.
 */
async function prepareEmbedding(
  embedder: EmbeddingProvider | null,
  source: PrepareSource,
  running: Set<AbortController>,
): Promise<RouteResponse<"prepareEmbedding"> | { error: ErrorResponse["error"] }> {
  if (embedder === null) return { error: "embedding-not-implemented" };
  const before = await embeddingState(embedder);
  // `running` is checked after the await too: two requests can both read the
  // state before either starts, and the later one is busy, not a failed start.
  if (before.state === "preparing" || running.size > 0) return { error: "embedding-busy" };
  if (before.state === "ready") return { embedding: before };
  const controller = new AbortController();
  running.add(controller);
  const failed = (error: unknown) => log("embedding-prepare-failed", { error: errorClass(error) });
  try {
    embedder
      .prepare(source, controller.signal)
      .catch(failed)
      .finally(() => running.delete(controller));
  } catch (error) {
    running.delete(controller);
    failed(error);
  }
  return { embedding: await embeddingState(embedder) };
}

function createHandlers(options: ServerOptions, preparations: Set<AbortController>): Handlers {
  return {
    status: async () => ({
      backend: { state: "ready" },
      provider: { state: "not-implemented" },
      embedding: await embeddingState(options.embedder),
      vectorIndex: await vectorIndexState(options.vectorIndex),
    }),
    connectors: async () => ({ connectors: options.connectors.list() }),
    syncConnector: (input) => options.connectors.sync(input.connectorId),
    sources: async () => ({ sources: listSources(options.db) }),
    searchSources: async (input) => ({ sources: findSources(options.db, input.query) }),
    activity: async () => ({ calls: listProviderCalls(options.db) }),
    settings: async () => ({
      dataDirectory: options.dataDirectory,
      schemaVersion: schemaVersion(options.db),
      databaseEncryption: databaseEncryption(options.databaseFile),
    }),
    consents: async () => options.egress.overview(),
    grantConsent: async ({ providerId, allowedClasses, destination, policyVersion }) =>
      options.egress.grant(providerId, allowedClasses, { destination, policyVersion }),
    revokeConsent: async (input) => options.egress.revoke(input.providerId),
    prepareEmbedding: (input) => prepareEmbedding(options.embedder, input.source, preparations),
  };
}

/** The JSON body, or undefined when it is too large or not JSON. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

async function handle(
  handlers: Handlers,
  name: RouteName,
  req: IncomingMessage,
  res: ServerResponse,
) {
  const route = routes[name];
  let input: unknown;
  if ("request" in route) {
    const parsed = route.request.safeParse(await readJson(req));
    if (!parsed.success) return reject(res, 400, "bad-request");
    input = parsed.data;
  }
  const result = await (handlers[name] as (input: unknown) => Promise<unknown>)(input);
  if (typeof result === "object" && result !== null && "error" in result) {
    const { error } = result as ErrorResponse;
    return reject(res, errorStatus[error] ?? 500, error);
  }
  // Responses are checked against the shared schema before they leave.
  reply(res, 200, routes[name].response.parse(result));
}

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
  // Preparations still running when the server closes are aborted; an aborted one leaves no model.
  const preparations = new Set<AbortController>();
  const handlers = createHandlers(options, preparations);
  let selfHost = "";

  const server = createServer((req, res) => {
    // Node keeps only the first Host header, and an absolute-form URI names a host of its
    // own; both would let the Host check read something other than what is routed.
    const hostHeaders = req.rawHeaders.filter((name, i) => i % 2 === 0 && /^host$/i.test(name));
    if (hostHeaders.length > 1) return reject(res, 400, "bad-request");
    // A target starting with "//" would be parsed as naming its own authority too.
    if (!req.url?.startsWith("/") || req.url.startsWith("//")) {
      return reject(res, 400, "bad-request");
    }
    if (req.headers.host !== selfHost) return reject(res, 403, "forbidden-host");
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      return reject(res, 403, "forbidden-origin");
    }
    if (!tokenMatches(req.headers.authorization, token)) return reject(res, 401, "unauthorized");

    const match = matchRoute(routes, req.method, new URL(`http://_${req.url}`).pathname);
    if (typeof match !== "string") {
      return reject(res, match.error === "not-found" ? 404 : 405, match.error);
    }
    // Last resort: any handler failure answers a generic 500. The log names the route
    // and a known error class only; messages can carry content (ADR 0008, V01-R13).
    handle(handlers, match, req, res).catch((error: unknown) => {
      log("route-failed", { route: match, error: errorClass(error) });
      reject(res, 500, "internal-error");
    });
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
    close: () => {
      for (const controller of preparations) controller.abort();
      return new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    },
  };
}
