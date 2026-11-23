// X01-R10, R11: the Ask screen's stream reader. One JSON event per line, checked against the contract; a line
// split across chunks (and a Korean character split across bytes) still reads as one event; a refusal before
// the first event is an ordinary API error; an abort reaches fetch (the cancel is closing the connection).
import { askRoute, type AskEvent } from "@pki/contracts";
import { describe, expect, it } from "vitest";
import { ApiError, connectionOf, createApiClient } from "./api.ts";
import { readAskEvents } from "./ask-stream.ts";

const session = { baseUrl: "http://127.0.0.1:1", token: "t".repeat(43) };
const request = { question: "배포일", answer: true } as const;

const events: AskEvent[] = [
  { type: "route", route: { keyword: { status: "used" }, vector: { status: "off" } } },
  { type: "answer", status: "none", reason: "not-requested" },
  { type: "done", sentences: 0, dropped: 0, insufficient: false },
];

/** A fetch answering with `bytes` cut at the given offsets. */
function fetchOf(bytes: Uint8Array, cuts: number[], init: { status: number; type: string }) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchImpl = ((url: string, requestInit: RequestInit) => {
    seen.push({ url, init: requestInit });
    const parts = [0, ...cuts, bytes.length].flatMap((at, i, all) =>
      i === 0 ? [] : [bytes.slice(all[i - 1], at)],
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    });
    return Promise.resolve(
      new Response(body, { status: init.status, headers: { "content-type": init.type } }),
    );
  }) as typeof fetch;
  return { fetchImpl, seen };
}
const ndjson = (lines: unknown[]) =>
  new TextEncoder().encode(lines.map((l) => `${JSON.stringify(l)}\n`).join(""));

const collect = async (stream: AsyncIterable<AskEvent>) => {
  const out: AskEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
};

describe("ask-stream: reading the events", () => {
  it("posts the request with the token and yields each event, whatever the chunk boundaries", async () => {
    const bytes = ndjson(events);
    const { fetchImpl, seen } = fetchOf(bytes, [7, 8, 40, 41, 42, bytes.length - 3], {
      status: 200,
      type: "application/x-ndjson",
    });
    const connection = connectionOf(createApiClient(session, fetchImpl));
    expect(connection).toBeDefined();

    const read = await collect(
      readAskEvents(connection as NonNullable<typeof connection>, request),
    );

    expect(read).toEqual(events);
    expect(seen[0]?.url).toBe(`${session.baseUrl}${askRoute.path}`);
    expect(seen[0]?.init.method).toBe("POST");
    expect(seen[0]?.init.headers).toMatchObject({ authorization: `Bearer ${session.token}` });
    expect(JSON.parse(seen[0]?.init.body as string)).toEqual(request);
  });

  it("refuses a line that is not an event of the contract, naming no content", async () => {
    const { fetchImpl } = fetchOf(ndjson([{ type: "nonsense", text: "비밀 질문" }]), [], {
      status: 200,
      type: "application/x-ndjson",
    });
    const connection = connectionOf(createApiClient(session, fetchImpl));

    const failure = await collect(
      readAskEvents(connection as NonNullable<typeof connection>, request),
    ).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("비밀");
  });

  it("turns a refusal before the first event into an ApiError", async () => {
    const { fetchImpl } = fetchOf(
      new TextEncoder().encode(JSON.stringify({ error: "bad-request" })),
      [],
      {
        status: 400,
        type: "application/json",
      },
    );
    const connection = connectionOf(createApiClient(session, fetchImpl));

    const failure = await collect(
      readAskEvents(connection as NonNullable<typeof connection>, request),
    ).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 400, code: "bad-request" });
  });

  it("hands the abort signal to fetch, so closing the screen's request closes the connection", async () => {
    const { fetchImpl, seen } = fetchOf(ndjson(events), [], {
      status: 200,
      type: "application/x-ndjson",
    });
    const connection = connectionOf(createApiClient(session, fetchImpl));
    const controller = new AbortController();

    await collect(
      readAskEvents(connection as NonNullable<typeof connection>, request, controller.signal),
    );

    expect(seen[0]?.init.signal).toBe(controller.signal);
  });
});
