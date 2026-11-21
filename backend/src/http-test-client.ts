// Raw HTTP client for backend tests: unlike fetch it lets a test send any Host
// header and omit or forge Origin, which the security checks must judge.
import { request } from "node:http";

export interface TestResponse {
  status: number;
  body: unknown;
}

export function send(
  port: number,
  path: string,
  headers: Record<string, string>,
  method = "GET",
  address = "127.0.0.1",
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: address, port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined });
      });
    });
    req.on("error", reject);
    req.end();
  });
}
