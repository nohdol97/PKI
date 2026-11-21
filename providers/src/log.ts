// Log filtering (V01-R13, ADR 0010): a log line is one JSON object of an event
// code and fields that are numbers, booleans or code-shaped strings. Anything
// else becomes "[redacted]", so free text — which may be a CLI's or server's echo
// of documents, prompts or secrets — cannot reach a log. Errors are named by a
// known class only: neither the message nor a crafted `name` is repeated.
// Callers pass codes from closed sets; a code-shaped word of input would pass the
// shape check, so input never goes in as a field value in the first place.
export type LogValue = string | number | boolean;

const CODE = /^[A-Za-z][A-Za-z0-9]*(?:[-.:_][A-Za-z0-9]+)*$/;
const MAX_CODE = 64;
const REDACTED = "[redacted]";

const KNOWN_ERRORS = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "AbortError",
  "ZodError",
  "SqliteError",
  "ProviderError",
  "ProviderRateLimitError",
]);

const isCode = (text: string) => text.length <= MAX_CODE && CODE.test(text);

export function errorClass(error: unknown): string {
  return error instanceof Error && KNOWN_ERRORS.has(error.name) ? error.name : "other";
}

export type Logger = (event: string, fields?: Record<string, LogValue>) => void;

export function createLogger(sink: (line: string) => void): Logger {
  return (event, fields = {}) => {
    const line: Record<string, LogValue> = { event: isCode(event) ? event : REDACTED };
    for (const [key, value] of Object.entries(fields)) {
      if (!isCode(key) || key === "event") continue;
      line[key] =
        typeof value === "number" || typeof value === "boolean"
          ? value
          : typeof value === "string" && isCode(value)
            ? value
            : REDACTED;
    }
    sink(JSON.stringify(line));
  };
}

/** The backend's log: stderr, one filtered JSON line per event. */
export const log: Logger = createLogger((line) => console.error(line));
