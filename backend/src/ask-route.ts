// `POST /api/ask` (X01-R10, D5): the one route that answers a stream. The server's route table answers one JSON
// body per request and checks it against its schema, so this path is served here, after the server's own
// host, origin and token checks. Each event is one line of JSON, checked against the contract before it is
// written. The headers go out with the first event, so a failure before it (a registry that cannot judge,
// R12) is still an ordinary error answer. A client closing the connection is the cancel: the signal reaches
// the Broker call and nothing is written after it.
import { askRoute, AskEventSchema, AskRequestSchema } from "@pki/contracts";
import { errorClass, log } from "@pki/providers";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ask, type AskDeps } from "./ask.ts";

export type { AskDeps } from "./ask.ts";
export const ASK_PATH = askRoute.path;

const MAX_BODY_BYTES = 16 * 1024;

/** The JSON body, or undefined when it is not JSON or is over the limit. */
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

function fail(res: ServerResponse, status: number, error: string) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error }));
}

export function createAskRoute(deps: AskDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== askRoute.method) return fail(res, 405, "method-not-allowed");
    const parsed = AskRequestSchema.safeParse(await readJson(req));
    if (!parsed.success) return fail(res, 400, "bad-request");

    const cancel = new AbortController();
    res.once("close", () => {
      if (!res.writableFinished) cancel.abort();
    });
    const events = ask(deps, parsed.data, cancel.signal);
    try {
      let step = await events.next();
      if (!step.done) {
        res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
      }
      while (!step.done && !cancel.signal.aborted) {
        res.write(`${JSON.stringify(AskEventSchema.parse(step.value))}\n`);
        step = await events.next();
      }
    } catch (error) {
      // the class only: a message can carry the question or a title (R15)
      log("route-failed", { route: "ask", error: errorClass(error) });
      if (!res.headersSent) return fail(res, 500, "internal-error");
      return void res.destroy();
    } finally {
      await events.return(undefined);
    }
    res.end();
  };
}
