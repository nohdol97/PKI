// The worker thread inside the normalizer host (I02B-R22): bytes in, a result out. It is handed bytes,
// a name and a format, never a path, so it has no file to open (I02B-C18). The host owns the clock and
// the limits; this file only runs the I02-A normalizer.
import { parentPort } from "node:worker_threads";
import { normalizeDocument } from "./normalize.ts";
import type { WorkerJob, WorkerReply } from "./host-protocol.ts";

if (parentPort === null) throw new Error("isolated-worker is a worker file");
const port = parentPort;

port.on("message", (job: WorkerJob) => {
  void normalizeDocument(
    {
      kind: "bytes",
      bytes: job.bytes,
      name: job.name,
      ...(job.format === undefined ? {} : { format: job.format }),
    },
    job.limits === undefined ? {} : { limits: job.limits },
  ).then((result) => {
    const reply: WorkerReply = { type: "result", id: job.id, result };
    port.postMessage(reply);
  });
});
