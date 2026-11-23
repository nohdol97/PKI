// The Ask screen's reader of `POST /api/ask` (X01-R10): the response is one JSON event per line. Each line is
// checked against the contract before the screen sees it; the abort signal is the cancel (closing the
// connection). A refusal before the first event (bad body, an error before any event) is an ordinary JSON
// error answer and becomes an ApiError. No error here carries a line's content (R15).
import {
  askRoute,
  AskEventSchema,
  ErrorResponseSchema,
  type AskEvent,
  type AskRequest,
} from "@pki/contracts";
import { ApiError, type ApiConnection } from "./api.ts";

export async function* readAskEvents(
  connection: ApiConnection,
  request: AskRequest,
  signal?: AbortSignal,
): AsyncGenerator<AskEvent> {
  const { fetchImpl } = connection; // not called as a method: the browser's fetch needs no `this` but this object
  const res = await fetchImpl(`${connection.baseUrl}${askRoute.path}`, {
    method: askRoute.method,
    headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" },
    body: JSON.stringify(request),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok || !res.body) {
    const parsed = ErrorResponseSchema.safeParse(await res.json().catch(() => undefined));
    throw new ApiError(parsed.success ? parsed.data.error : "internal-error", res.status);
  }
  const event = (line: string): AskEvent => {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      json = undefined; // the parser's message quotes the line
    }
    const parsed = AskEventSchema.safeParse(json);
    if (!parsed.success) throw new Error("ask: an event does not match the contract");
    return parsed.data;
  };
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      pending += value ?? "";
      const lines = pending.split("\n");
      pending = done ? "" : (lines.pop() ?? "");
      for (const line of lines) if (line !== "") yield event(line);
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
