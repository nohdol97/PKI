// Raw HTTP clients for backend tests: unlike fetch they let a test send any Host
// header, omit or forge Origin, and write malformed requests the server must judge.
import { request } from "node:http";
import { connect } from "node:net";

export interface TestResponse {
  status: number;
  body: unknown;
}

export function send(
  port: number,
  path: string,
  headers: Record<string, string>,
  method = "GET",
  /** Sent as-is when a string, otherwise as JSON. */
  body?: unknown,
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined });
      });
    });
    req.on("error", reject);
    req.end(body === undefined || typeof body === "string" ? body : JSON.stringify(body));
  });
}

/** Writes `lines` verbatim (CRLF-joined) and returns the response status code. */
export function sendRaw(port: number, lines: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.end(`${lines.join("\r\n")}\r\n\r\n`);
    });
    let head = "";
    socket.on("data", (chunk: Buffer) => (head += chunk.toString("latin1")));
    socket.on("end", () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0)));
    socket.on("error", reject);
  });
}
