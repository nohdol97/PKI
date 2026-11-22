// A worker that normalizes with the network calls counted (I02B-C19, test code): the I02-A spies, put
// inside the worker thread. `net:calls` returns the count as the `detail` of a failure result, and
// `net:probe` makes one real-looking call first (the positive control: the spies do catch it).
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { parentPort } from "node:worker_threads";
import { normalizeDocument } from "../normalize.ts";
import type { WorkerJob, WorkerReply } from "../host-protocol.ts";

if (parentPort === null) throw new Error("net-watch-worker is a worker file");
const port = parentPort;
let calls = 0;
const count = () => {
  calls++;
  throw new Error("blocked");
};
const watched: [object, string][] = [
  [http, "request"],
  [http, "get"],
  [https, "request"],
  [https, "get"],
  [net, "connect"],
  [net, "createConnection"],
  [tls, "connect"],
  [dns, "lookup"],
];
for (const [target, name] of watched) (target as Record<string, unknown>)[name] = count;
globalThis.fetch = (() => {
  calls++;
  return Promise.reject(new Error("blocked"));
}) as typeof fetch;

const reply = (id: number, result: WorkerReply["result"]) =>
  port.postMessage({ type: "result", id, result } satisfies WorkerReply);

port.on("message", (job: WorkerJob) => {
  if (job.name === "net:probe") {
    try {
      http.get("http://example.invalid/");
    } catch {
      // counted
    }
  }
  if (job.name === "net:calls" || job.name === "net:probe") {
    return reply(job.id, {
      ok: false,
      error: { code: "corrupt", message: "network calls", detail: { calls } },
    });
  }
  void normalizeDocument({
    kind: "bytes",
    bytes: job.bytes,
    name: job.name,
    ...(job.format === undefined ? {} : { format: job.format }),
  }).then((result) => reply(job.id, result));
});
