// A local stand-in for an OpenAI-compatible endpoint (V01-T11 tests): loopback http,
// records every request it receives, and answers what the test scripts. No real
// API is ever called.
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeHttpRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface FakeHttpReply {
  status: number;
  headers?: Record<string, string>;
  /** Sent as-is when a string, otherwise as JSON. */
  body?: unknown;
}

export interface FakeOpenAIServer {
  /** `host:port`, the egress destination of this server. */
  host: string;
  /** `http://host:port/v1`, the base URL a Provider is configured with. */
  baseUrl: string;
  requests: FakeHttpRequest[];
  /** Requests to `.../chat/completions`: the model calls. */
  completions(): number;
  close(): Promise<void>;
}

/** A chat completion whose message content is `content`. */
export function completion(content: string): FakeHttpReply {
  return {
    status: 200,
    body: { choices: [{ index: 0, message: { role: "assistant", content } }] },
  };
}

/** Plain requests get "ok"; requests for a JSON Schema get `{"reply":"ok"}`. */
export function defaultReply(request: FakeHttpRequest): FakeHttpReply {
  const parsed = JSON.parse(request.body || "{}") as { response_format?: unknown };
  return completion(parsed.response_format ? JSON.stringify({ reply: "ok" }) : "ok");
}

export async function startFakeOpenAI(
  respond: (request: FakeHttpRequest) => FakeHttpReply | Promise<FakeHttpReply> = defaultReply,
): Promise<FakeOpenAIServer> {
  const requests: FakeHttpRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const request: FakeHttpRequest = {
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(request);
      void Promise.resolve(respond(request)).then((reply) => {
        const body = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {});
        res
          .writeHead(reply.status, { "content-type": "application/json", ...reply.headers })
          .end(body);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const host = `127.0.0.1:${port}`;
  return {
    host,
    baseUrl: `http://${host}/v1`,
    requests,
    completions: () => requests.filter((r) => r.path.endsWith("/chat/completions")).length,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
